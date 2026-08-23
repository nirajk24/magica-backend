import {
  MAX_ACTIVE_API_KEYS,
  type ApiKeyDTO,
  type ApiKeysPage,
  type CreateApiKey,
  type CreateApiKeyResult,
} from "@/contracts";
import { fingerprintOf, mintApiKey } from "@/lib/api-keys";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";

const keySelect = {
  id: true,
  name: true,
  hashedKey: true,
  rateLimitPerMinute: true,
  rateLimitPerDay: true,
  expiresAt: true,
  createdAt: true,
  revokedAt: true,
} as const;

type KeyRow = {
  id: string;
  name: string;
  hashedKey: string;
  rateLimitPerMinute: number | null;
  rateLimitPerDay: number | null;
  expiresAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
};

const toApiKeyDTO = (row: KeyRow): ApiKeyDTO => ({
  id: row.id,
  name: row.name,
  fingerprint: fingerprintOf(row.hashedKey),
  rateLimitPerMinute: row.rateLimitPerMinute,
  rateLimitPerDay: row.rateLimitPerDay,
  expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  createdAt: row.createdAt.toISOString(),
  revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
});

/**
 * Issues a key and returns the plaintext, which is never recoverable afterwards.
 *
 * INVARIANT: only the hash is stored. Losing a key means issuing a new one.
 */
export async function createApiKey(a: {
  userId: string;
  input: CreateApiKey;
}): Promise<CreateApiKeyResult> {
  const active = await db.apiKey.count({ where: { userId: a.userId, revokedAt: null } });

  if (active >= MAX_ACTIVE_API_KEYS) {
    throw new AppError(
      "LIMIT_EXCEEDED",
      `An account may hold ${MAX_ACTIVE_API_KEYS} keys at once. Revoke one to create another.`,
    );
  }

  const { key, hashedKey } = mintApiKey();

  const row = await db.apiKey.create({
    data: {
      userId: a.userId,
      name: a.input.name,
      hashedKey,
      rateLimitPerMinute: a.input.rateLimitPerMinute ?? null,
      rateLimitPerDay: a.input.rateLimitPerDay ?? null,
      expiresAt: a.input.expiresAt ? new Date(a.input.expiresAt) : null,
    },
    select: keySelect,
  });

  return { apiKey: toApiKeyDTO(row), key };
}

export async function listApiKeys(userId: string): Promise<ApiKeysPage> {
  const rows = await db.apiKey.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: keySelect,
  });

  return { apiKeys: rows.map(toApiKeyDTO) };
}

/**
 * Revokes a key the caller owns. Revoked rather than deleted, so a log line naming a key that
 * later turned out to be leaked still resolves to something.
 */
export async function revokeApiKey(a: { userId: string; apiKeyId: string }): Promise<void> {
  const { count } = await db.apiKey.updateMany({
    where: { id: a.apiKeyId, userId: a.userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  if (count === 0) throw new AppError("NOT_FOUND", "That API key does not exist.");
}
