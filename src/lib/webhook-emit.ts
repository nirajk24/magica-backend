import type { WebhookEvent } from "@/contracts";
import { logger } from "@/lib/logger";
import { emitWebhookEvent } from "@/services/webhook.service";
import { deliverWebhook } from "@/trigger/deliver-webhook";

/**
 * Emits a lifecycle webhook from anywhere in the turn's path.
 *
 * INVARIANT: never throws. A turn's outcome must not depend on a customer's receiver, so this
 * awaits only the delivery row and hands the send itself to the durable task.
 *
 * INVARIANT: the delivery is keyed on its row id, so a replayed emit cannot queue the same event
 * twice.
 */
export async function publishLifecycleEvent(a: {
  userId: string;
  event: WebhookEvent;
  data: Record<string, unknown>;
}): Promise<void> {
  await emitWebhookEvent({
    userId: a.userId,
    event: a.event,
    data: a.data,
    dispatch: (deliveryId) =>
      deliverWebhook
        .trigger({ deliveryId }, { idempotencyKey: `webhook:${deliveryId}` })
        .then(() => undefined),
    onError: (error) => logger.error({ err: error, event: a.event }, "webhook emit failed"),
  });
}
