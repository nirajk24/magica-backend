import {
  CreateWebhookEndpoint,
  type CreateWebhookEndpointResult,
  type WebhookEndpointsPage,
} from "@/contracts";
import { defineRoute, preflight } from "@/lib/api";
import { createWebhookEndpoint, listWebhookEndpoints } from "@/services/webhook.service";

/** Registers a receiver. The signing secret is in this response only. */
export const POST = defineRoute({
  body: CreateWebhookEndpoint,
  handler: ({ userId, body }): Promise<CreateWebhookEndpointResult> =>
    createWebhookEndpoint({ userId, endpoint: body }),
});

export const GET = defineRoute({
  handler: ({ userId }): Promise<WebhookEndpointsPage> => listWebhookEndpoints(userId),
});

export const OPTIONS = preflight;
