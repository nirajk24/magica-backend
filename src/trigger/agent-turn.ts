import { metadata, task, wait } from "@trigger.dev/sdk";
import type { ActivePlan, WaitpointResolution } from "@/contracts";
import { getBalance } from "@/lib/credits";
import { recordRateLimit } from "@/lib/llm-status";
import { recordRequestUsage } from "@/lib/rate-limit";
import { loadSkillRegistry } from "@/lib/skills/load";
import { bindContext, logger } from "@/lib/logger";
import { getTool } from "@/tools/registry";
import { ensureCatalogPricing } from "@/tools/pricing";
import {
  completeTurn,
  failTurn,
  loadTurn,
  markTurnRunning,
  markTurnWaiting,
  persistTurnBlocks,
  recordExecutionMode,
  writeActivePlan,
  type PlanCloseOut,
} from "@/services/turn.service";
import { closeWaitpoint, openWaitpoint } from "@/services/waitpoint.service";
import { buildInteractionOutcome } from "@/agent/interaction";
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

    // Scanned here rather than at import: a malformed skill must fail loudly, but failing at module
    // scope would break the task *build* with a message naming nothing relevant. This fails the turn
    // instead, with the offending directory in the error.
    loadSkillRegistry();

    const turn = await loadTurn(runId, ctx.run.id);
    const turnLog = bindContext(log, {
      chatId: turn.chatId,
      messageId: turn.assistantMessageId,
    });

    let requests = 0;

    const runtime = createToolRuntime({
      turn: { userId: turn.userId, chatId: turn.chatId, runId },
      // Flushed, not just set: a tool card set immediately before `triggerAndWait` suspends the
      // machine would otherwise wait on the background flush and never reach the client.
      publish: async (invocations) => {
        metadata.set("invocations", invocations);
        await metadata.flush();
      },
      publishPlan: (plan) => {
        if (plan === undefined) metadata.del("activePlan");
        else metadata.set("activePlan", plan as never);
        return Promise.resolve();
      },
      log: turnLog,
    });

    /**
     * Mirrors what the terminal write did to the plan onto the live card, so a client still on the
     * run's last frame sees the same thing a reloading one reads off the chat row. Flushed because
     * nothing follows it: the run ends, and an unflushed write leaves the card as it was.
     */
    const publishPlanCloseOut = async (closeOut: PlanCloseOut | null) => {
      if (closeOut === null) return;

      if (closeOut.action === "cleared") metadata.del("activePlan");
      else metadata.set("activePlan", closeOut.plan as never);

      await metadata.flush();
    };

    /** The run-level effects a resolved interaction may apply; the tool decides, this persists. */
    const resolutionFx = {
      setExecutionMode: (mode: "auto" | "step_by_step") => recordExecutionMode(runId, mode),
      setActivePlan: async (plan: ActivePlan | null) => {
        await writeActivePlan(turn.chatId, plan);
        if (plan === null) metadata.del("activePlan");
        else metadata.set("activePlan", plan as never);
      },
    };

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
          planMode: turn.planMode,
          activePlan: turn.activePlan,
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
         * Owns the whole waitpoint lifecycle: price, record, mint, park, close out.
         *
         * INVARIANT: `kind` and the payload both come from the tool's own registry entry, never
         * from a literal — adding a waitpoint kind must stay a registry entry.
         * INVARIANT: the interaction gets a `ToolInvocation` row like any other step, so the card
         * carries a duration and an outcome and survives the run it was created in.
         */
        suspendOn: async (interaction) => {
          const tool = getTool(interaction.toolName);
          const kind = tool?.interaction;
          if (!tool || !kind) {
            throw new Error(`${interaction.toolName} is not an interaction tool`);
          }

          // Before any row or token exists: a plan priced beyond the balance stops the turn here,
          // leaving no card for work that was never going to run.
          const outcome = buildInteractionOutcome({
            tool,
            input: interaction.input,
            balance: await getBalance(turn.userId),
          });

          const startedAt = Date.now();
          const invocationId = await runtime.beginInvocation({
            toolUseId: interaction.toolUseId,
            toolName: interaction.toolName,
            // What the user is shown, which for a plan is the priced version rather than the
            // model's raw tool calls.
            input: "payload" in outcome ? outcome.payload : interaction.input,
          });

          const settle = async (raw: unknown): Promise<WaitpointResolution> => {
            const resolution = tool.output.parse(raw) as WaitpointResolution;

            await runtime.completeInvocation({
              invocationId,
              output: resolution,
              durationMs: Date.now() - startedAt,
              actualCost: null,
            });

            await tool.applyResolution?.(
              {
                resolution,
                payload: "payload" in outcome ? outcome.payload : interaction.input,
              },
              resolutionFx,
            );

            return resolution;
          };

          // The tool answered itself, so there is nothing to wait for.
          if ("resolution" in outcome) return settle(outcome.resolution);

          const token = await wait.createToken({
            timeout: WAITPOINT_TIMEOUT,
            idempotencyKey: `wp-${invocationId}`,
          });

          const waitpoint = { id: token.id, kind, payload: outcome.payload as never };

          await openWaitpoint({ ...waitpoint, runId, invocationId });
          await markTurnWaiting(runId);

          metadata.set("waitpoint", waitpoint);
          await metadata.flush();

          const answered = await wait.forToken<WaitpointResolution>(token);
          const resolution: WaitpointResolution = answered.ok ? answered.output : { expired: true };

          await closeWaitpoint({
            id: token.id,
            status: answered.ok ? "completed" : "expired",
            resolution,
          });
          await markTurnRunning(runId);

          metadata.del("waitpoint");

          return settle(resolution);
        },

        /** What the model is told the interaction returned; `suspendOn` did the persistence. */
        recordResolution: ({ interaction, resolution }) =>
          Promise.resolve({
            toolUseId: interaction.toolUseId,
            toolName: interaction.toolName,
            output: resolution,
          }),

        finalize: async ({ blocks, tokenUsage, servedModel }) => {
          await publishPlanCloseOut(
            await completeTurn({
              runId,
              userId: turn.userId,
              messageId: turn.assistantMessageId,
              blocks,
              tokenUsage,
              servedModel,
            }),
          );
        },

        finalizeFailed: async ({ reason, blocks }) => {
          await publishPlanCloseOut(
            await failTurn({
              runId,
              userId: turn.userId,
              messageId: turn.assistantMessageId,
              blocks,
              reason,
            }),
          );
        },

        now: Date.now,
        log: turnLog,
      },
      { runId },
    );

    // Recorded after the fact rather than per request: the ceiling is checked when a turn is
    // admitted, so counting here bounds the NEXT turn instead of abandoning this one halfway.
    await recordRequestUsage({ userId: turn.userId, requests });

    turnLog.info(
      { ...result, requests },
      "turn finished — `requests` is the OpenRouter spend for this turn",
    );

    return result;
  },
});
