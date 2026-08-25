import "dotenv/config";
import { db } from "@/lib/db";

/**
 * Sets one account's daily model-request ceiling, or clears it back to the configured default.
 *
 *     pnpm limits:set --email someone@example.com --requests 200
 *     pnpm limits:set --email someone@example.com --default
 */
function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);

  return at === -1 ? undefined : process.argv[at + 1];
}

async function main(): Promise<void> {
  const email = arg("email");
  const requests = arg("requests");
  const toDefault = process.argv.includes("--default");

  if (!email || (!requests && !toDefault)) {
    console.error("usage: pnpm limits:set --email <email> (--requests <n> | --default)");
    process.exit(1);
  }

  const limit = toDefault ? null : Number(requests);
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
    console.error(`--requests must be a positive integer, got "${requests}"`);
    process.exit(1);
  }

  const user = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) {
    console.error(`No account with email "${email}".`);
    process.exit(1);
  }

  await db.user.update({ where: { id: user.id }, data: { dailyRequestLimit: limit } });
  console.log(`${email}: daily requests ${limit === null ? "= default" : `= ${limit}`}`);

  await db.$disconnect();
}

await main();
