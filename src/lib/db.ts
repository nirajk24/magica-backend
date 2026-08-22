import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { env } from "@/lib/env";

const globalForDb = globalThis as unknown as { db?: PrismaClient };

function createClient(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL, max: 5 }),
  });
}

/**
 * Shared Prisma client. Uses the pooled Neon URL with a small per-process pool because
 * serverless multiplies processes; migrations use `directUrl` instead. The same instance
 * serves Next.js route handlers and Trigger.dev tasks — both are Node.
 */
export const db = globalForDb.db ?? createClient();

if (env.NODE_ENV !== "production") globalForDb.db = db;

export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
