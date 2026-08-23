import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signAssembly, usagePeriod } from "@/lib/transloadit";

const KEY = "test-key";
const SECRET = "test-secret";
const EXPIRES = new Date("2026-08-23T12:00:00.000Z");

describe("signAssembly", () => {
  it("signs the exact params string with HMAC-SHA384, prefixed with the algorithm", () => {
    const { params, signature } = signAssembly({ key: KEY, secret: SECRET, expiresAt: EXPIRES });

    const expected = `sha384:${createHmac("sha384", SECRET).update(params).digest("hex")}`;
    expect(signature).toBe(expected);
  });

  it("builds single-file inline instructions with auth key, ISO expiry and a nonce", () => {
    const { params } = signAssembly({
      key: KEY,
      secret: SECRET,
      expiresAt: EXPIRES,
      nonce: "fixed-nonce",
    });

    expect(JSON.parse(params)).toEqual({
      auth: { key: KEY, expires: "2026-08-23T12:00:00.000Z", nonce: "fixed-nonce" },
      steps: { ":original": { robot: "/upload/handle" } },
      num_expected_upload_files: 1,
    });
  });

  it("is deterministic for a fixed nonce, and unique nonces make unique signatures", () => {
    const args = { key: KEY, secret: SECRET, expiresAt: EXPIRES };

    const a = signAssembly({ ...args, nonce: "n1" });
    const b = signAssembly({ ...args, nonce: "n1" });
    const c = signAssembly({ ...args });
    const d = signAssembly({ ...args });

    expect(a).toEqual(b);
    expect(c.signature).not.toBe(d.signature);
  });
});

describe("usagePeriod", () => {
  it("buckets by UTC calendar month", () => {
    expect(usagePeriod(new Date("2026-08-23T18:30:00.000Z"))).toBe("2026-08");
    expect(usagePeriod(new Date("2026-09-01T00:00:00.000Z"))).toBe("2026-09");
  });
});
