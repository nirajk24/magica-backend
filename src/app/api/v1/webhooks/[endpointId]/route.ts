import type { Ok } from "@/contracts";
import { defineRoute, preflight } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { deleteWebhookEndpoint } from "@/services/webhook.service";

const requireEndpointId = (params: Record<string, string>) => {
  const endpointId = params.endpointId;
  if (!endpointId) throw new AppError("VALIDATION_ERROR", "An endpoint id is required.");

  return endpointId;
};

export const DELETE = defineRoute({
  handler: async ({ userId, params }): Promise<Ok> => {
    await deleteWebhookEndpoint({ userId, endpointId: requireEndpointId(params) });

    return { ok: true };
  },
});

export const OPTIONS = preflight;
