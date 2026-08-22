import { Feedback, type Ok } from "@/contracts";
import { defineRoute, preflight } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { setMessageFeedback } from "@/services/message.service";

/**
 * Rates an assistant answer, or clears the rating with `null`.
 *
 * The same route both ways: clicking a filled thumb again un-rates it, which is the behaviour the
 * control implies, and a separate DELETE for that would be a second path to one column.
 */
export const PATCH = defineRoute({
  body: Feedback,
  handler: async ({ userId, body, params }): Promise<Ok> => {
    const messageId = params.messageId;
    if (!messageId) throw new AppError("VALIDATION_ERROR", "A message id is required.");

    await setMessageFeedback({ userId, messageId, type: body.type });

    return { ok: true };
  },
});

export const OPTIONS = preflight;
