import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isAllowedResultHost, signAssembly, usagePeriod } from "@/lib/transloadit";

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

describe("isAllowedResultHost", () => {
  const HOSTS = ["r2.dev", "transloadit.com"];

  /** The real shape this account returns: Transloadit exports results to R2, not to its own storage. */
  it("accepts the host the provider actually serves results from", () => {
    expect(
      isAllowedResultHost(
        "https://pub-e8fef8c0e03b44acb340577811800829.r2.dev/5f08/ac2d/726.avif",
        HOSTS,
      ),
    ).toBe(true);
    expect(isAllowedResultHost("https://tmp.transloadit.com/view/photo.png", HOSTS)).toBe(true);
  });

  it("rejects any other origin, however it is dressed up", () => {
    expect(isAllowedResultHost("https://cdn.evil.com/x.png", HOSTS)).toBe(false);
    // Userinfo: the real host is `evil.com`, and a substring match would have passed this.
    expect(isAllowedResultHost("https://tmp.transloadit.com@evil.com/x.png", HOSTS)).toBe(false);
    // A suffix that merely ends in the host's characters, not in the host.
    expect(isAllowedResultHost("https://r2.dev.evil.com/x.png", HOSTS)).toBe(false);
    expect(isAllowedResultHost("http://tmp.transloadit.com/x.png", HOSTS)).toBe(false);
    expect(isAllowedResultHost("not a url", HOSTS)).toBe(false);
  });

  it("allows anything when no hosts are configured, which is the documented default", () => {
    expect(isAllowedResultHost("https://cdn.evil.com/x.png", [])).toBe(true);
  });
});
