import type { ContentBlock, RunMetadata, WaitpointResolution } from "@/contracts";
import { env } from "@/lib/env";
import { AppError, ToolError } from "@/lib/errors";
import type { Logger } from "@/lib/logger";
import { getTool } from "@/tools/registry";
import { createTurnState } from "@/agent/turn-state";

/** The stream parts the loop acts on. The adapter maps the SDK's larger union onto this. */
export type TurnStreamPart =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "reasoning-end" }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "finish"; finishReason: string }
  | { type: "error"; error: unknown };

export type TurnUsage = { inputTokens?: number; outputTokens?: number };

export type TurnStream = {
  parts: AsyncIterable<TurnStreamPart>;
  /** `PromiseLike` because that is what the SDK hands back; the loop only ever awaits it. */
  usage: PromiseLike<TurnUsage>;
  /**
   * The model that actually answered, which is not necessarily the one requested: the default is a
   * router that picks an available free model per request.
   */
  servedModel: PromiseLike<string | undefined>;
};

export type PendingInteraction = {
  toolUseId: string;
  toolName: string;
  input: unknown;
};

export type AgentTurnDeps = {
  bootstrap: (runId: string) => Promise<{
    modelId: string;
    assistantMessageId: string;
    history: unknown[];
  }>;
  startStream: (a: {
    modelId: string;
    history: unknown[];
    blocks: ContentBlock[];
    resolutions: unknown[];
  }) => TurnStream | Promise<TurnStream>;
  appendText: (delta: string) => Promise<void>;
  setMetadata: (patch: Partial<RunMetadata>) => Promise<void>;
  flushMetadata: () => Promise<void>;
  persistBlocks: (a: { blocks: ContentBlock[]; reasoningText?: string }) => Promise<void>;
  suspendOn: (interaction: PendingInteraction) => Promise<WaitpointResolution>;
  /** Returns the record replayed to the model as that tool's result next request. */
  recordResolution: (a: {
    interaction: PendingInteraction;
    resolution: WaitpointResolution;
  }) => Promise<unknown>;
  finalize: (a: {
    blocks: ContentBlock[];
    tokenUsage: { inputTokens: number; outputTokens: number } | null;
    servedModel: string | null;
  }) => Promise<void>;
  finalizeFailed: (a: { reason: string; blocks: ContentBlock[] }) => Promise<void>;
  now: () => number;
  log: Logger;
};

export type AgentTurnResult = {
  status: "completed" | "failed";
  turns: number;
  segments: number;
  reason?: string;
};

/** All-or-nothing: `?? 0` would render "0 tokens", a wrong number rather than a missing one. */
function normalizeUsage(usage: TurnUsage) {
  return usage.inputTokens !== undefined && usage.outputTokens !== undefined
    ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
    : null;
}

/**
 * Both loop bounds strand the same thing — work the model had started and cannot now finish — so
 * they read as one failure to a user, whichever of the two fired.
 */
const STEP_LIMIT_REASON = "This turn reached its step limit before finishing.";

/** Only our own error types carry copy safe to show a user. */
function safeReason(error: unknown): string {
  if (error instanceof AppError || error instanceof ToolError) return error.message;
  return "The assistant could not finish this turn.";
}

/**
 * One assistant turn: stream the model, accumulate blocks, park on an interaction if the model asks
 * for one, finalize once. Every dependency is injected, so the control flow is testable with fakes.
 *
 * INVARIANT: exactly one of `finalize`/`finalizeFailed` runs on every path — both refund the
 * admission hold.
 * INVARIANT: nothing throws out of here. Trigger.dev reports an uncaught throw with no message.
 */
export async function runAgentTurn(
  deps: AgentTurnDeps,
  { runId }: { runId: string },
): Promise<AgentTurnResult> {
  const state = createTurnState();
  let turns = 0;
  let servedModel: string | undefined;

  try {
    const { modelId, assistantMessageId, history } = await deps.bootstrap(runId);

    await deps.setMetadata({
      phase: "thinking",
      phaseStartedAt: deps.now(),
      assistantMessageId,
      stepsCompleted: 0,
      blocks: [],
      invocations: [],
    });

    let retriedEmptyStream = false;
    let completed = false;
    const resolutions: unknown[] = [];

    while (turns < env.MAX_TURNS) {
      turns++;

      const stream = await deps.startStream({
        modelId,
        history,
        blocks: state.blocks(),
        resolutions,
      });

      let pending: PendingInteraction | null = null;
      let produced = false;
      let finishReason: string | undefined;

      for await (const part of stream.parts) {
        switch (part.type) {
          case "text-delta": {
            await deps.appendText(part.text);

            // The stream needs a row to render into, and only a block opening adds one. Without
            // this the answer stays invisible until the next structural update, then appears whole.
            if (state.appendText(part.text)) {
              await deps.setMetadata({ blocks: state.projection() });
            }

            produced = true;
            break;
          }

          case "reasoning-delta": {
            state.appendReasoning(part.text, deps.now());
            // `blocks` travels with the text: the open reasoning block only exists in the
            // projection, so sending the tail without it leaves the client nothing to render into.
            await deps.setMetadata({
              reasoningText: state.reasoningTail(),
              blocks: state.projection(),
            });
            produced = true;
            break;
          }

          case "reasoning-end": {
            if (state.closeReasoning(deps.now())) {
              await deps.persistBlocks({ blocks: state.blocks() });
              await deps.setMetadata({ blocks: state.projection() });
            }
            break;
          }

          case "tool-call": {
            const tool = getTool(part.toolName);

            state.pushToolUse({
              id: part.toolCallId,
              name: part.toolName,
              input: part.input,
            });
            produced = true;

            await deps.persistBlocks({ blocks: state.blocks() });
            await deps.setMetadata({
              phase: "working",
              phaseStartedAt: deps.now(),
              currentStep: tool?.display.label,
              blocks: state.projection(),
              stepsCompleted: state.segments(),
            });

            if (tool?.interaction) {
              pending = {
                toolUseId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
              };
            }
            break;
          }

          case "finish":
            finishReason = part.finishReason;
            break;

          case "error":
            // A mid-stream failure arrives as a part, not a rejection. The adapter has already
            // turned it into user-safe copy, so it is rethrown rather than replaced.
            deps.log.error({ err: part.error, runId }, "model stream errored");
            throw part.error instanceof AppError
              ? part.error
              : new AppError("INTERNAL", "The model stopped responding partway through.");
        }
      }

      const tokenUsage = normalizeUsage(await stream.usage);
      // Overwritten each round, so the recorded model is the one that produced the final answer.
      servedModel = (await stream.servedModel) ?? servedModel;

      if (!produced) {
        if (!retriedEmptyStream) {
          retriedEmptyStream = true;
          deps.log.warn({ runId, turns }, "empty model stream, retrying once");
          continue;
        }

        await deps.finalizeFailed({
          reason: "The model returned an empty response.",
          blocks: state.blocks(),
        });
        return { status: "failed", turns, segments: state.segments(), reason: "empty response" };
      }

      if (pending) {
        state.closeText();

        await deps.setMetadata({ phase: "waiting", phaseStartedAt: deps.now() });

        // Metadata writes are batched: unflushed, a client reloading mid-wait sees no approval card.
        await deps.flushMetadata();

        const resolution = await deps.suspendOn(pending);

        resolutions.push(await deps.recordResolution({ interaction: pending, resolution }));
        state.breakSegment();
        await deps.flushMetadata();
        continue;
      }

      // `tool-calls` here means the SDK's own loop stopped while the model still wanted to call a
      // tool, which past the interaction check above can only be `MAX_STEPS`. It reads exactly like
      // a natural finish, so finalizing on it reports success for a turn that was cut off — the
      // symptom being a plan step left `in_progress` that renders as a step which never ends.
      if (finishReason === "tool-calls") {
        deps.log.warn({ runId, turns }, "the step limit cut the tool loop short");
        state.closeText();

        await deps.finalizeFailed({ reason: STEP_LIMIT_REASON, blocks: state.blocks() });

        return { status: "failed", turns, segments: state.segments(), reason: "step limit reached" };
      }

      state.closeText();

      if (tokenUsage) state.pushUsage(tokenUsage);

      await deps.setMetadata({
        phase: "finalizing",
        phaseStartedAt: deps.now(),
        blocks: state.projection(),
        tokenUsage: tokenUsage ?? undefined,
      });

      await deps.finalize({ blocks: state.blocks(), tokenUsage, servedModel: servedModel ?? null });
      completed = true;
      break;
    }

    if (!completed) {
      await deps.finalizeFailed({ reason: STEP_LIMIT_REASON, blocks: state.blocks() });
      return { status: "failed", turns, segments: state.segments(), reason: "turn limit reached" };
    }

    return { status: "completed", turns, segments: state.segments() };
  } catch (error) {
    deps.log.error({ err: error, runId, turns }, "agent turn failed");
    state.closeText();
    await deps.finalizeFailed({ reason: safeReason(error), blocks: state.blocks() });

    return { status: "failed", turns, segments: state.segments(), reason: safeReason(error) };
  }
}
