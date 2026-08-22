import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { uuidv7 } from "@/lib/ids";
import { executeMagicaNode } from "@/trigger/magica-node-run";
import { magicaHandlers, resetMagica, submissions } from "../msw/magica";
import { server } from "../msw/setup";

const noSleep = () => Promise.resolve();
const created: string[] = [];

const runNode = (invocationId: string) =>
  executeMagicaNode(
    { invocationId, nodeType: "gpt_image_2", input: { prompt: "a mountain" } },
    noSleep,
  );

async function seedInvocation(magicaRunId?: string) {
  const userId = `test_${uuidv7()}`;
  const chatId = uuidv7();
  const runId = uuidv7();
  const invocationId = uuidv7();
  created.push(userId);

  const userMessageId = uuidv7();

  await db.user.create({ data: { id: userId, email: `${userId}@test.local` } });
  await db.chat.create({ data: { id: chatId, userId, title: "t" } });
  await db.message.create({
    data: { id: userMessageId, chatId, role: "user", content: "make me an image" },
  });
  await db.agentRun.create({
    data: { id: runId, chatId, userId, userMessageId, idempotencyKey: uuidv7() },
  });
  await db.toolInvocation.create({
    data: {
      id: invocationId,
      runId,
      toolUseId: uuidv7(),
      toolName: "gpt_image_2",
      input: {},
      ...(magicaRunId ? { magicaRunId } : {}),
    },
  });

  return { invocationId, runId };
}

beforeEach(resetMagica);

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
});

describe("magica node child task", () => {
  it("submits once and checkpoints the run id onto the invocation", async () => {
    server.use(...magicaHandlers());
    const { invocationId } = await seedInvocation();

    const result = await runNode(invocationId);

    expect(result.resumed).toBe(false);
    expect(submissions).toHaveLength(1);

    const row = await db.toolInvocation.findUniqueOrThrow({ where: { id: invocationId } });
    expect(row.magicaRunId, "the id must be persisted, not just returned").toBe("run_fixture_1");
  });

  it("resumes an already-submitted run instead of paying for a second one", async () => {
    server.use(...magicaHandlers({ runId: "run_already_paid" }));
    const { invocationId } = await seedInvocation("run_already_paid");

    const result = await runNode(invocationId);

    expect(result.resumed).toBe(true);
    expect(submissions, "a restarted attempt must never re-submit").toEqual([]);
  });

  it("survives being restarted after the checkpoint", async () => {
    server.use(...magicaHandlers());
    const { invocationId } = await seedInvocation();

    await runNode(invocationId);
    const secondAttempt = await runNode(invocationId);

    expect(secondAttempt.resumed).toBe(true);
    expect(submissions, "one submission across both attempts").toHaveLength(1);
  });

  it("reports the credit the provider actually charged", async () => {
    server.use(...magicaHandlers());
    const { invocationId } = await seedInvocation();

    const result = await runNode(invocationId);

    expect(result.creditUsed).toBe("5880");
  });
});
