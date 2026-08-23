import { UsageQuery, type UsagePage } from "@/contracts";
import { defineRoute, preflight } from "@/lib/api";
import { summarizeUsage } from "@/services/usage.service";

/**
 * The usage overview: what each tool actually cost over a period, and what credit came in.
 * `?category` adds that category's newest records for the detailed view.
 */
export const GET = defineRoute({
  query: UsageQuery,
  handler: ({ userId, query }): Promise<UsagePage> =>
    summarizeUsage({ userId, from: query.from, to: query.to, category: query.category }),
});

export const OPTIONS = preflight;
