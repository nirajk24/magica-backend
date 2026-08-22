import type { z } from "zod";
import type { Logger } from "@/lib/logger";
import type { WaitpointKind } from "@/contracts";

/**
 * What a tool is given at execution time.
 *
 * INVARIANT: a tool that starts remote work must call `recordExternalRef` with the provider's id
 * BEFORE waiting on it, so a restarted attempt resumes that work instead of paying for a second
 * copy.
 */
export type ToolCtx = {
  userId: string;
  chatId: string;
  runId: string;
  invocationId: string;
  recordExternalRef: (externalId: string) => Promise<void>;
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
