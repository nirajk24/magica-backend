import type { z } from "zod";
import { ToolError } from "@/lib/errors";
import type { AgentTool, InteractionOutcome } from "@/tools/define";
import { getTool, registry } from "@/tools/registry";

/** A tool a plan step may name: one that performs work, rather than one that asks a question. */
const performsWork = (tool: AgentTool) =>
  tool.execute !== undefined && tool.interaction === undefined;

const describeRejection = (error: z.ZodError) =>
  error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "input"} ${issue.message}`)
    .join("; ");

/**
 * What the registry's own estimator says a tool call costs, in microcredits.
 *
 * INVARIANT: the input is parsed by that tool's schema first, so the estimate comes from exactly the
 * arguments the tool would receive — a plan cannot be priced on values the tool would reject or
 * clamp. Anything unpriceable throws a `ToolError`, whose copy is safe to hand back to the model.
 */
export function priceToolCall({ tool, input }: { tool: string; input: unknown }): bigint {
  const entry = getTool(tool);

  if (!entry || !performsWork(entry)) {
    const usable = Object.values(registry)
      .filter(performsWork)
      .map((candidate) => candidate.name)
      .join(", ");

    throw new ToolError(`\`${tool}\` is not a tool that can run a step. Use one of: ${usable}`);
  }

  const parsed = entry.input.safeParse(input);

  if (!parsed.success) {
    throw new ToolError(
      `the arguments for \`${tool}\` were rejected — ${describeRejection(parsed.error)}`,
    );
  }

  return entry.credits(parsed.data);
}

/**
 * Builds what a parked client will render, or the answer that makes parking pointless.
 *
 * The tool owns both, through its optional `prepare`; this only supplies the registry access it
 * needs. A tool that declares no `prepare` parks on the model's input unchanged, which is why
 * adding a waitpoint kind stays a registry entry.
 */
export function buildInteractionOutcome(a: {
  tool: AgentTool;
  input: unknown;
  balance: bigint;
}): InteractionOutcome<unknown> {
  if (!a.tool.prepare) return { payload: a.input };

  return a.tool.prepare(a.input, { price: priceToolCall, balance: a.balance });
}
