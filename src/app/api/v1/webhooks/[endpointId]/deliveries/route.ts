import { z } from "zod";
import type { WebhookDeliveriesPage } from "@/contracts";
import { defineRoute, preflight } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { listWebhookDeliveries } from "@/services/webhook.service";

const DeliveriesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** The delivery log — how a caller debugs a receiver that is not seeing events. */
export const GET = defineRoute({
  query: DeliveriesQuery,
  handler: ({ userId, query, params }): Promise<WebhookDeliveriesPage> => {
    const endpointId = params.endpointId;
    if (!endpointId) throw new AppError("VALIDATION_ERROR", "An endpoint id is required.");

    return listWebhookDeliveries({ userId, endpointId, limit: query.limit });
  },
});

export const OPTIONS = preflight;
