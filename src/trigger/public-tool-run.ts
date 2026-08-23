import { task } from "@trigger.dev/sdk";
import { createToolRuntime } from "@/agent/tool-runtime";
import { ToolError } from "@/lib/errors";
import { bindContext, logger } from "@/lib/logger";
import { closeDirectToolRun } from "@/services/tool-run.service";
import { estimateMicrocredits } from "@/tools/pricing";
import { getTool } from "@/tools/registry";

export type PublicToolRunPayload = {
  userId: string;
  chatId: string;
  runId: string;
  /** The tool-call id this run is keyed on. `beginInvocation` turns it into the invocation row. */
  toolUseId: string;
  toolName: string;
  input: unknown;
};

/**
 * Executes one direct API tool run.
 *
 * INVARIANT: it goes through the same `createToolRuntime` the agent uses, so a public call is
 * charged, reconciled, exactly-once against the provider, and emits `tool.completed` by the same
 * code path as a conversational one. A second implementation would be a second set of bugs.
 *
 * `retry.maxAttempts: 1` for the reason every paid path here uses it: the money guard is the
 * checkpointed `magicaRunId`, and an automatic retry is not what a caller asked for.
 */
export const publicToolRun = task({
  id: "public-tool-run",
  retry: { maxAttempts: 1 },
  run: async (payload: PublicToolRunPayload) => {
    const log = bindContext(logger, { runId: payload.runId, chatId: payload.chatId });
    const tool = getTool(payload.toolName);

    if (!tool?.execute) {
      await closeDirectToolRun({
        runId: payload.runId,
        status: "failed",
        failureReason: "That tool cannot be run directly.",
      });
      return { status: "failed" as const };
    }

    const runtime = createToolRuntime({
      turn: { userId: payload.userId, chatId: payload.chatId, runId: payload.runId },
      publish: async () => {},
      publishPlan: async () => {},
      log,
    });

    const input = tool.input.parse(payload.input);
    const startedAt = Date.now();
    let actualCost: bigint | null = null;

    const invocationId = await runtime.beginInvocation({
      toolUseId: payload.toolUseId,
      toolName: payload.toolName,
      input,
    });

    try {
      await runtime.chargeEstimate({
        invocationId,
        amount: estimateMicrocredits(payload.toolName, input as Record<string, unknown>),
      });

      const output = await tool.execute(input, {
        userId: payload.userId,
        chatId: payload.chatId,
        runId: payload.runId,
        invocationId,
        runNode: (request) => runtime.runNode({ invocationId, request }),
        reportCost: (microcredits) => {
          actualCost = microcredits;
        },
        updatePlanStep: () => {
          throw new ToolError("Plans are not available outside a conversation.");
        },
        loadedSkillNames: async () => [],
        recordSkillLoad: async () => {},
        log,
      });

      await runtime.completeInvocation({
        invocationId,
        output,
        durationMs: Date.now() - startedAt,
        actualCost,
      });
      await closeDirectToolRun({ runId: payload.runId, status: "completed" });

      return { status: "completed" as const };
    } catch (error) {
      const message =
        error instanceof ToolError ? error.message : "That tool run could not be completed.";

      await runtime.failInvocation({
        invocationId,
        message,
        durationMs: Date.now() - startedAt,
      });
      await closeDirectToolRun({ runId: payload.runId, status: "failed", failureReason: message });

      log.warn({ err: error }, "public tool run failed");

      return { status: "failed" as const };
    }
  },
});
