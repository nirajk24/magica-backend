import type { Ok } from "@/contracts";
import { defineRoute, preflight } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { revokeApiKey } from "@/services/api-key.service";

/** Revoked, not deleted: a log line naming a leaked key must still resolve to something. */
export const DELETE = defineRoute({
  handler: async ({ userId, params }): Promise<Ok> => {
    const apiKeyId = params.apiKeyId;
    if (!apiKeyId) throw new AppError("VALIDATION_ERROR", "An API key id is required.");

    await revokeApiKey({ userId, apiKeyId });

    return { ok: true };
  },
});

export const OPTIONS = preflight;
