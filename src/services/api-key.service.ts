import type { ApiKeyDTO, ApiKeysPage, CreateApiKeyResult } from "@/contracts";
import { fingerprintOf, mintApiKey } from "@/lib/api-keys";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";

const toApiKeyDTO = (row: {
  id: string;
  name: string;
  hashedKey: string;
  createdAt: Date;
  revokedAt: Date | null;
}): ApiKeyDTO => ({
  id: row.id,
  name: row.name,
  fingerprint: fingerprintOf(row.hashedKey),
  createdAt: row.createdAt.toISOString(),
  revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
});

/**
 * Issues a key and returns the plaintext, which is never recoverable afterwards.
 *
 * INVARIANT: only the hash is stored. Losing a key means issuing a new one.
 */
export async function createApiKey(a: { userId: string; name: string }): Promise<CreateApiKeyResult> {
  const { key, hashedKey } = mintApiKey();

  const row = await db.apiKey.create({
    data: { userId: a.userId, name: a.name, hashedKey },
    select: { id: true, name: true, hashedKey: true, createdAt: true, revokedAt: true },
  });

  return { apiKey: toApiKeyDTO(row), key };
}

export async function listApiKeys(userId: string): Promise<ApiKeysPage> {
  const rows = await db.apiKey.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, hashedKey: true, createdAt: true, revokedAt: true },
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
