import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { hasToolCall, stepCountIs, streamText, type TextStreamPart, type ToolSet } from "ai";
import type { ContentBlock } from "@/contracts";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import type { Logger } from "@/lib/logger";
import { registry } from "@/tools/registry";
import { toAiSdkTools, type ToolRuntime, type TurnContext } from "@/tools/to-ai-sdk";
import { buildSystemPrompt, toModelMessages, type HistoryMessage, type TurnResolution } from "@/prompts/system";
import type { AgentTurnDeps, TurnStream, TurnStreamPart } from "@/agent/run-agent-turn";

/**
 * Turns a provider failure into copy the user can act on. A rate-limited free model is the common
 * case and reads nothing like a crash, so it must not share the generic message.
 *
 * Read structurally rather than with `instanceof`: the provider bundles its own copy of
 * `@ai-sdk/provider-utils`, so the error class it throws is not the one this package compares against.
 */
export function describeStreamError(error: unknown): AppError {
  const api = error as
    | { statusCode?: number; isRetryable?: boolean; responseHeaders?: Record<string, string> }
    | null;

  if (api?.statusCode === 429) {
    const header = api.responseHeaders?.["retry-after"];
    const retryAfter = header && /^\d+$/.test(header) ? Number(header) : undefined;

    return new AppError(
      "RATE_LIMITED",
      "The model is busy right now. Try again in a moment.",
      undefined,
      retryAfter,
    );
  }
  if (api?.statusCode === 401 || api?.statusCode === 403) {
    return new AppError("FORBIDDEN", "The model provider rejected this request.");
  }
  if (api?.isRetryable === true) {
    return new AppError("INTERNAL", "The model is temporarily unavailable. Try again in a moment.");
  }

  return new AppError("INTERNAL", "The model stopped responding partway through.");
}

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
      return { type: "error", error: describeStreamError(part.error) };
    default:
      return null;
  }
}

async function* mapParts(
  stream: AsyncIterable<TextStreamPart<ToolSet>>,
  onRateLimited: (error: AppError) => void,
): AsyncIterable<TurnStreamPart> {
  for await (const part of stream) {
    const mapped = toTurnStreamPart(part);
    if (mapped === null) continue;

    // `instanceof` is safe here, unlike for provider errors: this one was constructed by
    // `describeStreamError` in this module.
    if (mapped.type === "error" && mapped.error instanceof AppError) onRateLimited(mapped.error);

    yield mapped;
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
  planMode: boolean;
  runtime: ToolRuntime;
  onRequest: () => void;
  onRateLimited: (a: { modelId: string; retryAfterSeconds?: number }) => Promise<void>;
  log: Logger;
}): AgentTurnDeps["startStream"] {
  const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });
  const tools = toAiSdkTools(registry, a.turn, a.runtime);
  const stopWhen = [stepCountIs(env.MAX_STEPS), ...interactionStops()];

  return ({ modelId, history, blocks, resolutions }): TurnStream => {
    // Status is telemetry, so a write that fails must not take down a turn that is otherwise fine.
    // Both arrival paths call this and the write is an idempotent upsert, so firing twice is safe.
    const noteRateLimit = (described: AppError) => {
      if (described.code !== "RATE_LIMITED") return;

      void a
        .onRateLimited({ modelId, retryAfterSeconds: described.retryAfterSeconds })
        .catch((error: unknown) => a.log.warn({ err: error }, "could not record the rate limit"));
    };

    const messages = toModelMessages({
      // Opaque to the loop by design: it carries these between `bootstrap`, `recordResolution` and
      // here without inspecting them, so this is the one place their shape is known.
      history: history as HistoryMessage[],
      blocks: blocks as ContentBlock[],
      resolutions: resolutions as TurnResolution[],
    });

    const result = streamText({
      model: openrouter.chat(modelId, { reasoning: { enabled: true, effort: "medium" } }),
      // Not a `system` message inside `messages`: the SDK rejects that outright.
      instructions: buildSystemPrompt({ planMode: a.planMode }),
      messages,
      tools,
      stopWhen,
      onStepFinish: () => a.onRequest(),
      onError: ({ error }) => {
        a.log.error({ err: error }, "stream error");
        noteRateLimit(describeStreamError(error));
      },
    });

    return {
      parts: mapParts(result.fullStream, noteRateLimit),
      usage: result.totalUsage,
      // The router resolves to a different id than the one requested, and only the response knows it.
      // `PromiseLike` has no `.catch`, and a failed turn never awaits this, so it is wrapped.
      servedModel: Promise.resolve(result.response).then(
        (response) => response.modelId,
        () => undefined,
      ),
    };
  };
}
