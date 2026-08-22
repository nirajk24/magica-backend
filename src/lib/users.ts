import { currentUser } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { grantSignupCredits, hasSignupGrant } from "@/lib/credits";

const bootstrapped = new Set<string>();

export type EmailResolver = (userId: string) => Promise<string>;

const emailFromClerk: EmailResolver = async (userId) => {
  const user = await currentUser();
  return user?.primaryEmailAddress?.emailAddress ?? `${userId}@users.magica.local`;
};

/**
 * Creates the local `User` row for an authenticated Clerk id and grants its signup credits.
 * `defineRoute` calls it before every handler, so no route has to check whether the account exists
 * and the Clerk webhook stays a bonus rather than a prerequisite.
 *
 * INVARIANT: idempotent under concurrency and after a crash. Both writes absorb a duplicate — the
 * row through `ON CONFLICT DO NOTHING`, the grant through its ledger key — and the grant is what
 * the next call tests, so a process that dies between them repairs itself rather than leaving an
 * account stuck at a zero balance.
 *
 * Deliberately not one transaction: a transaction blocking on the row's unique index holds a pool
 * connection for the whole wait, and only the ledger write actually needs atomicity.
 */
export async function ensureUserWithGrant(
  userId: string,
  resolveEmail: EmailResolver = emailFromClerk,
): Promise<void> {
  if (bootstrapped.has(userId)) return;

  if (!(await hasSignupGrant(userId))) {
    const email = await resolveEmail(userId);

    await db.$executeRaw`
      INSERT INTO "User" ("id", "email") VALUES (${userId}, ${email})
      ON CONFLICT ("id") DO NOTHING`;

    await db.$transaction((tx) => grantSignupCredits(tx, { userId }));
  }

  bootstrapped.add(userId);
}

/** Drops the process cache so a test can exercise the bootstrap path more than once. */
export function forgetBootstrappedUsers(): void {
  bootstrapped.clear();
}
