import "dotenv/config";
import { db } from "@/lib/db";
import { getBalance, topUp } from "@/lib/credits";

/**
 * Adds credits to one account.
 *
 *     pnpm credits:grant --email someone@example.com --credits 5
 *
 * A script rather than an admin route: the public top-up endpoint was authenticated but unbounded,
 * and every replacement that lives on the internet needs an authorisation mechanism to get right.
 * The capability here is "can reach the database", which is the correct bar for minting currency.
 *
 * Goes through `topUp` like every other movement, so `balance === SUM(ledger)` still holds and the
 * entry is idempotency-keyed — re-running the same grant key is a no-op rather than a second grant.
 */
const MICRO = 1_000_000n;

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);

  return at === -1 ? undefined : process.argv[at + 1];
}

async function main(): Promise<void> {
  const email = arg("email");
  const credits = arg("credits");
  const key = arg("key") ?? `manual:${email}:${credits}:${arg("note") ?? Date.now()}`;

  if (!email || !credits) {
    console.error("usage: pnpm credits:grant --email <email> --credits <n> [--key <idempotency>]");
    process.exit(1);
  }

  const amount = Number(credits);
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error(`--credits must be a positive number, got "${credits}"`);
    process.exit(1);
  }

  const user = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) {
    console.error(`No account with email "${email}".`);
    process.exit(1);
  }

  const micro = BigInt(Math.round(amount * Number(MICRO)));
  await db.$transaction((tx) => topUp(tx, { userId: user.id, amount: micro, key }));

  const balance = await getBalance(user.id);
  console.log(`${email}: +${amount} → ${Number(balance) / Number(MICRO)} credits`);

  await db.$disconnect();
}

await main();
