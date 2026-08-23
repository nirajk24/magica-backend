import { task } from "@trigger.dev/sdk";
import { bindContext, logger } from "@/lib/logger";
import { sendWebhookDelivery } from "@/services/webhook.service";

export type DeliverWebhookPayload = { deliveryId: string };

/**
 * Delivers one outbound webhook, durably.
 *
 * A customer's receiver being down is expected rather than exceptional, so retries are the task's
 * own exponential backoff — the only mechanism here that survives a worker restart. Throwing is
 * how a failed attempt asks for the next one; the delivery row records every attempt either way.
 *
 * INVARIANT: a delivery already marked `delivered` is a no-op, so a retried or duplicated
 * dispatch cannot send the same event twice.
 */
export const deliverWebhook = task({
  id: "deliver-webhook",
  retry: { maxAttempts: 5, factor: 2, minTimeoutInMs: 2_000, maxTimeoutInMs: 60_000 },
  run: async (payload: DeliverWebhookPayload) => {
    const log = bindContext(logger, { deliveryId: payload.deliveryId });
    const result = await sendWebhookDelivery({ deliveryId: payload.deliveryId });

    if (!result.delivered) {
      log.warn({ status: result.status }, "webhook delivery failed");
      throw new Error(`Webhook delivery failed with status ${result.status ?? "no response"}`);
    }

    log.info({ status: result.status }, "webhook delivered");

    return result;
  },
});
