import { MessagesQuery, UpdateChat, type ChatResponse, type ChatWithMessages, type Ok } from "@/contracts";
import { defineRoute, preflight } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { bindContext } from "@/lib/logger";
import { deleteChat, getChatForUser, updateChat } from "@/services/chat.service";
import { listMessages } from "@/services/message.service";
import { cancelActiveRunForChat } from "@/services/run.service";

const requireChatId = (params: Record<string, string>) => {
  const chatId = params.chatId;
  if (!chatId) throw new AppError("VALIDATION_ERROR", "A chat id is required.");

  return chatId;
};

export const GET = defineRoute({
  query: MessagesQuery,
  handler: async ({ userId, query, params }): Promise<ChatWithMessages> => {
    const chatId = requireChatId(params);

    // Ownership first: a page of another user's messages must not be readable even briefly.
    const chat = await getChatForUser({ userId, chatId });
    const { messages, nextCursor } = await listMessages({
      chatId,
      cursor: query.messagesCursor,
      limit: query.limit,
    });

    return { chat, messages, messagesNextCursor: nextCursor };
  },
});

/** Renames a chat or pins it. Both are the same write, so the row comes back either way. */
export const PATCH = defineRoute({
  body: UpdateChat,
  handler: async ({ userId, body, params }): Promise<ChatResponse> => ({
    chat: await updateChat({ userId, chatId: requireChatId(params), patch: body }),
  }),
});

/**
 * Removes a chat from every read, and stops a turn still running inside it.
 *
 * Soft-deleted rather than erased: a run may be mid-flight, and the ledger entries, invocations and
 * assets it produced stay explainable afterwards. Deleting twice is a no-op.
 */
export const DELETE = defineRoute({
  handler: async ({ userId, params, log }): Promise<Ok> => {
    const chatId = requireChatId(params);

    // Stopped before the chat disappears: `cancelRun` scopes its lookup to a live chat, and a
    // failure here leaves the chat intact rather than an orphaned turn behind a deleted one.
    await cancelActiveRunForChat({ userId, chatId, log: bindContext(log, { chatId }) });
    await deleteChat({ userId, chatId });

    return { ok: true };
  },
});

export const OPTIONS = preflight;
