import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bearerApiKey, fingerprintOf, mintApiKey } from "@/lib/api-keys";
import { mintWebhookSecret, signWebhook, verifyWebhook } from "@/lib/webhook-signature";

const headersWith = (authorization: string) => new Headers({ authorization });

describe("API keys", () => {
  it("returns a prefixed key and stores only its SHA-256 hash", () => {
    const { key, hashedKey } = mintApiKey();

    expect(key.startsWith("mk_live_")).toBe(true);
    expect(hashedKey).toBe(createHash("sha256").update(key).digest("hex"));
    expect(hashedKey, "the plaintext must not be derivable from what is stored").not.toContain(
      key.replace("mk_live_", ""),
    );
  });

  it("mints a distinct key every time", () => {
    const keys = new Set(Array.from({ length: 50 }, () => mintApiKey().key));

    expect(keys.size).toBe(50);
  });

  it("fingerprints the hash, never the key", () => {
    const { key, hashedKey } = mintApiKey();
    const fingerprint = fingerprintOf(hashedKey);

    expect(hashedKey.startsWith(fingerprint)).toBe(true);
    expect(key).not.toContain(fingerprint);
  });

  it("reads a bearer key and rejects anything not shaped like ours", () => {
    const { key } = mintApiKey();

    expect(bearerApiKey(headersWith(`Bearer ${key}`))).toBe(key);
    expect(bearerApiKey(headersWith(`bearer ${key}`)), "scheme is case-insensitive").toBe(key);
    expect(bearerApiKey(headersWith(key)), "no scheme").toBeNull();
    expect(bearerApiKey(headersWith("Bearer sk-or-v1-something")), "wrong prefix").toBeNull();
    expect(bearerApiKey(headersWith(`Bearer ${key}extra`)), "wrong length").toBeNull();
    expect(bearerApiKey(new Headers()), "no header at all").toBeNull();
  });
});

describe("webhook signatures", () => {
  const secret = mintWebhookSecret();
  const body = JSON.stringify({ type: "agent.completed", data: { runId: "run_1" } });
  const timestamp = new Date("2026-08-23T12:00:00.000Z");

  it("signs with the svix header trio a receiver expects", () => {
    const headers = signWebhook({ id: "evt_1", secret, body, timestamp });

    expect(headers["svix-id"]).toBe("evt_1");
    expect(headers["svix-timestamp"]).toBe(String(timestamp.getTime() / 1000));
    expect(headers["svix-signature"]).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
  });

  it("verifies its own signature the way a receiver would", () => {
    const headers = signWebhook({ id: "evt_1", secret, body, timestamp });

    expect(verifyWebhook({ secret, body, headers })).toBe(true);
  });

  it("rejects a tampered body, a swapped id, a replayed timestamp and a wrong secret", () => {
    const headers = signWebhook({ id: "evt_1", secret, body, timestamp });

    expect(verifyWebhook({ secret, body: `${body} `, headers })).toBe(false);
    expect(verifyWebhook({ secret, body, headers: { ...headers, "svix-id": "evt_2" } })).toBe(false);
    expect(
      verifyWebhook({ secret, body, headers: { ...headers, "svix-timestamp": "1787486999" } }),
      "the timestamp is inside the signed string, so a replay cannot be re-stamped",
    ).toBe(false);
    expect(verifyWebhook({ secret: mintWebhookSecret(), body, headers })).toBe(false);
  });

  it("gives two endpoints different secrets", () => {
    expect(mintWebhookSecret()).not.toBe(mintWebhookSecret());
  });

  /**
   * The published verification snippet, retyped from `docs-site/webhooks.mdx` rather than
   * imported. Every other schema in the docs is generated from a contract; this one is prose, so
   * this test is what stops it drifting from the signature we actually send.
   */
  it("is verifiable by the snippet the documentation publishes", () => {
    const documentedVerify = (
      docSecret: string,
      docBody: string,
      docHeaders: Record<string, string>,
    ) => {
      const key = Buffer.from(docSecret.replace("whsec_", ""), "base64url");
      const signed = `${docHeaders["svix-id"]}.${docHeaders["svix-timestamp"]}.${docBody}`;
      const expected = `v1,${createHmac("sha256", key).update(signed).digest("base64")}`;

      return expected === docHeaders["svix-signature"];
    };

    const headers = signWebhook({ id: "evt_1", secret, body, timestamp });

    expect(documentedVerify(secret, body, headers)).toBe(true);
    expect(documentedVerify(secret, `${body} `, headers)).toBe(false);
  });
});
