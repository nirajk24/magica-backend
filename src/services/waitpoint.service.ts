import { wait } from "@trigger.dev/sdk";
import type { ResolveWaitpoint, WaitpointKind, WaitpointResolution } from "@/contracts";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { bindContext, type Logger } from "@/lib/logger";

type Settled = "completed" | "expired";

/**
 * Completing the token is what wakes the parked task, so it is injectable and the ordering around it
 * is testable without a worker.
 */
export type WaitpointControl = {
  completeToken: (tokenId: string, resolution: WaitpointResolution) => Promise<void>;
};

const triggerWaitpointControl: WaitpointControl = {
  completeToken: async (tokenId, resolution) => {
    await wait.completeToken<WaitpointResolution>(tokenId, resolution);
  },
};

/**
 * Records the interaction a turn is about to park on.
 *
 * The row, not the token, is what the UI reads: a client that reloads mid-wait rebuilds the overlay
 * from here through `GET /chats/:id/active-run`.
 */
export async function openWaitpoint(a: {
  id: string;
  runId: string;
  kind: WaitpointKind;
  payload: unknown;
  invocationId: string;
}): Promise<void> {
  await db.waitpoint.create({
    data: {
      id: a.id,
      runId: a.runId,
      kind: a.kind,
      payload: a.payload as never,
      invocationId: a.invocationId,
    },
  });
}

/**
 * Settles a waitpoint the parked task has just come back from.
 *
 * INVARIANT: conditional on `pending`. A run cancelled while parked has already swept this row to
 * `expired`, and the resolve route may have written the answer — neither may be overwritten by the
 * task waking up afterwards.
 */
export async function closeWaitpoint(a: {
  id: string;
  status: Settled;
  resolution: WaitpointResolution;
}): Promise<void> {
  await db.waitpoint.updateMany({
    where: { id: a.id, status: "pending" },
    data: { status: a.status, resolution: a.resolution as never },
  });
}

/**
 * Answers a waitpoint on the user's behalf and wakes the run parked on it.
 *
 * INVARIANT: the update is conditional on `pending`, and the token is completed only by the caller
 * that won it. A double-clicked approval therefore resolves the turn exactly once, and the second
 * request is a no-op rather than a second resumption.
 *
 * Ownership is part of the lookup and a miss answers NOT_FOUND: a 403 would confirm the id exists.
 */
export async function resolveWaitpoint(a: {
  userId: string;
  waitpointId: string;
  resolution: ResolveWaitpoint;
  log: Logger;
  control?: WaitpointControl;
}): Promise<void> {
  const waitpoint = await db.waitpoint.findFirst({
    where: { id: a.waitpointId, run: { userId: a.userId, chat: { deletedAt: null } } },
    select: { id: true, kind: true, status: true, runId: true, run: { select: { chatId: true } } },
  });

  if (!waitpoint) throw new AppError("NOT_FOUND", "That request is no longer available.");

  const log = bindContext(a.log, {
    runId: waitpoint.runId,
    chatId: waitpoint.run.chatId,
    waitpointTokenId: waitpoint.id,
  });

  if (waitpoint.kind !== a.resolution.kind) {
    throw new AppError(
      "VALIDATION_ERROR",
      `This request expects a ${waitpoint.kind} response.`,
    );
  }

  const { count } = await db.waitpoint.updateMany({
    where: { id: waitpoint.id, status: "pending" },
    data: { status: "completed", resolution: a.resolution as never },
  });

  if (count === 0) {
    if (waitpoint.status === "expired") {
      throw new AppError("WAITPOINT_EXPIRED", "This request expired. Send a message to continue.");
    }

    log.info("resolve ignored, the request had already been answered");
    return;
  }

  // The row is what the UI reads, so it is already correct; waking the task is the remaining step.
  // A failure here leaves the turn parked until its own timeout, which is the safe direction.
  try {
    await (a.control ?? triggerWaitpointControl).completeToken(waitpoint.id, a.resolution);
  } catch (error) {
    log.error({ err: error }, "could not complete the waitpoint token");
    throw new AppError("WAITPOINT_EXPIRED", "This request expired. Send a message to continue.");
  }
}
