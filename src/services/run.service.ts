import { auth, runs, wait } from "@trigger.dev/sdk";
import { Prisma } from "@/generated/prisma/client";
import type { SendMessageResult, WaitpointResolution } from "@/contracts";
import { refundAdmission, refundToolCharge, reserveAdmission } from "@/lib/credits";
import { db, type Tx } from "@/lib/db";
import { AppError, isUniqueViolation } from "@/lib/errors";
import { bindContext, type Logger } from "@/lib/logger";
import { agentTurn } from "@/trigger/agent-turn";

type RunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";

const TOKEN_LIFETIME = "15m";

/** Statuses a run may still be written from; anything else has reached a terminal state. */
const WRITABLE = ["queued", "running", "waiting"] as const;

/** Invocations that have not settled, so cancelling them still has an effect. */
const UNSETTLED = ["pending", "running"] as const;

/**
 * A dispatch older than this with no `triggerRunId` never reached Trigger.dev. Only ever applied to
 * a run with no id to ask about — elapsed time says nothing about a run that has one, because
 * `maxDuration` counts CPU and a run suspended on a waitpoint is idle but healthy.
 */
const DISPATCH_GRACE_MS = 90_000;

/**
 * Trigger.dev statuses that mean the run will never do more work. Anything not listed counts as
 * live, so a status added upstream fails towards rejecting a second send rather than towards
 * admitting one alongside a turn that is still executing.
 */
const REMOTE_TERMINAL = new Set([
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "TIMED_OUT",
]);

const LEGAL: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["queued", "running", "failed", "cancelled"],
  running: ["running", "waiting", "completed", "failed", "cancelled"],
  waiting: ["waiting", "running", "completed", "failed", "cancelled"],
  completed: [],
  failed: ["queued"],
  cancelled: ["queued"],
};

/**
 * The one place a run's legal moves are written down. `completed` has no outgoing edge, so no code
 * path can resurrect a finished run; `failed` and `cancelled` reach only `queued`, which is the
 * retry edge and the reason a terminal run is not simply immutable.
 *
 * INVARIANT: self-transitions are legal for non-terminal statuses. A resumed attempt re-marks a run
 * `running`, and that write must not be treated as a bug.
 */
export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!LEGAL[from].includes(to)) {
    throw new Error(`illegal run transition: ${from} -> ${to}`);
  }
}

/**
 * The Trigger.dev calls the compensating paths make, injectable so their ordering is testable
 * without a worker.
 */
export type RunControl = {
  cancel: (triggerRunId: string) => Promise<void>;
  statusOf: (triggerRunId: string) => Promise<string | null>;
  expireWaitpoint: (tokenId: string) => Promise<void>;
};

/**
 * A run Trigger.dev has never heard of cannot still be executing, so it reads as terminal rather
 * than as a failed lookup. Detected structurally — the SDK bundles its own error classes, so an
 * `instanceof` check against ours would silently never match.
 */
function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const status = (error as { status?: unknown; statusCode?: unknown }).status ??
    (error as { statusCode?: unknown }).statusCode;
  if (status === 404) return true;

  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /not\s*found/i.test(message);
}

const triggerRunControl: RunControl = {
  cancel: async (triggerRunId) => {
    await runs.cancel(triggerRunId);
  },
  statusOf: async (triggerRunId) => {
    try {
      const run = await runs.retrieve(triggerRunId);
      return run.status;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  },
  expireWaitpoint: async (tokenId) => {
    await wait.completeToken<WaitpointResolution>(tokenId, { expired: true });
  },
};

/**
 * Closes out invocations that never reached a terminal state, so no tool card claims to still be
 * working after its run has stopped.
 *
 * `refund` is the difference between stopping a run and re-running it. A tool interrupted by a
 * cancel had already started — the provider may well have done and billed the work — so its charge
 * stands. By the time a turn is retried its run is long terminal and that tool demonstrably never
 * completed, so the charge comes back.
 */
async function closeUnsettledInvocations(
  tx: Tx,
  a: { runId: string; userId: string; refund: boolean },
): Promise<number> {
  const open = await tx.toolInvocation.findMany({
    where: { runId: a.runId, status: { in: [...UNSETTLED] } },
    select: { id: true },
  });

  for (const invocation of open) {
    await tx.toolInvocation.update({
      where: { id: invocation.id },
      data: { status: "cancelled", completedAt: new Date() },
    });

    if (a.refund) {
      await refundToolCharge(tx, {
        userId: a.userId,
        invocationId: invocation.id,
        runId: a.runId,
      });
    }
  }

  return open.length;
}

type Termination = { terminated: boolean; waitpointIds: string[] };

/**
 * Brings a run to a terminal state and undoes what it is still holding: the assistant row keeps the
 * partial output it has already persisted, pending waitpoints stop being pending, and the admission
 * hold comes back.
 *
 * INVARIANT: the status flip is the transaction's first statement and is conditional on the run
 * being non-terminal. A run that finished on its own in the meantime writes nothing at all, which is
 * what stops a cancel from overwriting a completed turn.
 *
 * @returns whether this call was the one that terminated the run, plus the waitpoints whose tokens
 * the caller must now close out.
 */
async function terminateRun(a: {
  runId: string;
  userId: string;
  runStatus: "cancelled" | "failed";
  messageStatus: "cancelled" | "failed";
  reason: string | null;
}): Promise<Termination> {
  return db.$transaction(async (tx) => {
    const { count } = await tx.agentRun.updateMany({
      where: { id: a.runId, status: { in: [...WRITABLE] } },
      data: { status: a.runStatus, failureReason: a.reason },
    });

    if (count === 0) return { terminated: false, waitpointIds: [] };

    await tx.message.updateMany({
      where: { runId: a.runId, role: "assistant", status: "streaming" },
      data: { status: a.messageStatus, errorMessage: a.reason },
    });

    const pending = await tx.waitpoint.findMany({
      where: { runId: a.runId, status: "pending" },
      select: { id: true },
    });

    if (pending.length > 0) {
      await tx.waitpoint.updateMany({
        where: { runId: a.runId, status: "pending" },
        data: { status: "expired", resolution: { expired: true } },
      });
    }

    await closeUnsettledInvocations(tx, { runId: a.runId, userId: a.userId, refund: false });
    await refundAdmission(tx, { userId: a.userId, runId: a.runId });

    return { terminated: true, waitpointIds: pending.map((row) => row.id) };
  });
}

/**
 * Stops the machine and closes out the waitpoint tokens, after our own rows already say the run is
 * over. Both are best-effort: the database is the source of truth the UI reads, so a Trigger.dev
 * failure here must not turn a successful cancel into a failed request.
 */
async function detachRemoteRun(
  a: { triggerRunId: string | null; waitpointIds: string[]; log: Logger },
  control: RunControl,
): Promise<void> {
  if (a.triggerRunId) {
    try {
      await control.cancel(a.triggerRunId);
    } catch (error) {
      a.log.error({ err: error, triggerRunId: a.triggerRunId }, "could not cancel the remote run");
    }
  }

  for (const tokenId of a.waitpointIds) {
    try {
      await control.expireWaitpoint(tokenId);
    } catch (error) {
      a.log.warn({ err: error, waitpointTokenId: tokenId }, "could not expire the waitpoint token");
    }
  }
}

/**
 * Stops a run the caller owns, keeping whatever it had already produced.
 *
 * Ordering is load-bearing: our rows go terminal first, so the tool wrapper's cancel guard blocks
 * any further charge, and only then is the machine stopped. Stopping it first would let a swept
 * waitpoint wake a task that then spends a model request finishing a turn the user just cancelled.
 *
 * INVARIANT: idempotent. Cancelling an already-terminal run is a no-op, because a user clicking stop
 * as a turn finishes is a race, not an error.
 */
export async function cancelRun(a: {
  userId: string;
  runId: string;
  log: Logger;
  control?: RunControl;
}): Promise<void> {
  const run = await db.agentRun.findFirst({
    where: { id: a.runId, userId: a.userId, chat: { deletedAt: null } },
    select: { id: true, chatId: true, status: true, triggerRunId: true },
  });

  if (!run) throw new AppError("NOT_FOUND", "That run does not exist.");

  const log = bindContext(a.log, { chatId: run.chatId });

  if (!WRITABLE.includes(run.status as (typeof WRITABLE)[number])) {
    log.info({ status: run.status }, "cancel ignored, the run had already finished");
    return;
  }

  assertTransition(run.status as RunStatus, "cancelled");

  const { terminated, waitpointIds } = await terminateRun({
    runId: run.id,
    userId: a.userId,
    runStatus: "cancelled",
    messageStatus: "cancelled",
    reason: null,
  });

  if (!terminated) {
    log.info("cancel lost to a turn that finished first");
    return;
  }

  await detachRemoteRun(
    { triggerRunId: run.triggerRunId, waitpointIds, log },
    a.control ?? triggerRunControl,
  );
}

/**
 * Stops whatever turn is still holding a chat, if one is. A chat with nothing running is a no-op.
 *
 * Exists so deleting a chat does not leave a turn spending credits against something nobody can
 * open. Ownership is checked the same way `cancelRun` checks it, by the run's own `userId`.
 */
export async function cancelActiveRunForChat(a: {
  userId: string;
  chatId: string;
  log: Logger;
}): Promise<void> {
  const run = await db.agentRun.findFirst({
    where: { chatId: a.chatId, userId: a.userId, status: { in: [...WRITABLE] } },
    select: { id: true },
  });

  if (run) await cancelRun({ userId: a.userId, runId: run.id, log: a.log });
}

/**
 * Hands a run to Trigger.dev and returns everything the client needs to watch it.
 *
 * INVARIANT: the only path to `agentTurn.trigger`. Send and retry share it so the idempotency key,
 * the recorded `triggerRunId` and the realtime token cannot drift between them.
 */
export type DispatchArgs = {
  runId: string;
  chatId: string;
  userMessageId: string;
  assistantMessageId: string | null;
  idempotencyKey: string;
  log: Logger;
};

export async function dispatchTurn(a: DispatchArgs): Promise<SendMessageResult> {
  const handle = await agentTurn.trigger({ runId: a.runId }, { idempotencyKey: a.idempotencyKey });

  // The turn is running from here on, so a failure recording its id must not fail the response —
  // the client would be told the send failed while the work went ahead. The task writes the same
  // id at bootstrap, so recovery does not depend on this write landing.
  try {
    await db.agentRun.update({ where: { id: a.runId }, data: { triggerRunId: handle.id } });
  } catch (error) {
    a.log.error(
      { err: error, runId: a.runId, triggerRunId: handle.id },
      "could not record the trigger run",
    );
  }

  return {
    chatId: a.chatId,
    userMessageId: a.userMessageId,
    assistantMessageId: a.assistantMessageId,
    runId: a.runId,
    triggerRunId: handle.id,
    publicAccessToken: await auth.createPublicToken({
      scopes: { read: { runs: [handle.id] } },
      expirationTime: TOKEN_LIFETIME,
    }),
  };
}

/**
 * Runs a failed or cancelled turn again on the same assistant row, so the retry replaces the
 * outcome the user is looking at rather than appending a second answer.
 *
 * The run row is reused because `AgentRun.userMessageId` is unique — one run per user message, with
 * `attempt` distinguishing tries. Bumping it rewrites the dispatch idempotency key, which is what
 * lets Trigger.dev accept the same work twice.
 */
export async function retryTurn(a: {
  userId: string;
  messageId: string;
  log: Logger;
  dispatch?: (args: DispatchArgs) => Promise<SendMessageResult>;
}): Promise<SendMessageResult> {
  const message = await db.message.findFirst({
    where: { id: a.messageId, role: "assistant", chat: { userId: a.userId, deletedAt: null } },
    select: {
      id: true,
      chatId: true,
      run: { select: { id: true, status: true, attempt: true, userMessageId: true } },
    },
  });

  if (!message?.run) throw new AppError("NOT_FOUND", "That message does not exist.");

  const run = message.run;

  if (run.status === "completed") {
    throw new AppError("VALIDATION_ERROR", "That response finished successfully.");
  }

  if (WRITABLE.includes(run.status as (typeof WRITABLE)[number])) {
    throw new AppError("RUN_ALREADY_ACTIVE", "This chat is already working on something.");
  }

  assertTransition(run.status as RunStatus, "queued");

  const log = bindContext(a.log, { chatId: message.chatId, runId: run.id });
  const attempt = run.attempt + 1;
  const idempotencyKey = `${run.userMessageId}:${attempt}`;

  try {
    await db.$transaction(async (tx) => {
      const { count } = await tx.agentRun.updateMany({
        where: { id: run.id, status: { in: ["failed", "cancelled"] } },
        data: {
          status: "queued",
          attempt,
          idempotencyKey,
          failureReason: null,
          // Cleared so stale-lock recovery cannot ask Trigger.dev about the previous attempt's
          // machine, find it terminal, and declare this one dead.
          triggerRunId: null,
        },
      });

      if (count === 0) throw new AppError("RUN_ALREADY_ACTIVE", "That retry is already running.");

      await tx.message.update({
        where: { id: message.id },
        data: {
          status: "streaming",
          content: "",
          // `DbNull` writes SQL NULL; a bare `undefined` would leave the previous attempt's output
          // in place, and `JsonNull` would store the JSON literal `null` for readers to trip over.
          contentBlocks: Prisma.DbNull,
          assets: Prisma.DbNull,
          tokenUsage: Prisma.DbNull,
          creditUsed: 0n,
          errorMessage: null,
        },
      });

      await closeUnsettledInvocations(tx, { runId: run.id, userId: a.userId, refund: true });
      await reserveAdmission(tx, { userId: a.userId, runId: run.id, attempt });
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError("RUN_ALREADY_ACTIVE", "This chat is already working on something.");
    }
    throw error;
  }

  log.info({ attempt }, "retrying a turn");

  return (a.dispatch ?? dispatchTurn)({
    runId: run.id,
    chatId: message.chatId,
    userMessageId: run.userMessageId,
    assistantMessageId: message.id,
    idempotencyKey,
    log,
  });
}

export type StaleRunOutcome = "active" | "recovered" | "gone";

/**
 * Decides whether the run holding a chat's active slot is genuinely alive, and clears it if not.
 *
 * INVARIANT: liveness is never inferred from a timestamp. Trigger.dev's `maxDuration` counts CPU
 * time, so a run parked on a waitpoint for fourteen minutes looks old while being perfectly
 * healthy. Age is only consulted for a run with no `triggerRunId` — there is nothing to ask about,
 * and past the grace period the dispatch demonstrably never landed.
 *
 * @returns `active` to reject the caller, `recovered` once a dead run has been failed and refunded,
 * or `gone` if the slot was already free.
 */
export async function resolveStaleRun(a: {
  userId: string;
  chatId: string;
  log: Logger;
  control?: RunControl;
  now?: () => number;
}): Promise<StaleRunOutcome> {
  const control = a.control ?? triggerRunControl;
  const now = a.now ?? Date.now;

  const run = await db.agentRun.findFirst({
    where: { chatId: a.chatId, userId: a.userId, status: { in: [...WRITABLE] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, userId: true, triggerRunId: true, createdAt: true },
  });

  if (!run) return "gone";

  if (!run.triggerRunId) {
    if (now() - run.createdAt.getTime() < DISPATCH_GRACE_MS) return "active";

    a.log.warn({ runId: run.id }, "recovering a run whose dispatch never landed");
    const dispatchless = await terminateRun({
      runId: run.id,
      userId: run.userId,
      runStatus: "failed",
      messageStatus: "failed",
      reason: "This response could not be started. Try sending it again.",
    });

    await detachRemoteRun(
      { triggerRunId: null, waitpointIds: dispatchless.waitpointIds, log: a.log },
      control,
    );

    return "recovered";
  }

  let remoteStatus: string | null;
  try {
    remoteStatus = await control.statusOf(run.triggerRunId);
  } catch (error) {
    // Not knowing is not the same as knowing it is dead. Refunding a live run's hold would admit a
    // second turn beside it, so an unreachable Trigger.dev keeps the slot held.
    a.log.error({ err: error, runId: run.id }, "could not check whether the run is still alive");
    return "active";
  }

  if (remoteStatus && !REMOTE_TERMINAL.has(remoteStatus)) return "active";

  a.log.warn({ runId: run.id, remoteStatus }, "recovering a run that stopped without finalizing");

  const { waitpointIds } = await terminateRun({
    runId: run.id,
    userId: run.userId,
    runStatus: "failed",
    messageStatus: "failed",
    reason: "This response stopped unexpectedly. Try sending it again.",
  });

  await detachRemoteRun({ triggerRunId: null, waitpointIds, log: a.log }, control);

  return "recovered";
}
