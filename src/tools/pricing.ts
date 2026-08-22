import { z } from "zod";
import { env } from "@/lib/env";

const PerImage = z.object({ type: z.literal("per_image"), value: z.number() });
const PerMinute = z.object({
  type: z.literal("per_minute"),
  baseValue: z.number(),
  extraPerVideo: z.number().optional(),
});
const Tiered = z.object({
  type: z.literal("tiered"),
  tierKeyFrom: z.array(z.string()),
  tierKeyMap: z.record(z.string(), z.record(z.string(), z.string())),
  tiers: z.record(z.string(), z.number()),
  defaultTier: z.string(),
});

/** Mirrors the `cost` object in Magica's model catalog so a refresh is a straight copy. */
const CostModel = z.discriminatedUnion("type", [PerImage, PerMinute, Tiered]);
export type CostModel = z.infer<typeof CostModel>;

const MICRO = 1_000_000;

/**
 * Fallback prices, committed from `GET /v1/models/catalog` (2026-08-21). Live values replace these
 * via `ensureCatalogPricing`; this table only has to hold until that first fetch returns, and to
 * cover the case where it never does.
 *
 * Catalog values are in credits; everything on the wire is microcredits.
 */
const CATALOG: Record<string, CostModel> = {
  gpt_image_2: {
    type: "tiered",
    tierKeyFrom: ["quality", "size"],
    tierKeyMap: {
      quality: { low: "Low", medium: "Medium", high: "High", auto: "Auto" },
      size: {
        Auto: "1024x1024",
        auto: "1024x1024",
        "1024x1024": "1024x1024",
        "1536x1024": "1536x1024",
        "1024x1536": "1024x1536",
        "2048x2048": "2048x2048",
        "2048x1152": "2048x1152",
        "3840x2160": "3840x2160",
        "2160x3840": "2160x3840",
      },
    },
    tiers: {
      "High:1024x1024": 0.21072,
      "High:1536x1024": 0.16464,
      "High:1024x1536": 0.16464,
      "High:2048x2048": 0.42816,
      "High:2048x1152": 0.1695,
      "High:3840x2160": 0.40026,
      "High:2160x3840": 0.40026,
      "Medium:1024x1024": 0.05268,
      "Medium:1536x1024": 0.04116,
      "Medium:1024x1536": 0.04116,
      "Medium:2048x2048": 0.10704,
      "Medium:2048x1152": 0.04239,
      "Medium:3840x2160": 0.10008,
      "Medium:2160x3840": 0.10008,
      "Low:1024x1024": 0.00588,
      "Low:1536x1024": 0.00474,
      "Low:1024x1536": 0.00474,
      "Low:2048x2048": 0.01191,
      "Low:2048x1152": 0.00471,
      "Low:3840x2160": 0.01113,
      "Low:2160x3840": 0.01113,
      "Auto:1024x1024": 0.21072,
      "Auto:1536x1024": 0.16464,
      "Auto:1024x1536": 0.16464,
      "Auto:2048x2048": 0.42816,
      "Auto:2048x1152": 0.1695,
      "Auto:3840x2160": 0.40026,
      "Auto:2160x3840": 0.40026,
    },
    defaultTier: "High:1024x1024",
  },
  crop_image: { type: "per_image", value: 0.005 },
};

const prices = new Map<string, CostModel>(Object.entries(CATALOG));

/**
 * Restores the committed table, discarding anything hydrated over it. Prices are module-level
 * mutable state, so a bad hydration would otherwise persist for the life of the process.
 */
export function resetPricing(): void {
  prices.clear();
  for (const [nodeType, cost] of Object.entries(CATALOG)) prices.set(nodeType, cost);
}

const CatalogResponse = z.object({
  models: z.record(
    z.string(),
    z.object({ nodeType: z.string(), cost: z.unknown().optional() }),
  ),
});

let hydration: Promise<number> | null = null;

/**
 * Fetches the public model catalog once per process and replaces the committed prices with it.
 * Safe to call from any async entry point; the result is memoised and the fetch is never repeated.
 *
 * Awaiting this before a turn is what keeps `estimateMicrocredits` synchronous while still
 * charging live prices. A failed or slow fetch is not an error — the committed table stands.
 *
 * @returns how many node prices were applied.
 */
export function ensureCatalogPricing(): Promise<number> {
  hydration ??= fetchCatalogPricing();
  return hydration;
}

async function fetchCatalogPricing(): Promise<number> {
  try {
    const res = await fetch(`${env.MAGICA_BASE_URL}/v1/models/catalog`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return 0;

    const { models } = CatalogResponse.parse(await res.json());
    return hydratePricing(Object.values(models));
  } catch {
    return 0;
  }
}

/**
 * Replaces prices from a catalog payload. Unparseable entries are left as committed.
 *
 * INVARIANT: entries are keyed by the `nodeType` FIELD, never by the position they were found at.
 * The catalog's own map key differs from it — `gpt-image-2` maps to nodeType `gpt_image_2`.
 */
export function hydratePricing(catalog: { nodeType: string; cost?: unknown }[]): number {
  let applied = 0;
  for (const node of catalog) {
    const parsed = CostModel.safeParse(node.cost);
    if (parsed.success) {
      prices.set(node.nodeType, parsed.data);
      applied++;
    }
  }
  return applied;
}

/**
 * Resolves one tier component, matching case-insensitively.
 *
 * The catalog disagrees with itself: `quality` offers `High`/`Medium`/`Low` as input values but
 * keys its `tierKeyMap` `high`/`medium`/`low`. An exact-match lookup misses every quality and
 * falls through to `defaultTier`, the most expensive one.
 */
function resolveTierPart(map: Record<string, string>, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (map[raw] !== undefined) return map[raw];

  const lowered = raw.toLowerCase();
  if (map[lowered] !== undefined) return map[lowered];

  return Object.entries(map).find(([key]) => key.toLowerCase() === lowered)?.[1] ?? null;
}

function tierKey(cost: z.infer<typeof Tiered>, input: Record<string, unknown>): string {
  const parts = cost.tierKeyFrom.map((field) =>
    resolveTierPart(cost.tierKeyMap[field] ?? {}, input[field]),
  );

  if (parts.some((part) => part === null)) return cost.defaultTier;
  return parts.join(":");
}

/**
 * Estimated cost in microcredits, rounded up — this is charged before the tool runs, so rounding
 * down would let a turn start work it cannot pay for. An unresolvable tier falls back to
 * `defaultTier`.
 *
 * Throws on an unknown node rather than returning zero, which would ship a tool that spends
 * credits and charges nothing.
 */
export function estimateMicrocredits(
  nodeType: string,
  input: Record<string, unknown>,
  count = 1,
): bigint {
  const cost = prices.get(nodeType);
  if (!cost) throw new Error(`No price for node type "${nodeType}"`);

  const credits =
    cost.type === "per_image"
      ? cost.value
      : cost.type === "per_minute"
        ? cost.baseValue + (cost.extraPerVideo ?? 0)
        : (cost.tiers[tierKey(cost, input)] ?? cost.tiers[cost.defaultTier] ?? 0);

  return BigInt(Math.ceil(credits * MICRO * count));
}
