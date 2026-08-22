import { SendMessage, type SendMessageResult } from "@/contracts";
import { defineRoute, preflight } from "@/lib/api";
import { reserveAdmission } from "@/lib/credits";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { AppError, isUniqueViolation } from "@/lib/errors";
import { uuidv7 } from "@/lib/ids";
import type { Logger } from "@/lib/logger";
import { consumeSendAllowance } from "@/lib/rate-limit";
import { createChat, getChatForUser, NEW_CHAT_ID } from "@/services/chat.service";
import { dispatchTurn, resolveStaleRun } from "@/services/run.service";

const TITLE_LENGTH = 60;

const titleFrom = (content: string) =>
  content.trim().slice(0, TITLE_LENGTH) || undefined;

type Admission = {
  chatId: string;
  userId: string;
  content: string;
  modelId: string;
  planMode: boolean;
  userMessageId: string;
  runId: string;
  idempotencyKey: string;
};

/**
 * Persists the user's message and claims the chat's single active-run slot.
 *
 * INVARIANT: concurrency is enforced by the `one_active_run_per_chat` partial index, so a double
 * send collides in Postgres rather than racing in application code.
 *
 * @returns false if the slot is already taken, so the caller can decide whether the holder is alive.
 */
async function admitRun(a: Admission): Promise<boolean> {
  try {
    await db.$transaction(async (tx) => {
      await tx.message.create({
        data: {
          id: a.userMessageId,
          chatId: a.chatId,
          role: "user",
          status: "success",
          content: a.content,
        },
      });

      await tx.agentRun.create({
        data: {
          id: a.runId,
          chatId: a.chatId,
          userId: a.userId,
          userMessageId: a.userMessageId,
          idempotencyKey: a.idempotencyKey,
          // Not `executionMode`: that is how an *approved plan* runs and is set from the approval.
          planMode: a.planMode,
        },
      });

      // Bumps the chat so the sidebar orders by real activity; a new message does not touch it.
      // `modelId` is persisted on every send, not only at creation: the composer's model control is
      // per-message, and silently ignoring it was the one clearly wrong option. Which model actually
      // answered is recorded per message on `aiModel`, so switching does not rewrite history.
      await tx.chat.update({
        where: { id: a.chatId },
        data: { updatedAt: new Date(), modelId: a.modelId },
      });

      await reserveAdmission(tx, { userId: a.userId, runId: a.runId, attempt: 1 });
    });

    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

/**
 * Admits a run, and if the slot is held, decides whether its holder is genuinely alive before
 * refusing. Attempted at most twice: a second collision means a real concurrent sender, not a
 * corpse, so the caller is rejected rather than looping.
 */
async function admitOrRecover(a: Admission, log: Logger): Promise<void> {
  if (await admitRun(a)) return;

  const outcome = await resolveStaleRun({ userId: a.userId, chatId: a.chatId, log });

  if (outcome === "active") {
    log.warn({ chatId: a.chatId }, "send rejected, a run is already active");
    throw new AppError("RUN_ALREADY_ACTIVE", "This chat is already working on something.");
  }

  if (!(await admitRun(a))) {
    log.warn({ chatId: a.chatId, outcome }, "send rejected, the slot was retaken");
    throw new AppError("RUN_ALREADY_ACTIVE", "This chat is already working on something.");
  }
}

/**
 * Starts a turn: validate, admit, persist, dispatch, return fast. No AI work happens here.
 *
 * INVARIANT: the dispatch is outside the transaction. Holding one open across a network call ties a
 * database connection to Trigger.dev's latency, and the compensating path already exists — a run
 * with no `triggerRunId` is what stale-lock recovery looks for.
 */
export const POST = defineRoute({
  body: SendMessage,
  handler: async ({ userId, body, params, log }): Promise<SendMessageResult> => {
    const requested = params.chatId;
    if (!requested) throw new AppError("VALIDATION_ERROR", "A chat id is required.");

    await consumeSendAllowance({ userId, perMinute: env.SEND_RATE_PER_MINUTE });

    const chat =
      requested === NEW_CHAT_ID
        ? await createChat({ userId, modelId: body.modelId, title: titleFrom(body.content) })
        : await getChatForUser({ userId, chatId: requested });

    const userMessageId = uuidv7();
    const runId = uuidv7();
    const idempotencyKey = `${userMessageId}:1`;

    await admitOrRecover(
      {
        chatId: chat.id,
        userId,
        content: body.content,
        modelId: body.modelId,
        planMode: body.planMode,
        userMessageId,
        runId,
        idempotencyKey,
      },
      log,
    );

    return dispatchTurn({
      runId,
      chatId: chat.id,
      userMessageId,
      assistantMessageId: null,
      idempotencyKey,
      log,
    });
  },
});

export const OPTIONS = preflight;
