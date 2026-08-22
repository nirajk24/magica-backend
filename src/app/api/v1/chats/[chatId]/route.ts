import { MessagesQuery, type ChatWithMessages } from "@/contracts";
import { defineRoute, preflight } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { getChatForUser } from "@/services/chat.service";
import { listMessages } from "@/services/message.service";

export const GET = defineRoute({
  query: MessagesQuery,
  handler: async ({ userId, query, params }): Promise<ChatWithMessages> => {
    const chatId = params.chatId;
    if (!chatId) throw new AppError("VALIDATION_ERROR", "A chat id is required.");

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

export const OPTIONS = preflight;
