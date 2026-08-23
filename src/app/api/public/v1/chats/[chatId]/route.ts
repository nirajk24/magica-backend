import { MessagesQuery, type ChatWithMessages } from "@/contracts";
import { definePublicApiRoute, preflight } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { getChatForUser } from "@/services/chat.service";
import { listMessages } from "@/services/message.service";

/** One conversation with a page of its messages, newest first. */
export const GET = definePublicApiRoute({
  query: MessagesQuery,
  handler: async ({ userId, query, params }): Promise<ChatWithMessages> => {
    const chatId = params.chatId;
    if (!chatId) throw new AppError("VALIDATION_ERROR", "A chat id is required.");

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
