import type { LlmStatus } from "@/contracts";
import { db } from "@/lib/db";

/** The status table is a single row; there is one LLM path and it is shared by every user. */
const ROW_ID = 1;

/** Applied when the provider names no `Retry-After`, which free-tier models usually do not. */
const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * Records that the shared LLM path is rate limited, so a client can say when to come back instead of
 * reporting a generic failure.
 *
 * `modelId` is the model that hit the limit. This table answers availability only — which model
 * served a given answer is recorded per message, on `Message.aiModel`, where it belongs.
 */
export async function recordRateLimit(a: {
  modelId: string;
  retryAfterSeconds?: number;
  now?: () => number;
}): Promise<void> {
  const now = a.now ?? Date.now;
  const cooldownMs = a.retryAfterSeconds ? a.retryAfterSeconds * 1000 : DEFAULT_COOLDOWN_MS;
  const until = new Date(now() + cooldownMs);

  await db.llmStatus.upsert({
    where: { id: ROW_ID },
    create: { id: ROW_ID, limitedModel: a.modelId, rateLimitedUntil: until },
    update: { limitedModel: a.modelId, rateLimitedUntil: until },
  });
}

/**
 * The shared LLM path's current state. A cooldown that has already elapsed reads as clear rather
 * than as a stale timestamp, so a client never has to compare clocks itself.
 */
export async function readLlmStatus(now: () => number = Date.now): Promise<LlmStatus> {
  const row = await db.llmStatus.findUnique({
    where: { id: ROW_ID },
    select: { limitedModel: true, rateLimitedUntil: true },
  });

  const until = row?.rateLimitedUntil ?? null;

  return {
    limitedModel: row?.limitedModel ?? null,
    rateLimitedUntil: until !== null && until.getTime() > now() ? until.toISOString() : null,
  };
}
