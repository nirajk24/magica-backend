import { AppError } from "@/lib/errors";
import { uuidv7 } from "@/lib/ids";
import { env } from "@/lib/env";
import type { Tx } from "@/lib/db";
import { db } from "@/lib/db";

type EntryType = "signup_grant" | "top_up" | "reserve" | "settle" | "refund";

type EntryArgs = {
  userId: string;
  type: EntryType;
  amount: bigint;
  key: string;
  runId?: string;
  invocationId?: string;
};

/**
 * The single writer of `CreditLedgerEntry` and `User.creditBalance`. Nothing else in the
 * codebase may touch either, because the invariant `balance === SUM(ledger)` is only
 * defensible if there is exactly one place that can break it.
 *
 * Ledger row FIRST, then the balance, and the duplicate is caught by `ON CONFLICT DO NOTHING`
 * rather than by a thrown exception. Both halves of that matter:
 *
 * - Moving the balance first double-charges on retry — the decrement runs again, the insert
 *   then collides, and the caller sees success while `balance` has silently drifted.
 * - Catching a `P2002` instead aborts the enclosing Postgres transaction, so every later
 *   statement fails with "current transaction is aborted". `reserveAdmission` runs inside the
 *   send route's transaction alongside the message and run inserts, which would have taken the
 *   whole send down.
 *
 * Insert-first inverts both: the unique index decides whether this is the first application,
 * the row count reports it without raising, and the balance only moves when the ledger grew.
 * A crash between the two statements can therefore only understate the cache, which is
 * recomputable — never a phantom charge.
 *
 * INVARIANT FOR CALLERS: a debit that cannot be covered throws `INSUFFICIENT_CREDITS` after
 * the ledger row is already inserted. Callers that intend to CATCH that error must have called
 * this inside a transaction they then roll back, or the row survives with no matching balance
 * move. The tool wrapper does exactly that — it charges in its own short transaction so the
 * rollback is scoped to the charge.
 *
 * @returns true if this call applied the entry, false if it was a replay of an existing key.
 */
async function entry(tx: Tx, { userId, type, amount, key, runId, invocationId }: EntryArgs) {
  const inserted = await tx.$executeRaw`
    INSERT INTO "CreditLedgerEntry" ("id", "userId", "type", "amount", "idempotencyKey", "runId", "invocationId")
    VALUES (${uuidv7()}, ${userId}, ${type}::"LedgerEntryType", ${amount}, ${key}, ${runId ?? null}, ${invocationId ?? null})
    ON CONFLICT ("idempotencyKey") DO NOTHING`;

  if (inserted === 0) return false;

  if (amount < 0n) {
    const moved = await tx.$executeRaw`
      UPDATE "User"
      SET "creditBalance" = "creditBalance" + ${amount}, "updatedAt" = now()
      WHERE "id" = ${userId} AND "creditBalance" >= ${-amount}`;

    if (moved === 0) {
      throw new AppError("INSUFFICIENT_CREDITS", "Not enough credits to continue.");
    }
  } else {
    await tx.$executeRaw`
      UPDATE "User"
      SET "creditBalance" = "creditBalance" + ${amount}, "updatedAt" = now()
      WHERE "id" = ${userId}`;
  }

  return true;
}

/**
 * Fixed hold taken when a turn is admitted, inside the send route's transaction so a rejected
 * send leaves no trace. It is ALWAYS refunded in full at terminal, which is what makes the net
 * cost of a turn equal the sum of its tool charges — the earlier reserve/settle/refund-remainder
 * model double-charged.
 */
export function reserveAdmission(tx: Tx, a: { userId: string; runId: string }) {
  return entry(tx, {
    userId: a.userId,
    type: "reserve",
    amount: -env.ADMISSION_CREDITS,
    key: `reserve:${a.runId}`,
    runId: a.runId,
  });
}

export function refundAdmission(tx: Tx, a: { userId: string; runId: string }) {
  return reverse(tx, {
    userId: a.userId,
    chargedKey: `reserve:${a.runId}`,
    refundKey: `refund:reserve:${a.runId}`,
    runId: a.runId,
  });
}

/**
 * Charged BEFORE the tool executes, so mid-turn exhaustion is caught before an external cost is
 * incurred and there is never a late-settle race. Keyed on the invocation, so a replayed step
 * charges once.
 */
export function chargeTool(
  tx: Tx,
  a: { userId: string; invocationId: string; runId: string; amount: bigint },
) {
  return entry(tx, {
    userId: a.userId,
    type: "settle",
    amount: -a.amount,
    key: `charge:${a.invocationId}`,
    runId: a.runId,
    invocationId: a.invocationId,
  });
}

export function refundToolCharge(
  tx: Tx,
  a: { userId: string; invocationId: string; runId: string },
) {
  return reverse(tx, {
    userId: a.userId,
    chargedKey: `charge:${a.invocationId}`,
    refundKey: `refund:charge:${a.invocationId}`,
    runId: a.runId,
    invocationId: a.invocationId,
  });
}

/**
 * Reverses an earlier debit by reading the amount actually recorded, never by re-deriving it.
 * A failed tool must give back exactly what it took: re-estimating could refund more than was
 * charged, and an estimator whose inputs changed would refund a different number entirely.
 * A debit that never landed has nothing to reverse, so this is a no-op.
 */
async function reverse(
  tx: Tx,
  a: {
    userId: string;
    chargedKey: string;
    refundKey: string;
    runId?: string;
    invocationId?: string;
  },
) {
  const charged = await tx.creditLedgerEntry.findUnique({
    where: { idempotencyKey: a.chargedKey },
    select: { amount: true },
  });

  if (!charged) return false;

  return entry(tx, {
    userId: a.userId,
    type: "refund",
    amount: -charged.amount,
    key: a.refundKey,
    runId: a.runId,
    invocationId: a.invocationId,
  });
}

/**
 * Granted on a user's first authenticated request rather than by the Clerk webhook, so a
 * missing or delayed webhook cannot leave an account unable to do anything.
 */
export function grantSignupCredits(tx: Tx, a: { userId: string }) {
  return entry(tx, {
    userId: a.userId,
    type: "signup_grant",
    amount: env.SIGNUP_GRANT_CREDITS,
    key: `signup_grant:${a.userId}`,
  });
}

export function topUp(tx: Tx, a: { userId: string; amount: bigint; key: string }) {
  return entry(tx, {
    userId: a.userId,
    type: "top_up",
    amount: a.amount,
    key: `top_up:${a.key}`,
  });
}

export async function getBalance(userId: string): Promise<bigint> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { creditBalance: true },
  });
  return user.creditBalance;
}

/** The authoritative figure. `User.creditBalance` is a cache of this and is asserted against it. */
export async function sumLedger(userId: string): Promise<bigint> {
  const { _sum } = await db.creditLedgerEntry.aggregate({
    where: { userId },
    _sum: { amount: true },
  });
  return _sum.amount ?? 0n;
}
