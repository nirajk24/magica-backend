import { z } from "zod";
import { ToolError } from "@/lib/errors";

const FieldSpec = z.object({
  zodExpectedName: z.string().min(1),
  dataType: z.string().optional(),
  required: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  maxImages: z.number().optional(),
  maxItems: z.number().optional(),
  options: z.array(z.object({ value: z.union([z.string(), z.number()]) })).optional(),
});
type FieldSpec = z.infer<typeof FieldSpec>;

const SubModel = z.object({
  subModelId: z.string().min(1),
  inputFieldOptions: z.array(z.unknown()),
});

/** nodeType → subModelId → field specs, exactly as the live catalog last described them. */
const specs = new Map<string, Map<string, FieldSpec[]>>();

/** Drops everything hydrated, for tests. There is no committed fallback on purpose — see below. */
export function resetFieldSpecs(): void {
  specs.clear();
}

/**
 * Stores each sub-model's input fields from a catalog payload. Unparseable entries are skipped
 * field by field, so one malformed field never discards a whole node's schema.
 *
 * INVARIANT: keyed by the `nodeType` FIELD, never the catalog's map key — `gpt-image-2` maps to
 * nodeType `gpt_image_2`, and keying by position silently misses it.
 */
export function hydrateFieldSpecs(
  catalog: { nodeType: string; subModels?: unknown }[],
): number {
  let applied = 0;

  for (const node of catalog) {
    const subModels = z.array(z.unknown()).safeParse(node.subModels);
    if (!subModels.success) continue;

    const byId = new Map<string, FieldSpec[]>();

    for (const raw of subModels.data) {
      const subModel = SubModel.safeParse(raw);
      if (!subModel.success) continue;

      const fields = subModel.data.inputFieldOptions
        .map((field) => FieldSpec.safeParse(field))
        .filter((field) => field.success)
        .map((field) => field.data);

      if (fields.length > 0) {
        byId.set(subModel.data.subModelId, fields);
        applied++;
      }
    }

    if (byId.size > 0) specs.set(node.nodeType, byId);
  }

  return applied;
}

const label = (value: unknown) => (typeof value === "string" ? `"${value}"` : String(value));

function fieldProblem(spec: FieldSpec, value: unknown): string | null {
  if (value === undefined) {
    return spec.required ? `${spec.zodExpectedName} is required` : null;
  }

  if (typeof value === "string" && spec.max !== undefined && value.length > spec.max) {
    return `${spec.zodExpectedName} is longer than ${spec.max} characters`;
  }

  if (typeof value === "number") {
    if (spec.min !== undefined && value < spec.min) {
      return `${spec.zodExpectedName} must be at least ${spec.min}`;
    }
    if (spec.max !== undefined && value > spec.max) {
      return `${spec.zodExpectedName} must be at most ${spec.max}`;
    }
  }

  if (Array.isArray(value)) {
    const bound = spec.maxImages ?? spec.maxItems;
    if (bound !== undefined && value.length > bound) {
      return `${spec.zodExpectedName} takes at most ${bound} items`;
    }
  }

  if (
    spec.options !== undefined &&
    (typeof value === "string" || typeof value === "number") &&
    !spec.options.some((option) => option.value === value)
  ) {
    return (
      `${spec.zodExpectedName} must be one of ` +
      `${spec.options.map((option) => label(option.value)).join(", ")}; got ${label(value)}`
    );
  }

  return null;
}

/**
 * Checks an outbound node request against the provider's own current schema, fetched live — the
 * catalog is the authority on field names and bounds, our Zod schemas are the transport guard.
 *
 * Silently passes anything the catalog has no spec for: there is no committed fallback, because a
 * committed copy IS the stale duplicate this check exists to replace, and a catalog outage must
 * not turn every generation into a failed turn.
 *
 * @throws ToolError naming each problem, so the model corrects the call instead of the provider
 * failing it after the dispatch.
 */
export function validateNodeInput(a: {
  nodeType: string;
  subModelId?: string;
  input: unknown;
}): void {
  if (!a.subModelId) return;

  const fields = specs.get(a.nodeType)?.get(a.subModelId);
  if (!fields || typeof a.input !== "object" || a.input === null) return;

  const input = a.input as Record<string, unknown>;
  const known = new Set(fields.map((field) => field.zodExpectedName));

  const problems = [
    ...Object.keys(input)
      .filter((key) => input[key] !== undefined && !known.has(key))
      .map((key) => `${key} is not a field of ${a.subModelId}`),
    ...fields.map((field) => fieldProblem(field, input[field.zodExpectedName])),
  ].filter((problem): problem is string => problem !== null);

  if (problems.length > 0) {
    throw new ToolError(
      `Magica's current ${a.subModelId} schema rejects this call — ` +
        `${problems.slice(0, 4).join("; ")}. Fix the arguments and try again.`,
    );
  }
}
