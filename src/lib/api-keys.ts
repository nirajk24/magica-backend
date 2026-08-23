import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";

const PREFIX = "mk_live_";
const SECRET_BYTES = 24;

/**
 * A stable public identifier for a stored key, derived from its hash.
 *
 * INVARIANT: derived from the HASH, never the key. It is safe to log and to show in a list, and
 * it is not a substring of the secret.
 */
export const fingerprintOf = (hashedKey: string) => hashedKey.slice(0, 8);

/**
 * A new API key: the plaintext to show once, and the SHA-256 hash to store.
 *
 * SHA-256 rather than bcrypt on purpose. The work factor in a password hash exists to slow brute
 * force against low-entropy human secrets; this token carries 192 bits of randomness, so there is
 * nothing to brute-force, and a slow hash would tax every authenticated request instead.
 */
export function mintApiKey(): { key: string; hashedKey: string } {
  const key = `${PREFIX}${randomBytes(SECRET_BYTES).toString("hex")}`;

  return { key, hashedKey: hashApiKey(key) };
}

const hashApiKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** Rejects anything not shaped like one of ours before it reaches the database. */
function isApiKeyFormat(key: string): boolean {
  return key.startsWith(PREFIX) && key.length === PREFIX.length + SECRET_BYTES * 2;
}

/**
 * Reads a bearer API key out of an Authorization header, or null.
 *
 * INVARIANT: format is checked here, so a malformed value never becomes a database lookup.
 */
export function bearerApiKey(headers: Headers): string | null {
  const header = headers.get("authorization") ?? "";
  const [scheme, value] = header.split(" ");

  if (scheme?.toLowerCase() !== "bearer" || !value) return null;

  return isApiKeyFormat(value) ? value : null;
}

/** Constant-time comparison for two hex digests of equal length. */
function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");

  return left.length === right.length && timingSafeEqual(left, right);
}

export type ResolvedApiKey = {
  apiKeyId: string;
  userId: string;
  perMinute: number | null;
  perDay: number | null;
};

/**
 * The account and ceilings a plaintext API key carries, or null.
 *
 * INVARIANT: the lookup is by hash — the plaintext is never stored and never compared as one. A
 * revoked or expired key resolves to null, so both take effect on the very next request.
 *
 * Lives in `lib/` rather than a service because the request pipeline authenticates with it, and a
 * `lib` module importing a service would invert the layering every other route depends on.
 */
export async function resolveApiKey(
  key: string,
  now: Date = new Date(),
): Promise<ResolvedApiKey | null> {
  const hashedKey = hashApiKey(key);

  const row = await db.apiKey.findFirst({
    where: { hashedKey, revokedAt: null },
    select: {
      id: true,
      userId: true,
      hashedKey: true,
      expiresAt: true,
      rateLimitPerMinute: true,
      rateLimitPerDay: true,
    },
  });

  if (!row || !hashesMatch(row.hashedKey, hashedKey)) return null;
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return null;

  return {
    apiKeyId: row.id,
    userId: row.userId,
    perMinute: row.rateLimitPerMinute,
    perDay: row.rateLimitPerDay,
  };
}
