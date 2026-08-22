import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * Migrate and Studio read the connection string from here; the runtime client reads the
 * pooled URL through its adapter in `lib/db.ts`. Migrate takes an advisory lock that
 * pgBouncer drops, so this must be the UNPOOLED string.
 *
 * Resolved permissively rather than through `env()` so `prisma generate` — which needs no
 * database — still runs on a fresh clone that has no `.env` yet. Missing variables are
 * caught by name in `lib/env.ts` at application boot.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL_UNPOOLED ?? "",
  },
});
