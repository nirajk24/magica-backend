import { describe, expect, it } from "vitest";
import type { ActivePlan } from "@/contracts";
import { logger } from "@/lib/logger";
import type { ToolCtx } from "@/tools/define";
import { registry } from "@/tools/registry";
import { submitPlan } from "@/tools/submit-plan";
import { updateStep } from "@/tools/update-step";
import type { ResolutionFx } from "@/tools/define";

const PLAN: ActivePlan = {
  title: "Poster",
  executionMode: "step_by_step",
  steps: [
    { key: "hero", title: "Generate", estimatedCredits: "5880", status: "pending" },
    { key: "crop", title: "Crop", estimatedCredits: "5000", status: "pending" },
  ],
};

function fakeCtx() {
  const patches: unknown[] = [];

  const ctx = {
    userId: "u1",
    chatId: "c1",
    runId: "r1",
    invocationId: "i1",
    runNode: () => Promise.reject(new Error("not used")),
    reportCost: () => undefined,
    updatePlanStep: (patch: { stepKey: string; status: string; note?: string }) => {
      patches.push(patch);
      return Promise.resolve(PLAN);
    },
    loadedSkillNames: () => Promise.resolve([]),
    recordSkillLoad: () => Promise.resolve(),
    log: logger,
  } satisfies ToolCtx;

  return { ctx, patches };
}

describe("update_step", () => {
  it("is registered as an internal, free, executing tool — not an interaction", () => {
    expect(registry.update_step).toBe(updateStep);
    expect(updateStep.interaction).toBeUndefined();
    expect(updateStep.execute).toBeTypeOf("function");
    expect(updateStep.credits({ stepKey: "x", status: "completed" })).toBe(0n);
  });

  it("advances the step through the orchestration seam and echoes the whole plan", async () => {
    const { ctx, patches } = fakeCtx();
    const input = updateStep.input.parse({
      stepKey: "hero",
      status: "completed",
      note: "one poster, portrait",
    });

    const result = await updateStep.execute!(input, ctx);

    expect(patches).toEqual([{ stepKey: "hero", status: "completed", note: "one poster, portrait" }]);
    expect(result, "the model must see what remains").toEqual({ plan: PLAN });
  });

  it("cannot move a step back to pending, which would let progress un-happen", () => {
    expect(() => updateStep.input.parse({ stepKey: "hero", status: "pending" })).toThrow();
  });
});

describe("submit_plan.applyResolution", () => {
  const APPROVED_PAYLOAD = {
    title: "Poster",
    overview: "Two steps.",
    steps: [
      {
        key: "hero",
        title: "Generate",
        description: "d",
        tool: "gpt_image_2",
        subModelId: null,
        estimatedCredits: "5880",
      },
      {
        key: "crop",
        title: "Crop",
        description: "d",
        tool: "crop_image",
        subModelId: null,
        estimatedCredits: "5000",
      },
    ],
    estimatedTotal: "10880",
  };

  function fakeFx() {
    const calls: string[] = [];
    let plan: ActivePlan | null | undefined;
    let mode: string | undefined;

    const fx: ResolutionFx = {
      setExecutionMode: (m) => {
        calls.push(`mode:${m}`);
        mode = m;
        return Promise.resolve();
      },
      setActivePlan: (p) => {
        calls.push(p === null ? "plan:null" : "plan:set");
        plan = p;
        return Promise.resolve();
      },
    };

    return { fx, calls, plan: () => plan, mode: () => mode };
  }

  it("turns a step-by-step approval into the chat's active plan, every step pending", async () => {
    const f = fakeFx();

    await submitPlan.applyResolution!(
      {
        resolution: { kind: "plan_approval", approved: true, executionMode: "step_by_step" },
        payload: APPROVED_PAYLOAD,
      },
      f.fx,
    );

    expect(f.mode()).toBe("step_by_step");
    expect(f.plan()).toEqual({
      title: "Poster",
      executionMode: "step_by_step",
      steps: [
        { key: "hero", title: "Generate", estimatedCredits: "5880", status: "pending" },
        { key: "crop", title: "Crop", estimatedCredits: "5000", status: "pending" },
      ],
    });
  });

  it("clears any previous plan on a Run All approval, so a stale plan cannot hold step mode", async () => {
    const f = fakeFx();

    await submitPlan.applyResolution!(
      { resolution: { kind: "plan_approval", approved: true }, payload: APPROVED_PAYLOAD },
      f.fx,
    );

    expect(f.mode()).toBe("auto");
    expect(f.calls).toContain("plan:null");
  });

  it("does nothing on a rejection — the model re-plans, nothing has been decided", async () => {
    const f = fakeFx();

    await submitPlan.applyResolution!(
      {
        resolution: { kind: "plan_approval", approved: false, feedback: "cheaper please" },
        payload: APPROVED_PAYLOAD,
      },
      f.fx,
    );

    expect(f.calls).toEqual([]);
  });

  it("does nothing on expiry", async () => {
    const f = fakeFx();

    await submitPlan.applyResolution!(
      { resolution: { expired: true }, payload: APPROVED_PAYLOAD },
      f.fx,
    );

    expect(f.calls).toEqual([]);
  });
});
