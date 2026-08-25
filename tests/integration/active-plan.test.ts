import { afterAll, describe, expect, it } from "vitest";
import type { ActivePlan } from "@/contracts";
import { db } from "@/lib/db";
import { ToolError } from "@/lib/errors";
import { uuidv7 } from "@/lib/ids";
import { logger } from "@/lib/logger";
import { getChatForUser } from "@/services/chat.service";
import {
  completeTurn,
  failTurn,
  patchActivePlanStep,
  recordExecutionMode,
  writeActivePlan,
} from "@/services/turn.service";
import { createToolRuntime } from "@/agent/tool-runtime";
import { submitPlan } from "@/tools/submit-plan";

const created: string[] = [];

const PLAN: ActivePlan = {
  title: "Poster",
  executionMode: "step_by_step",
  steps: [
    { key: "hero", title: "Generate", estimatedCredits: "5880", status: "pending" },
    { key: "crop", title: "Crop", estimatedCredits: "5000", status: "pending" },
  ],
};

async function seed(a?: { runStatus?: "running" | "completed" }) {
  const userId = `test_${uuidv7()}`;
  created.push(userId);

  const chatId = uuidv7();
  const runId = uuidv7();
  const userMessageId = uuidv7();
  const assistantMessageId = uuidv7();

  await db.user.create({ data: { id: userId, email: `${userId}@test.local` } });
  await db.chat.create({ data: { id: chatId, userId, title: "t" } });
  await db.message.create({ data: { id: userMessageId, chatId, role: "user", content: "plan" } });
  await db.agentRun.create({
    data: {
      id: runId,
      chatId,
      userId,
      userMessageId,
      idempotencyKey: `${userMessageId}:1`,
      status: a?.runStatus ?? "running",
    },
  });
  await db.message.create({
    data: { id: assistantMessageId, chatId, runId, role: "assistant", status: "streaming" },
  });
  await db.agentRun.update({ where: { id: runId }, data: { assistantMessageId } });

  return { userId, chatId, runId, assistantMessageId };
}

/** The plan as the chat row now holds it, which is what a reloading client reads. */
async function storedPlan(chatId: string): Promise<ActivePlan> {
  const chat = await db.chat.findUniqueOrThrow({
    where: { id: chatId },
    select: { activePlan: true },
  });

  return chat.activePlan as unknown as ActivePlan;
}

const running: ActivePlan = {
  ...PLAN,
  steps: [
    { ...PLAN.steps[0]!, status: "completed", note: "done" },
    { ...PLAN.steps[1]!, status: "in_progress" },
  ],
};

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
});

describe("the active plan on the chat row", () => {
  it("writes, surfaces on the DTO, and clears to SQL NULL", async () => {
    const { userId, chatId } = await seed();

    await writeActivePlan(chatId, PLAN);
    expect((await getChatForUser({ userId, chatId })).activePlan).toEqual(PLAN);

    await writeActivePlan(chatId, null);
    expect((await getChatForUser({ userId, chatId })).activePlan).toBeNull();

    const raw = await db.chat.findUniqueOrThrow({
      where: { id: chatId },
      select: { activePlan: true },
    });
    expect(raw.activePlan, "SQL NULL, not the JSON literal null").toBeNull();
  });

  it("advances one step and leaves the others alone", async () => {
    const { chatId } = await seed();
    await writeActivePlan(chatId, PLAN);

    const after = await patchActivePlanStep({
      chatId,
      stepKey: "hero",
      status: "completed",
      note: "portrait, one image",
    });

    expect(after.steps[0]).toMatchObject({
      key: "hero",
      status: "completed",
      note: "portrait, one image",
    });
    expect(after.steps[1]).toMatchObject({ key: "crop", status: "pending" });

    const persisted = await db.chat.findUniqueOrThrow({
      where: { id: chatId },
      select: { activePlan: true },
    });
    expect(persisted.activePlan).toEqual(after);
  });

  it("tells the model which keys exist when it names a step that does not", async () => {
    const { chatId } = await seed();
    await writeActivePlan(chatId, PLAN);

    await expect(
      patchActivePlanStep({ chatId, stepKey: "villain", status: "in_progress" }),
    ).rejects.toThrow(/hero, crop/);
  });

  it("refuses to record progress when no plan is active", async () => {
    const { chatId } = await seed();

    await expect(
      patchActivePlanStep({ chatId, stepKey: "hero", status: "in_progress" }),
    ).rejects.toBeInstanceOf(ToolError);
  });

  it("records the execution mode on a live run and never on a finished one", async () => {
    const live = await seed();
    await recordExecutionMode(live.runId, "step_by_step");
    await expect(
      db.agentRun.findUniqueOrThrow({ where: { id: live.runId } }),
    ).resolves.toMatchObject({ executionMode: "step_by_step" });

    const done = await seed({ runStatus: "completed" });
    await recordExecutionMode(done.runId, "step_by_step");
    await expect(
      db.agentRun.findUniqueOrThrow({ where: { id: done.runId } }),
    ).resolves.toMatchObject({ executionMode: "auto" });
  });
});

describe("a step-by-step approval, end to end through the tool's own effect", () => {
  const payload = {
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

  it("writes the run's mode and the chat's plan exactly as the card approved them", async () => {
    const { userId, chatId, runId } = await seed();

    await submitPlan.applyResolution!(
      {
        resolution: { kind: "plan_approval", approved: true, executionMode: "step_by_step" },
        payload,
      },
      {
        setExecutionMode: (mode) => recordExecutionMode(runId, mode),
        setActivePlan: (plan) => writeActivePlan(chatId, plan),
      },
    );

    await expect(
      db.agentRun.findUniqueOrThrow({ where: { id: runId } }),
    ).resolves.toMatchObject({ executionMode: "step_by_step" });
    expect((await getChatForUser({ userId, chatId })).activePlan).toEqual(PLAN);
  });

  it("then advances through the runtime the way update_step does, publishing each move", async () => {
    const { userId, chatId, runId } = await seed();
    await writeActivePlan(chatId, PLAN);

    const publishedPlans: unknown[] = [];
    const runtime = createToolRuntime({
      turn: { userId, chatId, runId },
      publish: () => Promise.resolve(),
      publishPlan: (plan) => {
        publishedPlans.push(plan);
        return Promise.resolve();
      },
      log: logger,
    });

    await runtime.updatePlanStep({ stepKey: "hero", status: "in_progress" });
    const after = await runtime.updatePlanStep({
      stepKey: "hero",
      status: "completed",
      note: "done",
    });

    expect(after.steps[0]).toMatchObject({ status: "completed", note: "done" });
    expect(publishedPlans, "the live card moves with every write").toHaveLength(2);
    expect((await getChatForUser({ userId, chatId })).activePlan).toEqual(after);
  });
});

/**
 * A step goes `in_progress` before its work and `completed` after, so one still open at the terminal
 * write belongs to work that will never happen. The progress card has no other signal — left alone
 * it renders that step as running forever, on a run the API already reports as finished.
 */
describe("closing out a plan the turn left open", () => {
  it("settles an open step when the turn fails, carrying the reason onto it", async () => {
    const { userId, chatId, runId, assistantMessageId } = await seed();
    await writeActivePlan(chatId, running);

    await failTurn({
      runId,
      userId,
      messageId: assistantMessageId,
      blocks: [],
      reason: "This turn reached its step limit before finishing.",
    });

    const [first, second] = (await storedPlan(chatId)).steps;

    expect(second?.status, "a step nothing will finish is not still in progress").toBe("failed");
    expect(second?.note).toMatch(/step limit/i);
    expect(first?.status, "a step that did finish keeps its own outcome").toBe("completed");
  });

  it("settles an open step when the turn completes, because success strands it just the same", async () => {
    const { userId, chatId, runId, assistantMessageId } = await seed();
    await writeActivePlan(chatId, running);

    await completeTurn({
      runId,
      userId,
      messageId: assistantMessageId,
      blocks: [],
      tokenUsage: null,
    });

    expect((await storedPlan(chatId)).steps[1]?.status).toBe("failed");
  });

  it("returns the settled plan so the live card can be moved off its spinner", async () => {
    const { userId, chatId, runId, assistantMessageId } = await seed();
    await writeActivePlan(chatId, running);

    const settled = await completeTurn({
      runId,
      userId,
      messageId: assistantMessageId,
      blocks: [],
      tokenUsage: null,
    });

    expect(settled?.steps[1]?.status).toBe("failed");
  });

  it("leaves a finished plan alone and reports nothing to publish", async () => {
    const { userId, chatId, runId, assistantMessageId } = await seed();
    const finished: ActivePlan = {
      ...PLAN,
      steps: PLAN.steps.map((step) => ({ ...step, status: "completed" as const })),
    };
    await writeActivePlan(chatId, finished);

    const settled = await completeTurn({
      runId,
      userId,
      messageId: assistantMessageId,
      blocks: [],
      tokenUsage: null,
    });

    expect(settled, "an untouched plan must not be republished").toBeNull();
    expect((await storedPlan(chatId)).steps.every((s) => s.status === "completed")).toBe(true);
  });

  it("is a no-op on a chat with no plan at all", async () => {
    const { userId, chatId, runId, assistantMessageId } = await seed();

    const settled = await completeTurn({
      runId,
      userId,
      messageId: assistantMessageId,
      blocks: [],
      tokenUsage: null,
    });

    expect(settled).toBeNull();
    expect((await db.chat.findUniqueOrThrow({ where: { id: chatId } })).activePlan).toBeNull();
  });
});
