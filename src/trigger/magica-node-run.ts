import { tags, task, wait } from "@trigger.dev/sdk";
import { db } from "@/lib/db";
import { ToolError } from "@/lib/errors";
import { bindContext, logger } from "@/lib/logger";
import type { ToolFailureCode } from "@/lib/tool-failure";
import { pollUntilTerminal, runMagicaNode } from "@/tools/magica-client";

export type MagicaNodeRunPayload = {
  invocationId: string;
  nodeType: string;
  subModelId?: string;
  input: unknown;
  timeoutMs?: number;
};

export type MagicaNodeRunSuccess = {
  output: unknown;
  creditUsed: string;
  resumed: boolean;
};

/**
 * A refused or abandoned generation is an ANSWER, not a crashed task, so it crosses the task
 * boundary as data. Thrown, it arrives as Trigger.dev's own serialized error, which the caller
 * cannot trust as user-safe copy and so replaces with something generic — losing the reason the
 * provider gave. `result.ok === false` then means only what it should: the task itself died.
 */
export type MagicaNodeRunResult =
  | ({ ok: true } & MagicaNodeRunSuccess)
  | { ok: false; failure: { code: ToolFailureCode; message: string } };

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
): Promise<MagicaNodeRunSuccess> {
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
  run: async (payload: MagicaNodeRunPayload): Promise<MagicaNodeRunResult> => {
    try {
      const success = await executeMagicaNode(payload, (ms) =>
        wait.for({ seconds: Math.ceil(ms / 1000) }),
      );

      return { ok: true, ...success };
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;

      // Returning the failure completes the run, so the dashboard would otherwise show a refused
      // generation as a success. The tag is what keeps it findable and countable there.
      await tags.add(`failed:${error.code}`);

      return { ok: false, failure: { code: error.code, message: error.message } };
    }
  },
});
