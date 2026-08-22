import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { recordRateLimit, readLlmStatus } from "@/lib/llm-status";

const MODEL = "nvidia/nemotron-3-super-120b-a12b:free";

/** The table is a single shared row, so each test starts from a known one rather than a fresh id. */
beforeEach(async () => {
  await db.llmStatus.deleteMany({});
});

afterAll(async () => {
  await db.llmStatus.deleteMany({});
  await db.$disconnect();
});

describe("llm status", () => {
  it("reads clear when nothing has been recorded", async () => {
    await expect(readLlmStatus()).resolves.toEqual({
      lastRoutedModel: null,
      rateLimitedUntil: null,
    });
  });

  it("records a cooldown from the provider's Retry-After", async () => {
    const now = 1_800_000_000_000;
    await recordRateLimit({ modelId: MODEL, retryAfterSeconds: 45, now: () => now });

    const status = await readLlmStatus(() => now);
    expect(status.lastRoutedModel).toBe(MODEL);
    expect(status.rateLimitedUntil).toBe(new Date(now + 45_000).toISOString());
  });

  it("falls back to a default cooldown, which is what free models actually send", async () => {
    const now = 1_800_000_000_000;
    await recordRateLimit({ modelId: MODEL, now: () => now });

    const status = await readLlmStatus(() => now);
    expect(status.rateLimitedUntil).toBe(new Date(now + 60_000).toISOString());
  });

  it("reads clear again once the cooldown has elapsed, so no client compares clocks", async () => {
    const now = 1_800_000_000_000;
    await recordRateLimit({ modelId: MODEL, retryAfterSeconds: 30, now: () => now });

    const status = await readLlmStatus(() => now + 31_000);
    expect(status.rateLimitedUntil, "elapsed reads as clear, not as a stale timestamp").toBeNull();
    expect(status.lastRoutedModel, "which model was in play still stands").toBe(MODEL);
  });

  it("is an upsert, so repeated limits move the cooldown instead of failing", async () => {
    const now = 1_800_000_000_000;
    await recordRateLimit({ modelId: MODEL, retryAfterSeconds: 10, now: () => now });
    await recordRateLimit({ modelId: "google/gemma-4-31b-it:free", retryAfterSeconds: 90, now: () => now });

    const status = await readLlmStatus(() => now);
    expect(status.lastRoutedModel).toBe("google/gemma-4-31b-it:free");
    expect(status.rateLimitedUntil).toBe(new Date(now + 90_000).toISOString());
    await expect(db.llmStatus.count()).resolves.toBe(1);
  });
});
