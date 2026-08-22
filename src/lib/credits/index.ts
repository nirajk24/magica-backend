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
 * Applies one ledger entry and moves the cached balance. The ledger is the source of truth;
 * `User.creditBalance` is a cache of `SUM(ledger)`.
 *
 * Order is load-bearing: the row is inserted first and duplicates absorbed by `ON CONFLICT DO
 * NOTHING`, so the unique index rather than an exception decides whether this is the first
 * application. Moving the balance first double-charges on replay; catching `P2002` instead
 * aborts the caller's Postgres transaction.
 *
 * INVARIANT: an uncoverable debit throws once its ledger row already exists. A caller that
 * catches `INSUFFICIENT_CREDITS` must roll the surrounding transaction back, or the row survives
 * with no matching balance move.
 *
 * @returns true if applied, false if the key was already present.
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
 * Fixed hold taken when a turn is admitted. Call inside the admitting transaction so a rejected
 * send leaves no trace.
 *
 * INVARIANT: the key carries the attempt. A retry reuses its run row, so a key of `reserve:{runId}`
 * alone reads as already applied and the second attempt would run holding nothing — and therefore
 * could never be refused for insufficient credits.
 *
 * INVARIANT: always refunded in full at terminal, so the net cost of a turn is the sum of its
 * tool charges.
 */
export function reserveAdmission(
  tx: Tx,
  a: { userId: string; runId: string; attempt?: number },
) {
  return entry(tx, {
    userId: a.userId,
    type: "reserve",
    amount: -env.ADMISSION_CREDITS,
    key: `reserve:${a.runId}:${a.attempt ?? 1}`,
    runId: a.runId,
  });
}

/**
 * Returns every admission hold a run has taken, whichever attempt took it.
 *
 * INVARIANT: the holds are read from the ledger rather than rebuilt from a key, so a run that was
 * retried cannot leave one behind, and a hold taken under an older key format still comes back.
 */
export async function refundAdmission(tx: Tx, a: { userId: string; runId: string }) {
  const holds = await tx.creditLedgerEntry.findMany({
    where: { userId: a.userId, runId: a.runId, type: "reserve" },
    select: { idempotencyKey: true },
  });

  let refunded = false;

  for (const hold of holds) {
    const applied = await reverse(tx, {
      userId: a.userId,
      chargedKey: hold.idempotencyKey,
      refundKey: `refund:${hold.idempotencyKey}`,
      runId: a.runId,
    });

    refunded = refunded || applied;
  }

  return refunded;
}

/**
 * Charges one tool invocation. Call BEFORE executing it, so exhaustion is caught before an
 * external cost is incurred. Keyed on the invocation, so a replayed step charges once.
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
 * Adjusts a tool's charge to the cost the provider actually reported, so the ledger records real
 * spend rather than an estimate. Call once, after the tool succeeds.
 *
 * INVARIANT: only call with a figure the provider actually settled. Magica documents
 * `creditUsed: 0` as "pre-settle or free failure", so passing a zero through here would refund the
 * whole charge for work that was really paid for.
 *
 * INVARIANT: an uncollectable shortfall throws `INSUFFICIENT_CREDITS`, like any other debit. Call
 * this in its own transaction and swallow that error — the work is already done, so failing the
 * turn over a rounding delta achieves nothing, and the rollback drops the ledger row with it.
 *
 * @returns the applied delta in microcredits, or null if nothing was posted.
 */
export async function reconcileToolCharge(
  tx: Tx,
  a: { userId: string; invocationId: string; runId: string; actual: bigint },
): Promise<bigint | null> {
  if (a.actual <= 0n) return null;

  const charged = await tx.creditLedgerEntry.findUnique({
    where: { idempotencyKey: `charge:${a.invocationId}` },
    select: { amount: true },
  });

  if (!charged) return null;

  const estimate = -charged.amount;
  const delta = a.actual - estimate;
  if (delta === 0n) return null;

  const applied = await entry(tx, {
    userId: a.userId,
    type: delta > 0n ? "settle" : "refund",
    amount: -delta,
    key: `reconcile:${a.invocationId}`,
    runId: a.runId,
    invocationId: a.invocationId,
  });

  return applied ? delta : null;
}

/**
 * Reverses an earlier debit by the amount actually recorded, never a re-derived estimate.
 * A debit that never landed is a no-op.
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

const signupGrantKey = (userId: string) => `signup_grant:${userId}`;

/** Granted on first authenticated request, so a missing Clerk webhook cannot block an account. */
export function grantSignupCredits(tx: Tx, a: { userId: string }) {
  return entry(tx, {
    userId: a.userId,
    type: "signup_grant",
    amount: env.SIGNUP_GRANT_CREDITS,
    key: signupGrantKey(a.userId),
  });
}

/**
 * Whether the signup grant has already been applied. This, not the presence of a `User` row, is
 * what makes the account bootstrap idempotent: a row created by some other path is still ungranted,
 * and a crash between the two writes is repaired on the next request.
 */
export async function hasSignupGrant(userId: string): Promise<boolean> {
  const granted = await db.creditLedgerEntry.findUnique({
    where: { idempotencyKey: signupGrantKey(userId) },
    select: { id: true },
  });

  return granted !== null;
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

/** The authoritative figure `User.creditBalance` is asserted against. */
export async function sumLedger(userId: string): Promise<bigint> {
  const { _sum } = await db.creditLedgerEntry.aggregate({
    where: { userId },
    _sum: { amount: true },
  });
  return _sum.amount ?? 0n;
}
