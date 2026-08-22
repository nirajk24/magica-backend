import type { SendMessageResult } from "@/contracts";
import { defineRoute, preflight } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { bindContext } from "@/lib/logger";
import { retryTurn } from "@/services/run.service";

/**
 * Runs a failed or cancelled turn again on the same assistant row.
 *
 * Returns `SendMessageResult`, identical to send, so a client watches a retried turn through the
 * path it already has rather than a second one.
 */
export const POST = defineRoute({
  handler: async ({ userId, params, log }): Promise<SendMessageResult> => {
    const messageId = params.messageId;
    if (!messageId) throw new AppError("VALIDATION_ERROR", "A message id is required.");

    return retryTurn({ userId, messageId, log: bindContext(log, { messageId }) });
  },
});

export const OPTIONS = preflight;
