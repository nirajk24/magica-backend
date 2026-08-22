import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { hasToolCall, stepCountIs, streamText, type TextStreamPart, type ToolSet } from "ai";
import type { ContentBlock } from "@/contracts";
import { env } from "@/lib/env";
import type { Logger } from "@/lib/logger";
import { registry } from "@/tools/registry";
import { toAiSdkTools, type ToolRuntime, type TurnContext } from "@/tools/to-ai-sdk";
import { toModelMessages, type HistoryMessage, type TurnResolution } from "@/prompts/system";
import type { AgentTurnDeps, TurnStream, TurnStreamPart } from "@/agent/run-agent-turn";

/**
 * The only place the AI SDK's stream vocabulary is read. Written against the SDK's own union so a
 * renamed field fails to compile here rather than silently yielding nothing — `text-delta` carrying
 * `.text` and `tool-call` carrying `.input` are both v7 names that differ from v5.
 *
 * Parts we do not act on are dropped: the SDK emits start/finish/step and streaming tool-input
 * events we have no use for, and the final `tool-call` already carries the complete input.
 */
export function toTurnStreamPart(part: TextStreamPart<ToolSet>): TurnStreamPart | null {
  switch (part.type) {
    case "text-delta":
      return { type: "text-delta", text: part.text };
    case "reasoning-delta":
      return { type: "reasoning-delta", text: part.text };
    case "reasoning-end":
      return { type: "reasoning-end" };
    case "tool-call":
      return {
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      };
    case "error":
      return { type: "error", error: part.error };
    default:
      return null;
  }
}

async function* mapParts(
  stream: AsyncIterable<TextStreamPart<ToolSet>>,
): AsyncIterable<TurnStreamPart> {
  for await (const part of stream) {
    const mapped = toTurnStreamPart(part);
    if (mapped !== null) yield mapped;
  }
}

/**
 * Every tool that parks the turn instead of running. Derived from the registry, so declaring a new
 * interaction kind needs no edit here.
 */
function interactionStops() {
  return Object.values(registry)
    .filter((tool) => tool.interaction)
    .map((tool) => hasToolCall(tool.name));
}

/**
 * Builds the loop's `startStream` dependency: the provider, the tool set, the stop conditions and
 * the part mapping, so the loop itself never names a provider or an SDK type.
 *
 * `onRequest` fires once per model request, including the tool rounds the SDK makes inside a single
 * call. Those are invisible to the loop, so this is the only place the day's request spend can be
 * counted at all.
 *
 * INVARIANT: reasoning is requested at the MODEL, via `.chat(id, { reasoning })`. `streamText` has a
 * top-level `reasoning` option that this provider never reads — passing it there yields no thinking
 * tokens and no error, and the Thinking row stays empty forever.
 *
 * INVARIANT: `.chat(id)`, never `openrouter(id)`. The first declared overload returns a completion
 * model, so the callable form infers the wrong class for every chat model.
 */
export function createStreamStarter(a: {
  turn: TurnContext;
  runtime: ToolRuntime;
  onRequest: () => void;
  log: Logger;
}): AgentTurnDeps["startStream"] {
  const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });
  const tools = toAiSdkTools(registry, a.turn, a.runtime);
  const stopWhen = [stepCountIs(env.MAX_STEPS), ...interactionStops()];

  return ({ modelId, history, blocks, resolutions }): TurnStream => {
    const messages = toModelMessages({
      // Opaque to the loop by design: it carries these between `bootstrap`, `recordResolution` and
      // here without inspecting them, so this is the one place their shape is known.
      history: history as HistoryMessage[],
      blocks: blocks as ContentBlock[],
      resolutions: resolutions as TurnResolution[],
    });

    const result = streamText({
      model: openrouter.chat(modelId, { reasoning: { enabled: true, effort: "medium" } }),
      messages,
      tools,
      stopWhen,
      onStepFinish: () => a.onRequest(),
      onError: ({ error }) => a.log.error({ err: error }, "stream error"),
    });

    return {
      parts: mapParts(result.fullStream),
      usage: result.totalUsage,
    };
  };
}
