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
 * Maps the SDK's stream parts onto ours, dropping the ones we do not act on. Written against the
 * SDK's own union, so a renamed field fails to compile rather than silently yielding nothing.
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

/** Stop conditions for the tools that park the turn instead of running. */
function interactionStops() {
  return Object.values(registry)
    .filter((tool) => tool.interaction)
    .map((tool) => hasToolCall(tool.name));
}

/**
 * Builds the loop's `startStream`: provider, tool set, stop conditions and part mapping. `onRequest`
 * fires once per model request, including the tool rounds the SDK makes inside one call.
 *
 * INVARIANT: reasoning is requested at the model. `streamText`'s top-level `reasoning` option is
 * silently ignored by this provider, and the Thinking row then stays empty forever.
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
