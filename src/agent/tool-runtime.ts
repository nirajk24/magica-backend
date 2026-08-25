import { INPUT_VALUE_CHARS, type RunMetadata } from "@/contracts";
import { chargeTool, reconcileToolCharge, refundToolCharge } from "@/lib/credits";
import { validateNodeInput } from "@/tools/catalog-schema";
import { db } from "@/lib/db";
import { AppError, ToolError } from "@/lib/errors";
import type { Logger } from "@/lib/logger";
import { publishLifecycleEvent } from "@/lib/webhook-emit";
import { patchActivePlanStep } from "@/services/turn.service";
import { assetsFromInvocation } from "@/tools/assets";
import { getTool } from "@/tools/registry";
import type { ToolRuntime, TurnContext } from "@/tools/to-ai-sdk";
import { magicaNodeRun } from "@/trigger/magica-node-run";

const ACTIVE = ["queued", "running", "waiting"] as const;

type Invocations = RunMetadata["invocations"];

/**
 * Shortens every string in a tool's input so the projection stays small.
 *
 * The realtime snapshot is re-sent whenever anything in it changes, so one long prompt is multiplied
 * by the number of updates a turn makes. Only the running card reads this; the finished card reads
 * the untruncated input from the persisted row.
 */
function forDisplay(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > INPUT_VALUE_CHARS ? `${value.slice(0, INPUT_VALUE_CHARS)}…` : value;
  }
  if (Array.isArray(value)) return value.map(forDisplay);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, forDisplay(v)]));
  }
  return value;
}

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
      input: true,
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
      ...(row.input === null ? {} : { input: forDisplay(row.input) as never }),
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
  publishPlan: (plan: RunMetadata["activePlan"]) => Promise<void>;
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
      // Checked against the provider's live schema before anything durable is dispatched, so a
      // stale field name comes back as a correctable tool error instead of a provider rejection.
      validateNodeInput({
        nodeType: request.nodeType,
        subModelId: request.subModelId,
        input: request.input,
      });

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

      // Trigger.dev's own `ok` covers the task dying — crash, OOM, worker lost. Its error is a
      // serialized foreign object, so it cannot be shown to anyone and the message here is ours.
      if (!result.ok) {
        a.log.error({ invocationId, err: result.error }, "node child run crashed");
        throw new ToolError("That generation could not be completed.", "internal");
      }

      if (!result.output.ok) {
        const { code, message } = result.output.failure;
        a.log.warn({ invocationId, code }, "node run failed");

        throw new ToolError(message, code);
      }

      return {
        output: result.output.output,
        creditUsed: BigInt(result.output.creditUsed),
      };
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

      await publishLifecycleEvent({
        userId: turn.userId,
        event: "tool.completed",
        data: {
          runId: turn.runId,
          chatId: turn.chatId,
          invocationId,
          durationMs,
          creditUsed: (actualCost ?? 0n).toString(),
        },
      });
    },

    /** A failed step is free: the pre-execute charge is reversed by the amount recorded. */
    async failInvocation({ invocationId, code, message, durationMs }) {
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
            failureCode: code,
            completedAt: new Date(),
            creditUsed: 0,
          },
        });
      });

      a.log.warn({ invocationId, code, durationMs }, "tool failed");
      await publish();
    },

    /** The write and the live card move together, so a reload never shows a stale step. */
    async updatePlanStep(patch) {
      const plan = await patchActivePlanStep({ chatId: turn.chatId, ...patch });
      await a.publishPlan(plan as RunMetadata["activePlan"]);

      return plan;
    },

    async loadedSkillNames() {
      const rows = await db.runSkill.findMany({
        where: { runId: turn.runId },
        select: { skillName: true },
        distinct: ["skillName"],
      });

      return rows.map((row) => row.skillName);
    },

    /** The unique `(runId, skillName, assetPath)` is what makes a repeated load a dedup. */
    async recordSkillLoad({ skillName, assetPath, contentHash }) {
      await db.runSkill.upsert({
        where: { runId_skillName_assetPath: { runId: turn.runId, skillName, assetPath } },
        update: { contentHash },
        create: { runId: turn.runId, skillName, assetPath, contentHash },
      });
    },
  };
}
