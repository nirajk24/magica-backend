import type { z } from "zod";
import type { Logger } from "@/lib/logger";
import type { ActivePlan, AssetDTO, WaitpointKind } from "@/contracts";

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
  /**
   * Advances one step of the chat's active plan and returns the plan as it now stands. Throws a
   * `ToolError` when no plan is active or the key names no step, so the model can correct itself.
   */
  updatePlanStep: (a: {
    stepKey: string;
    status: "in_progress" | "completed" | "failed";
    note?: string;
  }) => Promise<ActivePlan>;
  /** Distinct skill names this run has already loaded — the per-turn load budget counts these. */
  loadedSkillNames: () => Promise<string[]>;
  /** Idempotent on `(runId, skillName, assetPath)`, which is what makes a repeat load a dedup. */
  recordSkillLoad: (a: {
    skillName: string;
    assetPath: string;
    contentHash: string;
  }) => Promise<void>;
  log: Logger;
};

/** The media a tool produced, before the orchestrator attaches cost and attribution. */
export type MediaRef = { url: string; type: AssetDTO["type"] };

/**
 * What an interaction tool is given while its waitpoint payload is built.
 *
 * `price` is the registry's own estimator for another tool's call — the same function that charges
 * at execution — so a figure shown on a card can never be one the model made up. It throws a
 * `ToolError` naming the problem when the call cannot be priced.
 */
export type InteractionCtx = {
  price: (a: { tool: string; input: unknown }) => bigint;
  /** Microcredits the user can still spend, for a tool that must refuse work it cannot pay for. */
  balance: bigint;
};

/**
 * Either something worth waiting on, or an answer that makes waiting pointless.
 *
 * A plan whose steps the server cannot price is answered on the spot with the reason, so the model
 * corrects it — rather than a user being asked to approve a plan that could never have run.
 */
export type InteractionOutcome<R> = { payload: unknown } | { resolution: R };

/**
 * The run-level effects a resolved interaction may apply, implemented by the orchestration so the
 * tool that knows what a resolution *means* never touches persistence itself.
 */
export type ResolutionFx = {
  setExecutionMode: (mode: "auto" | "step_by_step") => Promise<void>;
  /** `null` clears the plan; the prompt and the progress card both read what this writes. */
  setActivePlan: (plan: ActivePlan | null) => Promise<void>;
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
  /**
   * Turns what the model asked for into what the waiting client renders. Only an interaction tool
   * declares one; without it the payload is the model's input unchanged.
   */
  prepare?: (input: z.infer<I>, ctx: InteractionCtx) => InteractionOutcome<z.infer<O>>;
  /**
   * What this tool's resolution means for the run — approval setting an execution mode, an
   * approved plan becoming the chat's active plan. Called once after the resolution settles, with
   * the payload the user saw. A tool with no run-level effects simply omits it.
   */
  applyResolution?: (a: { resolution: z.infer<O>; payload: unknown }, fx: ResolutionFx) => Promise<void>;
  /**
   * Pulls the media out of this tool's own output. Only the tool knows its output shape, so a tool
   * that produces files declares this and nothing in the orchestrator reads `output` directly.
   */
  assets?: (output: z.infer<O>) => MediaRef[];
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
