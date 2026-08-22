import type { RunMetadata } from "@/contracts";
import { chargeTool, reconcileToolCharge, refundToolCharge } from "@/lib/credits";
import { db } from "@/lib/db";
import { AppError, ToolError } from "@/lib/errors";
import type { Logger } from "@/lib/logger";
import { getTool } from "@/tools/registry";
import type { ToolRuntime, TurnContext } from "@/tools/to-ai-sdk";
import { magicaNodeRun } from "@/trigger/magica-node-run";

const ACTIVE = ["queued", "running", "waiting"] as const;

type Invocations = RunMetadata["invocations"];

/**
 * Reads the run's invocations back in the shape the live tool cards render from. Read rather than
 * accumulated in memory, so a resumed attempt publishes the same list a fresh one would.
 */
async function projectInvocations(runId: string): Promise<Invocations> {
  const rows = await db.toolInvocation.findMany({
    where: { runId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      toolUseId: true,
      toolName: true,
      status: true,
      creditUsed: true,
      startedAt: true,
      completedAt: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    toolUseId: row.toolUseId,
    toolName: row.toolName,
    display: getTool(row.toolName)?.display ?? { label: row.toolName, icon: "tool" },
    state: row.status,
    credits: row.creditUsed.toString(),
    ...(row.startedAt && row.completedAt
      ? { durationMs: row.completedAt.getTime() - row.startedAt.getTime() }
      : {}),
  }));
}

/**
 * The Postgres and credits half of `toAiSdkTools`' seam. Holds every effect the wrapper orders but
 * does not perform, so the ordering policy stays testable without a database and the persistence
 * stays in one place.
 *
 * `publish` is injected rather than calling `metadata.set` directly, because this module is also
 * exercised outside a Trigger.dev run.
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

    /**
     * Idempotent on `(runId, toolUseId)`: a replayed step reuses its row rather than opening a
     * second one, which is what keeps `charge:{invocationId}` a stable idempotency key.
     */
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

    /** Records the estimate on the card in the same transaction that moves the credits. */
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
     * Dispatches the provider call as a durable child run so the agent machine suspends while it
     * polls instead of holding a CPU for the whole node run.
     *
     * INVARIANT: `idempotencyKey` is the invocation. Trigger.dev then dedups the dispatch, and the
     * child's own `magicaRunId` check dedups the external submission — two independent guards on
     * the one operation that spends real money.
     */
    async runNode({ invocationId, request }) {
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
        // Its own transaction, and the shortfall is swallowed: the work is already paid for, so
        // failing a finished step over a rounding delta achieves nothing, and the rollback would
        // drop the ledger row with it.
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

    /** A failed step is free: the charge taken before `execute` is reversed by the amount recorded. */
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
