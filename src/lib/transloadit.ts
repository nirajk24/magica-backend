import { createHmac, randomUUID } from "node:crypto";

/** Transloadit Community-plan per-file cap: 0.5 GB. */
export const PER_FILE_LIMIT_BYTES = 536_870_912;

/** Transloadit Community-plan monthly allowance: 5 GB, tracked per user in `UploadUsage`. */
export const MONTHLY_QUOTA_BYTES = 5_368_709_120n;

/** How long a signed assembly stays submittable. */
export const SIGNATURE_TTL_MS = 30 * 60 * 1000;

/** Community-plan temporary results purge after 24 hours; `Attachment.expiresAt` mirrors it. */
export const RESULT_TTL_MS = 24 * 60 * 60 * 1000;

export type SignedAssembly = { params: string; signature: string };

/**
 * Signs one single-file assembly for direct browser upload (Uppy + tus).
 *
 * The signature is an HMAC-SHA384 hex digest of the exact JSON `params` string, prefixed
 * `sha384:`, keyed with the auth secret — Transloadit's current scheme. The instructions are
 * inline (no stored template) and include `num_expected_upload_files: 1` INSIDE the signed
 * string, so one signature cannot be reused for a batch.
 *
 * INVARIANT: the returned `params` string must reach Transloadit byte-for-byte; re-serializing
 * it invalidates the signature.
 */
export function signAssembly(a: {
  key: string;
  secret: string;
  expiresAt: Date;
  nonce?: string;
}): SignedAssembly {
  const params = JSON.stringify({
    auth: {
      key: a.key,
      expires: a.expiresAt.toISOString(),
      nonce: a.nonce ?? randomUUID(),
    },
    steps: { ":original": { robot: "/upload/handle" } },
    num_expected_upload_files: 1,
  });

  const signature = `sha384:${createHmac("sha384", a.secret).update(params).digest("hex")}`;

  return { params, signature };
}

/**
 * Whether a client-reported result URL is on a host we are willing to serve as an attachment.
 *
 * Completion is reported by the browser, so without this any address can be registered as a user's
 * attachment and fed to the model. The hosts are configuration rather than a constant: what the
 * provider hands back is an account-level storage decision — this one exports to R2, not to
 * Transloadit's own temporary storage — and getting that wrong rejects every real upload.
 *
 * INVARIANT: matched on the parsed `hostname`, never the raw string. `https://host@evil.com` and
 * `https://host.evil.com` both contain the host as a substring and both resolve somewhere else.
 * An empty list allows anything, which is the documented pre-hardening behaviour.
 */
export function isAllowedResultHost(value: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;

  return allowed.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

/** The `UploadUsage` bucket key: the UTC calendar month, e.g. "2026-08". */
export function usagePeriod(now: Date): string {
  return now.toISOString().slice(0, 7);
}
