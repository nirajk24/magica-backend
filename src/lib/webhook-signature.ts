import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SECRET_PREFIX = "whsec_";

export type SignatureHeaders = {
  "svix-id": string;
  "svix-timestamp": string;
  "svix-signature": string;
};

export const mintWebhookSecret = () => `${SECRET_PREFIX}${randomBytes(24).toString("base64url")}`;

/**
 * Signs one delivery, mirroring the Svix scheme the Magica platform itself uses: HMAC-SHA256 over
 * `{id}.{timestamp}.{body}`, base64, announced as `v1,<sig>` alongside the id and timestamp.
 *
 * INVARIANT: the timestamp and id are inside the signed string, so a captured delivery cannot be
 * replayed with a fresh timestamp, and the body cannot be swapped between deliveries.
 */
export function signWebhook(a: {
  id: string;
  secret: string;
  body: string;
  timestamp: Date;
}): SignatureHeaders {
  const seconds = Math.floor(a.timestamp.getTime() / 1000).toString();
  const signed = `${a.id}.${seconds}.${a.body}`;
  const key = Buffer.from(a.secret.replace(SECRET_PREFIX, ""), "base64url");

  return {
    "svix-id": a.id,
    "svix-timestamp": seconds,
    "svix-signature": `v1,${createHmac("sha256", key).update(signed).digest("base64")}`,
  };
}

/**
 * Verifies a delivery the way a receiver should, which is what the docs' sample code does.
 * Exported so our own tests check the signature the same way a customer's server would.
 */
export function verifyWebhook(a: {
  secret: string;
  body: string;
  headers: SignatureHeaders;
}): boolean {
  const expected = signWebhook({
    id: a.headers["svix-id"],
    secret: a.secret,
    body: a.body,
    timestamp: new Date(Number(a.headers["svix-timestamp"]) * 1000),
  });

  const left = Buffer.from(expected["svix-signature"]);
  const right = Buffer.from(a.headers["svix-signature"]);

  return left.length === right.length && timingSafeEqual(left, right);
}
