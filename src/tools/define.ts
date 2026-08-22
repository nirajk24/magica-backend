import type { z } from "zod";
import type { Logger } from "@/lib/logger";
import type { WaitpointKind } from "@/contracts";

export type NodeRunRequest = {
  nodeType: string;
  subModelId?: string;
  input: unknown;
  timeoutMs?: number;
};

/**
 * What a tool is given at execution time.
 *
 * INVARIANT: remote work goes through `runNode` and never through a direct call. It dispatches a
 * durable child run keyed on this invocation, which checkpoints the provider's run id before
 * polling — so a restarted attempt resumes that work instead of paying for a second copy, and the
 * agent machine suspends between polls instead of holding a CPU.
 *
 * INVARIANT: a tool whose provider reports what it actually charged must pass that figure to
 * `reportCost`, and only that figure. It is reconciled against the estimate, so a guess would move
 * real credits. Providers that report nothing simply never call it and the estimate stands.
 */
export type ToolCtx = {
  userId: string;
  chatId: string;
  runId: string;
  invocationId: string;
  runNode: (request: NodeRunRequest) => Promise<{ output: unknown; creditUsed: bigint }>;
  reportCost: (microcredits: bigint) => void;
  log: Logger;
};

export type AgentTool<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  display: { label: string; icon: string };
  interaction?: WaitpointKind;
  tags?: string[];
  input: I;
  output: O;
  credits: (input: z.infer<I>) => bigint;
  execute?: (input: z.infer<I>, ctx: ToolCtx) => Promise<z.infer<O>>;
};

/**
 * Declares a tool. The LLM tool list, input validation, credit accounting and the rendered card
 * are all derived from one entry, so adding a tool touches one file.
 *
 * `credits` must stay synchronous — an async price lookup would make the whole registry async.
 *
 * A tool with `interaction` set and no `execute` is a termination signal: the SDK emits the call
 * and ends the step, and the orchestrator parks on a waitpoint. This is how plan approval and
 * clarifying questions work.
 */
export function defineTool<I extends z.ZodType, O extends z.ZodType>(
  tool: AgentTool<I, O>,
): AgentTool<I, O> {
  return tool;
}
