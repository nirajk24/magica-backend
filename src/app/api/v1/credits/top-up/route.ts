import { TopUp, type TopUpResult } from "@/contracts";
import { defineRoute, preflight } from "@/lib/api";
import { getBalance, topUp } from "@/lib/credits";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";

/**
 * Adds credits to the caller's balance, keyed on the client's `Idempotency-Key` so a retried
 * request cannot grant twice.
 *
 * No payment provider sits behind this. It exists so a turn stopped by exhausted credits has a way
 * forward, and so the ledger is exercised in both directions rather than only downwards.
 */
export const POST = defineRoute({
  body: TopUp,
  handler: async ({ userId, body, headers }): Promise<TopUpResult> => {
    const key = headers.get("Idempotency-Key");
    if (!key) throw new AppError("VALIDATION_ERROR", "An Idempotency-Key header is required.");

    await db.$transaction((tx) => topUp(tx, { userId, amount: BigInt(body.amount), key }));

    return { balance: (await getBalance(userId)).toString() };
  },
});

export const OPTIONS = preflight;
