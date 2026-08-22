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
 * `defineRoute` calls it before every handler, so no route has to check the account exists.
 *
 * INVARIANT: idempotent under concurrency and after a crash — the grant, not the row, is what the
 * next call tests, so a process that dies between the two writes repairs itself.
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
