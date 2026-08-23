import type { UsageCategory, UsagePage } from "@/contracts";
import { db } from "@/lib/db";
import { getTool } from "@/tools/registry";

/** How far back the overview reaches when the client names no period. */
const DEFAULT_PERIOD_DAYS = 30;

/** Newest records returned for one category's detailed view. */
const RECORDS_LIMIT = 50;

/** The ledger entries that are credit coming in rather than work being paid for. */
const ADJUSTMENT_TYPES = ["top_up", "signup_grant"] as const;

const ADJUSTMENT_LABELS: Record<string, string> = {
  top_up: "Credit top-up",
  signup_grant: "Signup grant",
};

const toolLabel = (toolName: string) =>
  getTool(toolName)?.display.label ?? toolName.replaceAll("_", " ");

const later = (a: Date | null, b: Date | null) =>
  a === null ? b : b === null ? a : a > b ? a : b;

type Settlement = { estimated: bigint | null; adjustment: bigint | null };

/**
 * How each invocation's charge settled: the estimate debited before it ran, and the reconciliation
 * against what the provider actually reported. Read from the ledger, so the detailed view shows the
 * same rows the balance is built from.
 */
async function settlementsFor(invocationIds: string[]): Promise<Map<string, Settlement>> {
  if (invocationIds.length === 0) return new Map();

  const entries = await db.creditLedgerEntry.findMany({
    where: { invocationId: { in: invocationIds } },
    select: { invocationId: true, amount: true, idempotencyKey: true },
  });

  const settlements = new Map<string, Settlement>();

  for (const entry of entries) {
    if (!entry.invocationId) continue;
    const settlement =
      settlements.get(entry.invocationId) ?? { estimated: null, adjustment: null };

    if (entry.idempotencyKey.startsWith("charge:")) settlement.estimated = -entry.amount;
    if (entry.idempotencyKey.startsWith("reconcile:")) settlement.adjustment = -entry.amount;

    settlements.set(entry.invocationId, settlement);
  }

  return settlements;
}

type Bucket = {
  key: string;
  label: string;
  kind: "tool" | "adjustment";
  debited: bigint;
  credited: bigint;
  count: number;
  latestAt: Date | null;
  records: { id: string; chatId: string | null; runId: string | null; amount: bigint; at: Date }[];
  truncated: boolean;
};

const bucket = (key: string, label: string, kind: Bucket["kind"]): Bucket => ({
  key,
  label,
  kind,
  debited: 0n,
  credited: 0n,
  count: 0,
  latestAt: null,
  records: [],
  truncated: false,
});

/**
 * Credit spend aggregated per tool, plus the credit that came in, over one period.
 *
 * Tool figures come from `ToolInvocation.creditUsed` — the settled, reconciled actuals, so the page
 * shows what was really paid rather than what was estimated. Zero-cost invocations (free tools,
 * refunded failures) are not usage and are left out. Adjustments come from the ledger.
 *
 * INVARIANT: ownership is part of every WHERE clause; nothing here can aggregate another user's
 * spend. A `category` the caller does not own simply has no rows.
 */
export async function summarizeUsage(a: {
  userId: string;
  from?: string;
  to?: string;
  category?: string;
}): Promise<UsagePage> {
  const to = a.to ? new Date(a.to) : new Date();
  const from = a.from
    ? new Date(a.from)
    : new Date(to.getTime() - DEFAULT_PERIOD_DAYS * 24 * 60 * 60 * 1000);

  const period = { gte: from, lte: to };
  const buckets = new Map<string, Bucket>();

  const invocations = await db.toolInvocation.findMany({
    where: {
      run: { userId: a.userId },
      creditUsed: { gt: 0 },
      createdAt: period,
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      toolName: true,
      creditUsed: true,
      createdAt: true,
      runId: true,
      run: { select: { chatId: true } },
    },
  });

  for (const invocation of invocations) {
    const entry =
      buckets.get(invocation.toolName) ??
      bucket(invocation.toolName, toolLabel(invocation.toolName), "tool");

    entry.debited += invocation.creditUsed;
    entry.count += 1;
    entry.latestAt = later(entry.latestAt, invocation.createdAt);

    if (invocation.toolName === a.category) {
      if (entry.records.length < RECORDS_LIMIT) {
        entry.records.push({
          id: invocation.id,
          chatId: invocation.run.chatId,
          runId: invocation.runId,
          amount: invocation.creditUsed,
          at: invocation.createdAt,
        });
      } else {
        entry.truncated = true;
      }
    }

    buckets.set(invocation.toolName, entry);
  }

  const adjustments = await db.creditLedgerEntry.findMany({
    where: { userId: a.userId, type: { in: [...ADJUSTMENT_TYPES] }, createdAt: period },
    orderBy: { createdAt: "desc" },
    select: { id: true, type: true, amount: true, runId: true, createdAt: true },
  });

  for (const adjustment of adjustments) {
    const key = adjustment.type;
    const entry = buckets.get(key) ?? bucket(key, ADJUSTMENT_LABELS[key] ?? key, "adjustment");

    entry.credited += adjustment.amount;
    entry.count += 1;
    entry.latestAt = later(entry.latestAt, adjustment.createdAt);

    if (key === a.category && entry.records.length < RECORDS_LIMIT) {
      entry.records.push({
        id: adjustment.id,
        chatId: null,
        runId: adjustment.runId,
        amount: adjustment.amount,
        at: adjustment.createdAt,
      });
    }

    buckets.set(key, entry);
  }

  const named = a.category ? buckets.get(a.category) : undefined;
  const settlements =
    named?.kind === "tool"
      ? await settlementsFor(named.records.map((record) => record.id))
      : new Map<string, Settlement>();

  const categories: UsageCategory[] = [...buckets.values()]
    .sort((x, y) => (y.debited > x.debited ? 1 : y.debited < x.debited ? -1 : 0))
    .map((entry) => ({
      key: entry.key,
      label: entry.label,
      kind: entry.kind,
      debited: entry.debited.toString(),
      credited: entry.credited.toString(),
      count: entry.count,
      latestAt: entry.latestAt?.toISOString() ?? null,
      ...(entry.key === a.category
        ? {
            records: entry.records.map((record) => ({
              id: record.id,
              chatId: record.chatId,
              runId: record.runId,
              amount: record.amount.toString(),
              estimated: settlements.get(record.id)?.estimated?.toString() ?? null,
              adjustment: settlements.get(record.id)?.adjustment?.toString() ?? null,
              at: record.at.toISOString(),
            })),
            truncated: entry.truncated,
          }
        : {}),
    }));

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    totalDebited: categories
      .reduce((sum, category) => sum + BigInt(category.debited), 0n)
      .toString(),
    totalCredited: categories
      .reduce((sum, category) => sum + BigInt(category.credited), 0n)
      .toString(),
    records: categories.reduce((sum, category) => sum + category.count, 0),
    categories,
  };
}
