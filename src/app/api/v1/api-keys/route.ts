import { CreateApiKey, type ApiKeysPage, type CreateApiKeyResult } from "@/contracts";
import { defineRoute, preflight } from "@/lib/api";
import { createApiKey, listApiKeys } from "@/services/api-key.service";

/** Issues a key. The plaintext is in this response and nowhere else, ever again. */
export const POST = defineRoute({
  body: CreateApiKey,
  handler: ({ userId, body }): Promise<CreateApiKeyResult> => createApiKey({ userId, input: body }),
});

export const GET = defineRoute({
  handler: ({ userId }): Promise<ApiKeysPage> => listApiKeys(userId),
});

export const OPTIONS = preflight;
