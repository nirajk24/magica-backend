import { z } from "zod";
import type { CreditsPage } from "@/contracts";
import { defineRoute, preflight } from "@/lib/api";
import { getBalance } from "@/lib/credits";
import { db } from "@/lib/db";

const Query = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** The ledger over REST, so `balance === SUM(ledger)` is checkable without opening psql. */
export const GET = defineRoute({
  query: Query,
  handler: async ({ userId, query }): Promise<CreditsPage> => {
    const rows = await db.creditLedgerEntry.findMany({
      where: { userId, ...(query.cursor ? { createdAt: { lt: new Date(query.cursor) } } : {}) },
      orderBy: { createdAt: "desc" },
      take: query.limit + 1,
      select: { id: true, type: true, amount: true, runId: true, createdAt: true },
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      balance: (await getBalance(userId)).toString(),
      entries: page.map((entry) => ({
        id: entry.id,
        type: entry.type,
        amount: entry.amount.toString(),
        runId: entry.runId,
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: rows.length > query.limit && last ? last.createdAt.toISOString() : null,
    };
  },
});

export const OPTIONS = preflight;
