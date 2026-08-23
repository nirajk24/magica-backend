import { afterAll, describe, expect, it } from "vitest";
import type { ActivePlan } from "@/contracts";
import { db } from "@/lib/db";
import { ToolError } from "@/lib/errors";
import { uuidv7 } from "@/lib/ids";
import { logger } from "@/lib/logger";
import { getChatForUser } from "@/services/chat.service";
import {
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

  return { userId, chatId, runId };
}

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
