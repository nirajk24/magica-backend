import { metadata, task, wait } from "@trigger.dev/sdk";
import type { WaitpointResolution } from "@/contracts";
import { db } from "@/lib/db";
import { recordRateLimit } from "@/lib/llm-status";
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
 * One assistant turn, end to end: the only place `runAgentTurn`'s seams are bound to real
 * implementations. `maxAttempts: 1` because retries are manual — an automatic one would replay
 * narrative the user has already seen.
 */
export const agentTurn = task({
  id: "agent-turn",
  retry: { maxAttempts: 1 },
  maxDuration: 900,
  run: async ({ runId }: AgentTurnPayload, { ctx }): Promise<AgentTurnResult> => {
    const log = bindContext(logger, { runId, processId: ctx.run.id });

    // Priced from the live catalog before the first estimate; on failure the committed table stands.
    await ensureCatalogPricing();

    const turn = await loadTurn(runId, ctx.run.id);
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
          onRateLimited: recordRateLimit,
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
         * Owns the whole waitpoint lifecycle: mint, persist, park, close out.
         *
         * INVARIANT: `kind` comes from the tool's `interaction`, never a literal — adding a
         * waitpoint kind must stay a registry entry.
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

        /** What the model is told the interaction returned; `suspendOn` did the persistence. */
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
