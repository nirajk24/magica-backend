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

/** The `UploadUsage` bucket key: the UTC calendar month, e.g. "2026-08". */
export function usagePeriod(now: Date): string {
  return now.toISOString().slice(0, 7);
}
