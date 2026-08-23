import type { WebhookEvent } from "@/contracts";
import { logger } from "@/lib/logger";
import { emitWebhookEvent } from "@/services/webhook.service";

/**
 * Emits a lifecycle webhook from anywhere in the turn's path.
 *
 * INVARIANT: fire-and-forget and never throws. A turn's outcome must not depend on a customer's
 * receiver, so this awaits only the row write and hands delivery to the durable task.
 *
 * The task is imported lazily so a route or service that emits does not pull the Trigger.dev
 * build graph — and its worker's Prisma bundle — into its own.
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
    dispatch: async (deliveryId) => {
      const { deliverWebhook } = await import("@/trigger/deliver-webhook");
      await deliverWebhook.trigger({ deliveryId }, { idempotencyKey: `webhook:${deliveryId}` });
    },
    onError: (error) => logger.error({ err: error, event: a.event }, "webhook emit failed"),
  });
}
