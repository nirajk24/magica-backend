import { task, wait } from "@trigger.dev/sdk";
import { db } from "@/lib/db";
import { bindContext, logger } from "@/lib/logger";
import { pollUntilTerminal, runMagicaNode } from "@/tools/magica-client";

export type MagicaNodeRunPayload = {
  invocationId: string;
  nodeType: string;
  subModelId?: string;
  input: unknown;
  timeoutMs?: number;
};

export type MagicaNodeRunResult = {
  output: unknown;
  creditUsed: string;
  resumed: boolean;
};

type Sleep = (ms: number) => Promise<void>;

/**
 * Runs one Magica node, resuming rather than resubmitting if a previous attempt already reached
 * the provider.
 *
 * INVARIANT: never submit twice. A `magicaRunId` on the invocation means Magica has already been
 * paid for this work, so an attempt that finds one must only poll. This is the sole guard against
 * a restarted worker doubling the bill.
 *
 * Separate from the task shell so the resume decision is testable without a live worker — the
 * task and the tests run this same function rather than two copies of the rule.
 */
export async function executeMagicaNode(
  payload: MagicaNodeRunPayload,
  sleep: Sleep,
): Promise<MagicaNodeRunResult> {
  const log = bindContext(logger, { processId: payload.invocationId });

  const invocation = await db.toolInvocation.findUniqueOrThrow({
    where: { id: payload.invocationId },
    select: { magicaRunId: true },
  });

  if (invocation.magicaRunId) {
    log.info({ magicaRunId: invocation.magicaRunId }, "resuming an already-submitted magica run");
    const resumed = await pollUntilTerminal(invocation.magicaRunId, sleep, payload.timeoutMs);
    return { output: resumed.output, creditUsed: resumed.creditUsed.toString(), resumed: true };
  }

  const result = await runMagicaNode({
    nodeType: payload.nodeType,
    subModelId: payload.subModelId,
    input: payload.input,
    sleep,
    timeoutMs: payload.timeoutMs,
    onRunId: async (magicaRunId) => {
      await db.toolInvocation.update({
        where: { id: payload.invocationId },
        data: { magicaRunId },
      });
    },
  });

  return { output: result.output, creditUsed: result.creditUsed.toString(), resumed: false };
}

/**
 * Durable wrapper so a node run outlives the agent turn that requested it.
 *
 * `retry.maxAttempts: 1` because retries are manual: an automatic one would replay narrative the
 * user has already seen and regenerate tool ids that no longer match the persisted rows.
 *
 * Sleeping through `wait.for` suspends the machine between polls, which only happens for waits over
 * Trigger.dev's 5s charge threshold — hence the poll interval in `magica-client`.
 */
export const magicaNodeRun = task({
  id: "magica-node-run",
  retry: { maxAttempts: 1 },
  run: (payload: MagicaNodeRunPayload): Promise<MagicaNodeRunResult> =>
    executeMagicaNode(payload, (ms) => wait.for({ seconds: Math.ceil(ms / 1000) })),
});
