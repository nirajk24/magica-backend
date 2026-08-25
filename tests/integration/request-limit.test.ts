import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { uuidv7 } from "@/lib/ids";
import { AppError } from "@/lib/errors";
import { assertRequestAllowance, recordRequestUsage } from "@/lib/rate-limit";

const created: string[] = [];

async function seedUser(dailyRequestLimit?: number) {
  const id = `test_${uuidv7()}`;
  created.push(id);
  await db.user.create({ data: { id, email: `${id}@test.local`, dailyRequestLimit } });

  return id;
}

const allow = (userId: string, perUserPerDay = 60, globalPerDay = 800) =>
  assertRequestAllowance({ userId, perUserPerDay, globalPerDay });

/** The shared bucket is one row for the whole deployment, so a test that fills it poisons the next. */
beforeEach(async () => {
  await db.sendRateLimit.deleteMany({ where: { userId: "openrouter" } });
});

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: created } } });
  await db.sendRateLimit.deleteMany({ where: { userId: { in: [...created, "openrouter"] } } });
  await db.$disconnect();
});

describe("the daily model-request ceiling", () => {
  it("admits a turn while the account is under its limit", async () => {
    const userId = await seedUser();
    await recordRequestUsage({ userId, requests: 12 });

    await expect(allow(userId)).resolves.toBeUndefined();
  });

  /**
   * Requests, not messages: a question is one and a plan-driven turn is up to MAX_TURNS × MAX_STEPS,
   * so a message cap lets the expensive user through and stops the cheap one.
   */
  it("refuses once the account has spent its day, with the reset time attached", async () => {
    const userId = await seedUser();
    await recordRequestUsage({ userId, requests: 60 });

    const error = await allow(userId).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("RATE_LIMITED");
    expect((error as AppError).message).toMatch(/today's limit/i);
    expect((error as AppError).retryAfterSeconds, "an invisible wall reads as broken").toBeGreaterThan(0);
  });

  it("lets a per-account override raise the ceiling", async () => {
    const userId = await seedUser(200);
    await recordRequestUsage({ userId, requests: 60 });

    await expect(allow(userId, 200)).resolves.toBeUndefined();
  });

  it("refuses everyone once the shared budget is gone, whatever any account has left", async () => {
    const userId = await seedUser();
    await recordRequestUsage({ userId: await seedUser(), requests: 800 });

    const error = await allow(userId).catch((e: unknown) => e);

    expect((error as AppError).message).toMatch(/reached its limit for today/i);
  });

  it("counts a turn once against the account and once against everyone", async () => {
    const userId = await seedUser();
    await recordRequestUsage({ userId, requests: 5 });
    await recordRequestUsage({ userId, requests: 7 });

    await expect(allow(userId, 12)).rejects.toThrow(/today's limit/i);
  });
});
