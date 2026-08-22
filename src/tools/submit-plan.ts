import { z } from "zod";
import {
  PlanApprovalPayload,
  PlanApprovalResolution,
  WaitpointExpired,
  type PlanStepPayload,
} from "@/contracts";
import { AppError, ToolError } from "@/lib/errors";
import { defineTool, type InteractionCtx } from "@/tools/define";

const PlanStep = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/, "use a short slug like `hero_image`"),
  title: z.string().min(1).max(120),
  description: z.string().max(400),
  toolCall: z.object({
    tool: z.string().min(1),
    subModelId: z.string().max(120).optional(),
    input: z.unknown(),
  }),
});

const Input = z.object({
  title: z.string().min(1).max(120),
  overview: z.string().max(600),
  steps: z.array(PlanStep).min(1).max(8),
});

type PlanInput = z.infer<typeof Input>;

const asCredits = (microcredits: bigint) => (Number(microcredits) / 1_000_000).toFixed(4);

function priceSteps(input: PlanInput, ctx: InteractionCtx): PlanStepPayload[] {
  return input.steps.map((step) => {
    try {
      return {
        key: step.key,
        title: step.title,
        description: step.description,
        tool: step.toolCall.tool,
        subModelId: step.toolCall.subModelId ?? null,
        estimatedCredits: ctx
          .price({ tool: step.toolCall.tool, input: step.toolCall.input })
          .toString(),
      };
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      throw new ToolError(`step "${step.key}" cannot run: ${error.message}`);
    }
  });
}

/**
 * Proposes a plan and waits for the user to approve it, request changes, or run it step by step.
 *
 * INVARIANT: every credit figure on the card is priced by `prepare` through the registry's own
 * estimator — the same function that charges at execution. The model states no cost anywhere, and a
 * step the server cannot price is sent straight back to it as a change request rather than shown to
 * a user as a plan that could never have run.
 */
export const submitPlan = defineTool({
  name: "submit_plan",
  description:
    "Propose a plan and wait for the user to approve it. Use before a run of media work that will " +
    "cost credits, and whenever the user asks for a plan. Every step must name the tool that " +
    "performs it and the exact arguments you would pass — the plan is executed, not read. Never " +
    "state a cost; the steps are priced for you. If the answer is `approved: false`, re-plan using " +
    "the feedback. If it approves with `executionMode: \"step_by_step\"`, carry out exactly one " +
    "step, summarise it, and ask whether to continue.",
  display: { label: "Plan", icon: "clipboard-list" },
  tags: ["interaction"],
  interaction: "plan_approval",
  input: Input,
  output: z.union([PlanApprovalResolution, WaitpointExpired]),
  credits: () => 0n,

  prepare: (input, ctx) => {
    let steps: PlanStepPayload[];

    try {
      steps = priceSteps(input, ctx);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;

      return {
        resolution: {
          kind: "plan_approval" as const,
          approved: false,
          feedback: `This plan could not be priced — ${error.message}. Correct that step and submit the plan again.`,
        },
      };
    }

    const estimatedTotal = steps.reduce((sum, step) => sum + BigInt(step.estimatedCredits), 0n);

    if (estimatedTotal > ctx.balance) {
      throw new AppError(
        "LIMIT_EXCEEDED",
        `This plan needs ${asCredits(estimatedTotal)} credits and your balance is ` +
          `${asCredits(ctx.balance)}. Add credits and send the request again.`,
      );
    }

    return {
      payload: PlanApprovalPayload.parse({
        title: input.title,
        overview: input.overview,
        steps,
        estimatedTotal: estimatedTotal.toString(),
      }),
    };
  },
});
