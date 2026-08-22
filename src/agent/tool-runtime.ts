import type { RunMetadata } from "@/contracts";
import { chargeTool, reconcileToolCharge, refundToolCharge } from "@/lib/credits";
import { db } from "@/lib/db";
import { AppError, ToolError } from "@/lib/errors";
import type { Logger } from "@/lib/logger";
import { assetsFromInvocation } from "@/tools/assets";
import { getTool } from "@/tools/registry";
import type { ToolRuntime, TurnContext } from "@/tools/to-ai-sdk";
import { magicaNodeRun } from "@/trigger/magica-node-run";

const ACTIVE = ["queued", "running", "waiting"] as const;

type Invocations = RunMetadata["invocations"];

/** The run's invocations in the shape the live tool cards render from, read rather than accumulated. */
async function projectInvocations(runId: string): Promise<Invocations> {
  const rows = await db.toolInvocation.findMany({
    where: { runId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      toolUseId: true,
      toolName: true,
      subModelId: true,
      status: true,
      output: true,
      creditUsed: true,
      startedAt: true,
      completedAt: true,
    },
  });

  return rows.map((row) => {
    const urls = assetsFromInvocation(row).map((asset) => asset.url);

    return {
      id: row.id,
      toolUseId: row.toolUseId,
      toolName: row.toolName,
      display: getTool(row.toolName)?.display ?? { label: row.toolName, icon: "tool" },
      state: row.status,
      ...(row.subModelId ? { subModelId: row.subModelId } : {}),
      credits: row.creditUsed.toString(),
      ...(urls.length > 0 ? { resultUrls: urls } : {}),
      ...(row.startedAt && row.completedAt
        ? { durationMs: row.completedAt.getTime() - row.startedAt.getTime() }
        : {}),
    };
  });
}

/**
 * The Postgres and credits half of `toAiSdkTools`' seam. `publish` is injected rather than calling
 * `metadata.set`, so this runs outside a Trigger.dev run too.
 */
export function createToolRuntime(a: {
  turn: TurnContext;
  publish: (invocations: Invocations) => Promise<void>;
  log: Logger;
  now?: () => number;
}): ToolRuntime {
  const { turn } = a;
  const publish = () => projectInvocations(turn.runId).then(a.publish);

  return {
    now: a.now ?? Date.now,
    log: a.log,

    async isRunActive() {
      const run = await db.agentRun.findUnique({
        where: { id: turn.runId },
        select: { status: true },
      });

      return run !== null && ACTIVE.includes(run.status as (typeof ACTIVE)[number]);
    },

    /** Idempotent on `(runId, toolUseId)`, which keeps `charge:{invocationId}` a stable key. */
    async beginInvocation({ toolUseId, toolName, input }) {
      const invocation = await db.toolInvocation.upsert({
        where: { runId_toolUseId: { runId: turn.runId, toolUseId } },
        update: { status: "running" },
        create: {
          runId: turn.runId,
          toolUseId,
          toolName,
          input: input as never,
          status: "running",
          startedAt: new Date(),
        },
        select: { id: true },
      });

      await publish();

      return invocation.id;
    },

    /** Writes the estimate onto the card in the transaction that moves the credits. */
    async chargeEstimate({ invocationId, amount }) {
      await db.$transaction(async (tx) => {
        await chargeTool(tx, { userId: turn.userId, runId: turn.runId, invocationId, amount });
        await tx.toolInvocation.update({
          where: { id: invocationId },
          data: { creditUsed: amount },
        });
      });

      await publish();
    },

    /**
     * Dispatches the provider call as a durable child run, so the machine suspends between polls.
     *
     * INVARIANT: keyed on the invocation. Trigger.dev dedups the dispatch and the child's
     * `magicaRunId` check dedups the submission — two guards on the one call that costs money.
     */
    async runNode({ invocationId, request }) {
      await db.toolInvocation.update({
        where: { id: invocationId },
        data: { subModelId: request.subModelId ?? null },
      });

      const result = await magicaNodeRun.triggerAndWait(
        {
          invocationId,
          nodeType: request.nodeType,
          subModelId: request.subModelId,
          input: request.input,
          timeoutMs: request.timeoutMs,
        },
        { idempotencyKey: invocationId },
      );

      if (!result.ok) {
        a.log.error({ invocationId, err: result.error }, "node child run failed");
        throw new ToolError("That generation could not be completed.", true);
      }

      return { output: result.output.output, creditUsed: BigInt(result.output.creditUsed) };
    },

    async completeInvocation({ invocationId, output, durationMs, actualCost }) {
      await db.toolInvocation.update({
        where: { id: invocationId },
        data: {
          status: "completed",
          output: output as never,
          completedAt: new Date(),
          ...(actualCost === null ? {} : { creditUsed: actualCost }),
        },
      });

      if (actualCost !== null) {
        // Swallowed on purpose: the work is already paid for, so failing a finished step over a
        // rounding delta achieves nothing.
        try {
          await db.$transaction((tx) =>
            reconcileToolCharge(tx, {
              userId: turn.userId,
              runId: turn.runId,
              invocationId,
              actual: actualCost,
            }),
          );
        } catch (error) {
          if (!(error instanceof AppError && error.code === "INSUFFICIENT_CREDITS")) throw error;
          a.log.warn({ invocationId, actualCost: actualCost.toString() }, "shortfall not collected");
        }
      }

      a.log.info({ invocationId, durationMs }, "tool completed");
      await publish();
    },

    /** A failed step is free: the pre-execute charge is reversed by the amount recorded. */
    async failInvocation({ invocationId, message, durationMs }) {
      await db.$transaction(async (tx) => {
        await refundToolCharge(tx, {
          userId: turn.userId,
          runId: turn.runId,
          invocationId,
        });
        await tx.toolInvocation.update({
          where: { id: invocationId },
          data: {
            status: "failed",
            errorMessage: message,
            completedAt: new Date(),
            creditUsed: 0,
          },
        });
      });

      a.log.warn({ invocationId, durationMs }, "tool failed");
      await publish();
    },
  };
}
