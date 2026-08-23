import { wait } from "@trigger.dev/sdk";
import {
  QuestionsPayload,
  type ResolveWaitpoint,
  type WaitpointKind,
  type WaitpointResolution,
} from "@/contracts";
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
 * Replaces image answers' attachment ids with their URLs, ownership-checked.
 *
 * INVARIANT: an image answer carries attachment IDS from the client and URLS from here on — the
 * model and the persisted resolution only ever see server-resolved URLs, never a client-supplied
 * one. A missing, foreign or unready id answers NOT_FOUND, like everywhere else ids are claimed.
 */
async function resolveImageAnswers(a: {
  userId: string;
  payload: unknown;
  resolution: Extract<ResolveWaitpoint, { kind: "questions" }>;
}): Promise<ResolveWaitpoint> {
  const payload = QuestionsPayload.safeParse(a.payload);
  if (!payload.success) return a.resolution;

  const imageQuestionIds = new Set(
    payload.data.questions.filter((q) => q.type === "image").map((q) => q.id),
  );

  const referenced = Object.entries(a.resolution.answers)
    .filter(([questionId]) => imageQuestionIds.has(questionId))
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]));

  if (referenced.length === 0) return a.resolution;

  const rows = await db.attachment.findMany({
    where: { id: { in: referenced }, userId: a.userId, status: "ready", url: { not: null } },
    select: { id: true, url: true },
  });
  const urlById = new Map(rows.map((row) => [row.id, row.url as string]));

  if (referenced.some((id) => !urlById.has(id))) {
    throw new AppError("NOT_FOUND", "One or more attachments do not exist or are not ready.");
  }

  const answers = Object.fromEntries(
    Object.entries(a.resolution.answers).map(([questionId, value]) => {
      if (!imageQuestionIds.has(questionId)) return [questionId, value];

      return [
        questionId,
        Array.isArray(value) ? value.map((id) => urlById.get(id)!) : urlById.get(value)!,
      ];
    }),
  );

  return { ...a.resolution, answers };
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
    select: {
      id: true,
      kind: true,
      status: true,
      runId: true,
      payload: true,
      run: { select: { chatId: true } },
    },
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

  const resolution =
    a.resolution.kind === "questions"
      ? await resolveImageAnswers({
          userId: a.userId,
          payload: waitpoint.payload,
          resolution: a.resolution,
        })
      : a.resolution;

  const { count } = await db.waitpoint.updateMany({
    where: { id: waitpoint.id, status: "pending" },
    data: { status: "completed", resolution: resolution as never },
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
    await (a.control ?? triggerWaitpointControl).completeToken(waitpoint.id, resolution);
  } catch (error) {
    log.error({ err: error }, "could not complete the waitpoint token");
    throw new AppError("WAITPOINT_EXPIRED", "This request expired. Send a message to continue.");
  }
}
