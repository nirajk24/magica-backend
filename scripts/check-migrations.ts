import "dotenv/config";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/lib/db";

const MIGRATIONS = join(import.meta.dirname, "..", "prisma", "migrations");

/**
 * Compares each migration file against the checksum recorded when it was applied.
 *
 * Editing an applied migration leaves the two disagreeing. `deploy` and `status` tolerate that, so
 * it goes unnoticed until `migrate dev` refuses to run and offers to reset the database — which on
 * a production connection is the offer to delete everything. Ten of twelve had drifted before this
 * check existed.
 */
async function main(): Promise<void> {
  const applied = await db.$queryRaw<{ migration_name: string; checksum: string }[]>`
    SELECT migration_name, checksum FROM _prisma_migrations
  `;
  const byName = new Map(applied.map((row) => [row.migration_name, row.checksum]));

  const names = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(MIGRATIONS, name, "migration.sql")))
    .sort();

  const drifted: string[] = [];
  const unapplied: string[] = [];

  for (const name of names) {
    const disk = createHash("sha256")
      .update(readFileSync(join(MIGRATIONS, name, "migration.sql")))
      .digest("hex");
    const stored = byName.get(name);

    if (stored === undefined) unapplied.push(name);
    else if (stored !== disk) drifted.push(name);
  }

  await db.$disconnect();

  for (const name of drifted) console.error(`  drifted    ${name}`);
  for (const name of unapplied) console.error(`  unapplied  ${name}`);

  if (drifted.length > 0 || unapplied.length > 0) {
    console.error(
      `\ncheck-migrations: ${drifted.length} drifted, ${unapplied.length} unapplied. ` +
        "An applied migration is never edited — add a new one.",
    );
    process.exit(1);
  }

  console.log(`check-migrations: ${names.length} migrations match what was applied.`);
}

await main();
