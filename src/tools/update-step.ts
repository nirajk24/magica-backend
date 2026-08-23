import { z } from "zod";
import { ActivePlan } from "@/contracts";
import { defineTool } from "@/tools/define";

const Input = z.object({
  stepKey: z.string().min(1).max(64),
  status: z.enum(["in_progress", "completed", "failed"]),
  note: z.string().max(300).optional(),
});

/**
 * Advances the chat's active plan one step at a time. Internal and free: no external call, no
 * charge — its whole effect is the write the progress card renders from, so the answer returns the
 * plan as it now stands and the model always knows what remains.
 */
export const updateStep = defineTool({
  name: "update_step",
  description:
    "Record progress on the approved step-by-step plan. Call it with the step's key and " +
    "`in_progress` before you start that step's work, and again with `completed` (or `failed`) " +
    "and a short note when it ends. Only meaningful while a step-by-step plan is running; the " +
    "result echoes the whole plan so you can see what is left.",
  display: { label: "Step update", icon: "list-checks" },
  tags: ["plan"],
  input: Input,
  output: z.object({ plan: ActivePlan }),
  credits: () => 0n,

  execute: async (input, ctx) => ({ plan: await ctx.updatePlanStep(input) }),
});
