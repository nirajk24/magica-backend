import { SendMessage, type SendMessageResult } from "@/contracts";
import { definePublicApiRoute, preflight } from "@/lib/api";
import { submitMessage } from "@/services/message-submit.service";

/**
 * Message submission. `:chatId` accepts `new` to start a conversation, exactly as the app's own
 * send route does — the two share one implementation, so behaviour cannot diverge.
 */
export const POST = definePublicApiRoute({
  body: SendMessage,
  handler: ({ userId, body, params, log }): Promise<SendMessageResult> =>
    submitMessage({ userId, chatId: params.chatId ?? "", body, log }),
});

export const OPTIONS = preflight;
