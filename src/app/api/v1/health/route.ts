import { definePublicRoute, preflight } from "@/lib/api";
import type { Health } from "@/contracts";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

export const GET = definePublicRoute({
  handler: async (): Promise<Health> => {
    const started = Date.now();
    await db.$queryRaw`SELECT 1`;

    return { ok: true, env: env.NODE_ENV, dbLatencyMs: Date.now() - started };
  },
});

export const OPTIONS = preflight;
