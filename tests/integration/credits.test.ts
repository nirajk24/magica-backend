import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { uuidv7 } from "@/lib/ids";
import {
  chargeTool,
  getBalance,
  grantSignupCredits,
  refundAdmission,
  reconcileToolCharge,
  refundToolCharge,
  reserveAdmission,
  sumLedger,
  topUp,
} from "@/lib/credits";

const ADMISSION = env.ADMISSION_CREDITS;
const TOOL_COST = 210_720n;

let userId: string;
const created: string[] = [];

/** Funds through the ledger; setting `creditBalance` directly would seed a broken invariant. */
async function seedUser(balance: bigint) {
  const id = `test_${uuidv7()}`;
  created.push(id);
  await db.user.create({ data: { id, email: `${id}@test.local` } });

  if (balance > 0n) {
    await db.$transaction((tx) => topUp(tx, { userId: id, amount: balance, key: id }));
  }

  return id;
}

/** The only assertion that matters: the cached balance still equals the ledger it summarises. */
async function expectInvariant(id: string) {
  const [balance, ledger] = await Promise.all([getBalance(id), sumLedger(id)]);
  expect(balance, "balance must equal SUM(ledger)").toBe(ledger);
  return balance;
}

beforeEach(async () => {
  userId = await seedUser(10_000_000n);
});

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
});

describe("credits ledger", () => {
  it("keeps balance === SUM(ledger) across reserve, charge and refunds", async () => {
    const runId = uuidv7();
    const invocationId = uuidv7();

    await db.$transaction((tx) => reserveAdmission(tx, { userId, runId }));
    expect(await expectInvariant(userId)).toBe(10_000_000n - ADMISSION);

    await db.$transaction((tx) =>
      chargeTool(tx, { userId, invocationId, runId, amount: TOOL_COST }),
    );
    expect(await expectInvariant(userId)).toBe(10_000_000n - ADMISSION - TOOL_COST);

    await db.$transaction((tx) => refundAdmission(tx, { userId, runId }));

    const balance = await expectInvariant(userId);
    expect(balance, "net cost of a turn is the tool charge alone").toBe(
      10_000_000n - TOOL_COST,
    );
  });

  it("holds and returns an admission on every attempt, not just the first", async () => {
    const runId = uuidv7();
    const start = 10_000_000n;

    const first = await db.$transaction((tx) =>
      reserveAdmission(tx, { userId, runId, attempt: 1 }),
    );
    expect(first, "attempt 1 applied").toBe(true);
    expect(await expectInvariant(userId)).toBe(start - ADMISSION);

    await db.$transaction((tx) => refundAdmission(tx, { userId, runId }));
    expect(await expectInvariant(userId)).toBe(start);

    const second = await db.$transaction((tx) =>
      reserveAdmission(tx, { userId, runId, attempt: 2 }),
    );
    expect(second, "a retry must take a real hold, or it can never be refused for credits").toBe(
      true,
    );
    expect(await expectInvariant(userId), "the hold actually moved the balance").toBe(
      start - ADMISSION,
    );

    // The mirror half: the retry's terminal refund must fire, and must not re-refund attempt 1.
    await db.$transaction((tx) => refundAdmission(tx, { userId, runId }));
    expect(await expectInvariant(userId), "one turn, two attempts, nothing left held").toBe(start);

    const rows = await db.creditLedgerEntry.findMany({
      where: { runId },
      select: { idempotencyKey: true },
      orderBy: { idempotencyKey: "asc" },
    });
    expect(rows.map((r) => r.idempotencyKey)).toEqual([
      `refund:reserve:${runId}:1`,
      `refund:reserve:${runId}:2`,
      `reserve:${runId}:1`,
      `reserve:${runId}:2`,
    ]);
  });

  it("refunds a hold written under the pre-attempt key format", async () => {
    const runId = uuidv7();
    const start = 10_000_000n;

    // What every run created before the key carried an attempt looks like on disk.
    await db.$executeRaw`
      INSERT INTO "CreditLedgerEntry" ("id", "userId", "type", "amount", "idempotencyKey", "runId")
      VALUES (${uuidv7()}, ${userId}, 'reserve'::"LedgerEntryType", ${-ADMISSION}, ${`reserve:${runId}`}, ${runId})`;
    await db.$executeRaw`
      UPDATE "User" SET "creditBalance" = "creditBalance" - ${ADMISSION} WHERE "id" = ${userId}`;
    expect(await expectInvariant(userId)).toBe(start - ADMISSION);

    await db.$transaction((tx) => refundAdmission(tx, { userId, runId }));

    expect(
      await expectInvariant(userId),
      "reading the ledger rather than rebuilding a key is what makes this work",
    ).toBe(start);
  });

  it("treats a replayed charge as a no-op instead of charging twice", async () => {
    const runId = uuidv7();
    const invocationId = uuidv7();
    const args = { userId, invocationId, runId, amount: TOOL_COST };

    const first = await db.$transaction((tx) => chargeTool(tx, args));
    const second = await db.$transaction((tx) => chargeTool(tx, args));

    expect(first, "first application").toBe(true);
    expect(second, "replay must report that it did nothing").toBe(false);

    expect(await expectInvariant(userId)).toBe(10_000_000n - TOOL_COST);
    await expect(
      db.creditLedgerEntry.count({ where: { idempotencyKey: `charge:${invocationId}` } }),
    ).resolves.toBe(1);
  });

  it("cannot drive the balance negative, and leaves no ledger row behind", async () => {
    const poor = await seedUser(1_000n);
    const runId = uuidv7();
    const invocationId = uuidv7();

    await expect(
      db.$transaction((tx) =>
        chargeTool(tx, { userId: poor, invocationId, runId, amount: TOOL_COST }),
      ),
    ).rejects.toThrow(/Not enough credits/);

    expect(await getBalance(poor)).toBe(1_000n);
    await expect(
      db.creditLedgerEntry.count({ where: { idempotencyKey: `charge:${invocationId}` } }),
    ).resolves.toBe(0);
    await expectInvariant(poor);
  });

  it("refunds exactly what was charged, and refunds only once", async () => {
    const runId = uuidv7();
    const invocationId = uuidv7();

    await db.$transaction((tx) =>
      chargeTool(tx, { userId, invocationId, runId, amount: TOOL_COST }),
    );
    const first = await db.$transaction((tx) =>
      refundToolCharge(tx, { userId, invocationId, runId }),
    );
    const second = await db.$transaction((tx) =>
      refundToolCharge(tx, { userId, invocationId, runId }),
    );

    expect(first).toBe(true);
    expect(second, "a second refund must not pay out again").toBe(false);
    expect(await expectInvariant(userId)).toBe(10_000_000n);
  });

  it("does nothing when reversing a charge that never landed", async () => {
    const applied = await db.$transaction((tx) =>
      refundToolCharge(tx, { userId, invocationId: uuidv7(), runId: uuidv7() }),
    );

    expect(applied).toBe(false);
    expect(await expectInvariant(userId)).toBe(10_000_000n);
  });

  it("grants signup credits once per user", async () => {
    const fresh = await seedUser(0n);

    expect(await db.$transaction((tx) => grantSignupCredits(tx, { userId: fresh }))).toBe(true);
    expect(await db.$transaction((tx) => grantSignupCredits(tx, { userId: fresh }))).toBe(false);

    expect(await expectInvariant(fresh)).toBe(env.SIGNUP_GRANT_CREDITS);
  });

  it("keeps the invariant through a top-up", async () => {
    await db.$transaction((tx) => topUp(tx, { userId, amount: 5_000n, key: uuidv7() }));
    expect(await expectInvariant(userId)).toBe(10_005_000n);
  });
});

describe("reconciling a charge to the provider's real cost", () => {
  async function chargedRun(amount = TOOL_COST) {
    const runId = uuidv7();
    const invocationId = uuidv7();
    await db.$transaction((tx) => chargeTool(tx, { userId, invocationId, runId, amount }));
    return { runId, invocationId };
  }

  it("collects the shortfall when the real cost is higher", async () => {
    const { runId, invocationId } = await chargedRun();
    const actual = TOOL_COST + 1_000n;

    const delta = await db.$transaction((tx) =>
      reconcileToolCharge(tx, { userId, invocationId, runId, actual }),
    );

    expect(delta).toBe(1_000n);
    expect(await expectInvariant(userId)).toBe(10_000_000n - actual);
  });

  it("returns the overcharge when the real cost is lower", async () => {
    const { runId, invocationId } = await chargedRun();
    const actual = TOOL_COST - 10_000n;

    const delta = await db.$transaction((tx) =>
      reconcileToolCharge(tx, { userId, invocationId, runId, actual }),
    );

    expect(delta).toBe(-10_000n);
    expect(await expectInvariant(userId)).toBe(10_000_000n - actual);
  });

  it("ignores creditUsed of 0, which means pre-settle and not free", async () => {
    const { runId, invocationId } = await chargedRun();

    const delta = await db.$transaction((tx) =>
      reconcileToolCharge(tx, { userId, invocationId, runId, actual: 0n }),
    );

    expect(delta).toBeNull();
    expect(await expectInvariant(userId), "the original charge must stand").toBe(
      10_000_000n - TOOL_COST,
    );
  });

  it("posts nothing when the estimate was exact", async () => {
    const { runId, invocationId } = await chargedRun();

    const delta = await db.$transaction((tx) =>
      reconcileToolCharge(tx, { userId, invocationId, runId, actual: TOOL_COST }),
    );

    expect(delta).toBeNull();
    expect(await expectInvariant(userId)).toBe(10_000_000n - TOOL_COST);
  });

  it("reconciles at most once", async () => {
    const { runId, invocationId } = await chargedRun();
    const actual = TOOL_COST + 5_000n;
    const args = { userId, invocationId, runId, actual };

    const first = await db.$transaction((tx) => reconcileToolCharge(tx, args));
    const second = await db.$transaction((tx) => reconcileToolCharge(tx, args));

    expect(first).toBe(5_000n);
    expect(second, "a replay must not collect twice").toBeNull();
    expect(await expectInvariant(userId)).toBe(10_000_000n - actual);
  });

  it("does not drive the balance negative to collect a shortfall", async () => {
    const poor = await seedUser(TOOL_COST);
    const runId = uuidv7();
    const invocationId = uuidv7();
    await db.$transaction((tx) =>
      chargeTool(tx, { userId: poor, invocationId, runId, amount: TOOL_COST }),
    );

    await expect(
      db.$transaction((tx) =>
        reconcileToolCharge(tx, {
          userId: poor,
          invocationId,
          runId,
          actual: TOOL_COST * 2n,
        }),
      ),
    ).rejects.toThrow(/Not enough credits/);

    expect(await getBalance(poor), "balance stays at zero, never below").toBe(0n);
    await expectInvariant(poor);
  });

  it("has nothing to reconcile for a charge that never landed", async () => {
    const delta = await db.$transaction((tx) =>
      reconcileToolCharge(tx, {
        userId,
        invocationId: uuidv7(),
        runId: uuidv7(),
        actual: 500n,
      }),
    );

    expect(delta).toBeNull();
  });
});
