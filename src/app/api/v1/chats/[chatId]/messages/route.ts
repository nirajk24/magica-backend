import { auth } from "@trigger.dev/sdk";
import { SendMessage, type SendMessageResult } from "@/contracts";
import { defineRoute, preflight } from "@/lib/api";
import { reserveAdmission } from "@/lib/credits";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { AppError, isUniqueViolation } from "@/lib/errors";
import { uuidv7 } from "@/lib/ids";
import { consumeSendAllowance } from "@/lib/rate-limit";
import { createChat, getChatForUser, NEW_CHAT_ID } from "@/services/chat.service";
import { agentTurn } from "@/trigger/agent-turn";

const TOKEN_LIFETIME = "15m";
const TITLE_LENGTH = 60;

const titleFrom = (content: string) =>
  content.trim().slice(0, TITLE_LENGTH) || undefined;

/**
 * Starts a turn: validate, admit, persist, dispatch, return fast. No AI work happens here.
 *
 * INVARIANT: the dispatch is outside the transaction. Holding one open across a network call ties a
 * database connection to Trigger.dev's latency, and the compensating path already exists — a run
 * with no `triggerRunId` is what stale-lock recovery looks for.
 *
 * INVARIANT: concurrency is enforced by the `one_active_run_per_chat` partial index, so a double
 * send collides in Postgres rather than racing in application code.
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

    try {
      await db.$transaction(async (tx) => {
        await tx.message.create({
          data: {
            id: userMessageId,
            chatId: chat.id,
            role: "user",
            status: "success",
            content: body.content,
          },
        });

        await tx.agentRun.create({
          data: {
            id: runId,
            chatId: chat.id,
            userId,
            userMessageId,
            idempotencyKey,
            executionMode: body.planMode ? "step_by_step" : "auto",
          },
        });

        // Bumps the chat so the sidebar orders by real activity; a new message does not touch it.
        await tx.chat.update({ where: { id: chat.id }, data: { updatedAt: new Date() } });

        await reserveAdmission(tx, { userId, runId });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        log.warn({ chatId: chat.id }, "send rejected, a run is already active");
        throw new AppError("RUN_ALREADY_ACTIVE", "This chat is already working on something.");
      }
      throw error;
    }

    const handle = await agentTurn.trigger({ runId }, { idempotencyKey });

    // The turn is running from here on, so a failure recording its id must not fail the response —
    // the client would be told the send failed while the work went ahead. The task writes the same
    // id at bootstrap, so recovery does not depend on this write landing.
    try {
      await db.agentRun.update({ where: { id: runId }, data: { triggerRunId: handle.id } });
    } catch (error) {
      log.error({ err: error, runId, triggerRunId: handle.id }, "could not record the trigger run");
    }

    return {
      chatId: chat.id,
      userMessageId,
      assistantMessageId: null,
      runId,
      triggerRunId: handle.id,
      publicAccessToken: await auth.createPublicToken({
        scopes: { read: { runs: [handle.id] } },
        expirationTime: TOKEN_LIFETIME,
      }),
    };
  },
});

export const OPTIONS = preflight;
