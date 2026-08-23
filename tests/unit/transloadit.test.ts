import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CreateAttachment } from "@/contracts";
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

describe("CreateAttachment result url", () => {
  const report = (url: string) => ({
    assemblyId: "a1",
    status: "ready" as const,
    file: { name: "shot.png", contentType: "image/png", size: 1024, url },
  });

  const accepts = (url: string) => CreateAttachment.safeParse(report(url)).success;

  it("accepts the provider's own result hosts", () => {
    expect(accepts("https://tmp.transloadit.com/view/photo.png")).toBe(true);
    expect(accepts("https://cdn.transloadit.com/fixtures/poster.png")).toBe(true);
    expect(accepts("https://transloadit.com/x.png")).toBe(true);
  });

  it("rejects any other origin, however it is dressed up", () => {
    expect(accepts("https://cdn.evil.com/x.png")).toBe(false);
    // Userinfo: the real host is `evil.com`, and a substring match would have passed this.
    expect(accepts("https://tmp.transloadit.com@evil.com/x.png")).toBe(false);
    // Suffix that merely ends in the host's characters, not in the host.
    expect(accepts("https://tmp.transloadit.com.evil.com/x.png")).toBe(false);
    expect(accepts("http://tmp.transloadit.com/x.png")).toBe(false);
  });

  it("still requires a ready report to carry a url at all", () => {
    const file = { name: "shot.png", contentType: "image/png", size: 1024 };
    expect(CreateAttachment.safeParse({ assemblyId: "a1", status: "ready", file }).success).toBe(
      false,
    );
  });
});
