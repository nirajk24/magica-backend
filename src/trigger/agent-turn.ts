import { metadata, task, wait } from "@trigger.dev/sdk";
import type { WaitpointResolution } from "@/contracts";
import { db } from "@/lib/db";
import { bindContext, logger } from "@/lib/logger";
import { getTool } from "@/tools/registry";
import { ensureCatalogPricing } from "@/tools/pricing";
import { completeTurn, failTurn, loadTurn, persistTurnBlocks } from "@/services/turn.service";
import { createStreamStarter } from "@/agent/llm";
import { runAgentTurn, type AgentTurnResult } from "@/agent/run-agent-turn";
import { agentText } from "@/trigger/streams";
import { createToolRuntime } from "@/agent/tool-runtime";

export type AgentTurnPayload = { runId: string };

const WAITPOINT_TIMEOUT = "15m";

/**
 * One assistant turn, end to end. This is the only place the injected seams of `runAgentTurn` are
 * bound to their real implementations — Trigger.dev metadata and streams, Postgres through
 * `turn.service`, and OpenRouter through `llm`.
 *
 * `maxAttempts: 1` because retries are manual (decision #20): an automatic one would replay
 * narrative the user has already seen and regenerate tool ids that no longer match persisted rows.
 */
export const agentTurn = task({
  id: "agent-turn",
  retry: { maxAttempts: 1 },
  maxDuration: 900,
  run: async ({ runId }: AgentTurnPayload): Promise<AgentTurnResult> => {
    const log = bindContext(logger, { runId });

    // Awaited before the first estimate so tools are priced from the live catalog rather than the
    // committed fallback. A failure here is not an error; the fallback stands.
    await ensureCatalogPricing();

    const turn = await loadTurn(runId);
    const turnLog = bindContext(log, {
      chatId: turn.chatId,
      messageId: turn.assistantMessageId,
    });

    let requests = 0;

    const runtime = createToolRuntime({
      turn: { userId: turn.userId, chatId: turn.chatId, runId },
      publish: (invocations) => {
        metadata.set("invocations", invocations);
        return Promise.resolve();
      },
      log: turnLog,
    });

    const result = await runAgentTurn(
      {
        bootstrap: () =>
          Promise.resolve({
            modelId: turn.modelId,
            assistantMessageId: turn.assistantMessageId,
            history: turn.history,
          }),

        startStream: createStreamStarter({
          turn: { userId: turn.userId, chatId: turn.chatId, runId },
          runtime,
          onRequest: () => {
            requests++;
          },
          log: turnLog,
        }),

        appendText: (delta) => agentText.append(delta),

        setMetadata: (patch) => {
          for (const [key, value] of Object.entries(patch)) {
            metadata.set(key, value as never);
          }
          return Promise.resolve();
        },

        flushMetadata: () => metadata.flush(),

        persistBlocks: ({ blocks }) =>
          persistTurnBlocks({ messageId: turn.assistantMessageId, blocks }),

        /**
         * Owns the whole waitpoint lifecycle: mint the token, persist the row a reloading client
         * reads, park with zero compute, then close the row out. Keeping it in one place is why no
         * token id has to be carried between seams.
         *
         * INVARIANT: `kind` comes from the tool's own `interaction`, never a literal. Adding a
         * waitpoint kind is a registry entry, and hardcoding one here would undo that.
         */
        suspendOn: async (interaction) => {
          const kind = getTool(interaction.toolName)?.interaction;
          if (!kind) throw new Error(`${interaction.toolName} is not an interaction tool`);

          const token = await wait.createToken({
            timeout: WAITPOINT_TIMEOUT,
            idempotencyKey: `wp-${interaction.toolUseId}`,
          });

          const waitpoint = { id: token.id, kind, payload: interaction.input as never };

          await db.waitpoint.create({ data: { ...waitpoint, runId } });
          metadata.set("waitpoint", waitpoint);
          await metadata.flush();

          const outcome = await wait.forToken<WaitpointResolution>(token);
          const resolution: WaitpointResolution = outcome.ok ? outcome.output : { expired: true };

          await db.waitpoint.update({
            where: { id: token.id },
            data: {
              status: outcome.ok ? "completed" : "expired",
              resolution: resolution as never,
            },
          });

          metadata.del("waitpoint");

          return resolution;
        },

        /** What the model is told the interaction returned. No persistence — `suspendOn` did that. */
        recordResolution: ({ interaction, resolution }) =>
          Promise.resolve({
            toolUseId: interaction.toolUseId,
            toolName: interaction.toolName,
            output: resolution,
          }),

        finalize: ({ blocks, tokenUsage }) =>
          completeTurn({
            runId,
            userId: turn.userId,
            messageId: turn.assistantMessageId,
            blocks,
            tokenUsage,
          }),

        finalizeFailed: ({ reason, blocks }) =>
          failTurn({
            runId,
            userId: turn.userId,
            messageId: turn.assistantMessageId,
            blocks,
            reason,
          }),

        now: Date.now,
        log: turnLog,
      },
      { runId },
    );

    turnLog.info(
      { ...result, requests },
      "turn finished — `requests` is the OpenRouter spend for this turn",
    );

    return result;
  },
});
