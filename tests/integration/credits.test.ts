import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { uuidv7 } from "@/lib/ids";
import {
  chargeTool,
  getBalance,
  grantSignupCredits,
  refundAdmission,
  refundToolCharge,
  reserveAdmission,
  sumLedger,
  topUp,
} from "@/lib/credits";

const ADMISSION = env.ADMISSION_CREDITS;
const TOOL_COST = 210_720n;

let userId: string;
const created: string[] = [];

/**
 * Funds through the ledger rather than writing `creditBalance` directly. Setting the column by
 * hand would seed a user who already violates `balance === SUM(ledger)`, so every assertion
 * would be measured against a broken starting point — and there is no legitimate path in the
 * app that produces a balance with no rows behind it.
 */
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
