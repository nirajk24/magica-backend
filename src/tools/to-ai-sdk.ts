import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { AppError, ToolError } from "@/lib/errors";
import type { Logger } from "@/lib/logger";
import type { AgentTool, NodeRunRequest } from "@/tools/define";

/** What the model gets back. Failures are data, not throws: a rejected prompt is a normal path. */
export type ToolOutcome =
  | { ok: true; data: unknown }
  | { ok: false; error: string; retryable: boolean };

export type TurnContext = { userId: string; chatId: string; runId: string };

/** Every effect the wrapper orders but does not perform. Kept injectable so the ordering is testable. */
export type ToolRuntime = {
  isRunActive: () => Promise<boolean>;
  beginInvocation: (a: {
    toolUseId: string;
    toolName: string;
    input: unknown;
  }) => Promise<string>;
  chargeEstimate: (a: { invocationId: string; amount: bigint }) => Promise<void>;
  runNode: (a: { invocationId: string; request: NodeRunRequest }) => Promise<{
    output: unknown;
    creditUsed: bigint;
  }>;
  completeInvocation: (a: {
    invocationId: string;
    output: unknown;
    durationMs: number;
    actualCost: bigint | null;
  }) => Promise<void>;
  failInvocation: (a: {
    invocationId: string;
    message: string;
    durationMs: number;
  }) => Promise<void>;
  loadedSkillNames: () => Promise<string[]>;
  recordSkillLoad: (a: {
    skillName: string;
    assetPath: string;
    contentHash: string;
  }) => Promise<void>;
  now: () => number;
  log: Logger;
};

/** Only our own error types carry copy safe to show a user. */
function toolFailure(error: unknown): { error: string; retryable: boolean } {
  if (error instanceof ToolError) return { error: error.message, retryable: error.retryable };
  if (error instanceof AppError) return { error: error.message, retryable: false };
  if (error instanceof z.ZodError) {
    return { error: "The tool returned a result in an unexpected shape.", retryable: false };
  }
  return { error: "That step failed for an unexpected reason.", retryable: true };
}

function describeInvalidInput(error: z.ZodError): string {
  const issues = error.issues
    .slice(0, 4)
    .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
    .join("; ");

  return `Those arguments were rejected — ${issues}. Fix them and call the tool again.`;
}

/**
 * Turns registry entries into AI SDK tools, wrapped in the order that keeps the ledger honest:
 * cancel guard → validate → record → charge → execute → validate → settle.
 *
 * INVARIANT: the charge precedes `execute`, so exhaustion is caught before an external cost.
 * INVARIANT: a tool declaring `interaction` gets NO `execute` — that is what parks the turn.
 */
export function toAiSdkTools(
  tools: Record<string, AgentTool>,
  turn: TurnContext,
  runtime: ToolRuntime,
): ToolSet {
  const set: ToolSet = {};

  for (const [name, agentTool] of Object.entries(tools)) {
    if (agentTool.interaction || !agentTool.execute) {
      set[name] = tool({
        description: agentTool.description,
        inputSchema: agentTool.input,
      });
      continue;
    }

    const execute = agentTool.execute;

    set[name] = tool({
      description: agentTool.description,
      inputSchema: agentTool.input,
      execute: async (rawInput, { toolCallId }): Promise<ToolOutcome> => {
        if (!(await runtime.isRunActive())) {
          return {
            ok: false,
            error: "This run was stopped, so the step was not started.",
            retryable: false,
          };
        }

        const parsed = agentTool.input.safeParse(rawInput);
        if (!parsed.success) {
          return { ok: false, error: describeInvalidInput(parsed.error), retryable: false };
        }

        const input: unknown = parsed.data;
        const invocationId = await runtime.beginInvocation({
          toolUseId: toolCallId,
          toolName: name,
          input,
        });
        const startedAt = runtime.now();
        const elapsed = () => runtime.now() - startedAt;

        try {
          await runtime.chargeEstimate({
            invocationId,
            amount: agentTool.credits(input),
          });
        } catch (error) {
          const failure = toolFailure(error);
          runtime.log.warn({ err: error, invocationId, toolName: name }, "tool not charged");
          await runtime.failInvocation({ invocationId, message: failure.error, durationMs: elapsed() });

          return { ok: false, ...failure };
        }

        let actualCost: bigint | null = null;

        try {
          const output = await execute(input, {
            userId: turn.userId,
            chatId: turn.chatId,
            runId: turn.runId,
            invocationId,
            runNode: (request) => runtime.runNode({ invocationId, request }),
            reportCost: (microcredits) => {
              actualCost = microcredits;
            },
            loadedSkillNames: runtime.loadedSkillNames,
            recordSkillLoad: runtime.recordSkillLoad,
            log: runtime.log,
          });

          const data: unknown = agentTool.output.parse(output);

          await runtime.completeInvocation({
            invocationId,
            output: data,
            durationMs: elapsed(),
            actualCost,
          });

          return { ok: true, data };
        } catch (error) {
          const failure = toolFailure(error);
          runtime.log.warn({ err: error, invocationId, toolName: name }, "tool failed");
          await runtime.failInvocation({ invocationId, message: failure.error, durationMs: elapsed() });

          return { ok: false, ...failure };
        }
      },
    });
  }

  return set;
}
