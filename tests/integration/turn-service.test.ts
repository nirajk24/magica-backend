import { afterAll, describe, expect, it } from "vitest";
import type { ContentBlock } from "@/contracts";
import { getBalance, reserveAdmission, sumLedger, topUp } from "@/lib/credits";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { uuidv7 } from "@/lib/ids";
import { listMessages } from "@/services/message.service";
import { completeTurn, failTurn, loadTurn, persistTurnBlocks } from "@/services/turn.service";

const START = 10_000_000n;
const created: string[] = [];

async function seedRun(a?: { history?: { role: "user" | "assistant"; content: string }[] }) {
  const userId = `test_${uuidv7()}`;
  created.push(userId);

  const chatId = uuidv7();
  const runId = uuidv7();
  const userMessageId = uuidv7();

  await db.user.create({ data: { id: userId, email: `${userId}@test.local` } });
  await db.$transaction((tx) => topUp(tx, { userId, amount: START, key: userId }));
  await db.chat.create({ data: { id: chatId, userId, title: "t" } });
  await db.message.create({ data: { id: userMessageId, chatId, role: "user", content: "draw" } });

  for (const message of a?.history ?? []) {
    await db.message.create({ data: { chatId, ...message } });
  }

  await db.agentRun.create({
    data: { id: runId, chatId, userId, userMessageId, idempotencyKey: uuidv7() },
  });
  await db.$transaction((tx) => reserveAdmission(tx, { userId, runId }));

  return { userId, chatId, runId };
}

const blocks: ContentBlock[] = [
  { segment: 0, type: "text", text: "Here is your mountain." },
  { segment: 1, type: "tool_use", id: "call_1", name: "gpt_image_2", input: {} },
];

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
});

describe("the serving model on the assistant row", () => {
  it("is recorded at bootstrap, so a crash before finalize still names it", async () => {
    const { runId } = await seedRun();
    const turn = await loadTurn(runId);

    const message = await db.message.findUniqueOrThrow({
      where: { id: turn.assistantMessageId },
      select: { aiModel: true, status: true },
    });

    expect(message.status, "still streaming — nothing has finalized").toBe("streaming");
    expect(message.aiModel, "the column the pill reads must not be null").toEqual({
      id: turn.modelId,
      name: expect.any(String),
      provider: expect.any(String),
    });
  });

  it("reaches the wire, where a client can render it", async () => {
    const { chatId, runId } = await seedRun();
    await loadTurn(runId);

    const page = await listMessages({ chatId, limit: 10 });
    const assistant = page.messages.find((message) => message.role === "assistant");

    expect(assistant?.aiModel?.provider).toBeTruthy();
    expect(assistant?.aiModel?.name).not.toContain(":");
  });

  it("is overwritten at finalize by the model that actually answered", async () => {
    const { userId, runId } = await seedRun();
    const turn = await loadTurn(runId);

    // Under the default `openrouter/free` router, what answers is not what was requested.
    await completeTurn({
      runId,
      userId,
      messageId: turn.assistantMessageId,
      blocks,
      tokenUsage: null,
      servedModel: "z-ai/glm-5.2:free",
    });

    const message = await db.message.findUniqueOrThrow({
      where: { id: turn.assistantMessageId },
      select: { aiModel: true },
    });

    expect(message.aiModel, "the router's own id would tell a user nothing").toEqual({
      id: "z-ai/glm-5.2:free",
      name: "glm-5.2",
      provider: "z-ai",
    });
  });

  it("keeps the requested model when the provider names none", async () => {
    const { userId, runId } = await seedRun();
    const turn = await loadTurn(runId);

    await completeTurn({
      runId,
      userId,
      messageId: turn.assistantMessageId,
      blocks,
      tokenUsage: null,
      servedModel: null,
    });

    const message = await db.message.findUniqueOrThrow({
      where: { id: turn.assistantMessageId },
      select: { aiModel: true },
    });

    expect(message.aiModel, "better the requested model than nothing at all").toMatchObject({
      id: turn.modelId,
    });
  });

  it("survives a resumed attempt unchanged", async () => {
    const { runId } = await seedRun();
    const first = await loadTurn(runId);
    const before = await db.message.findUniqueOrThrow({
      where: { id: first.assistantMessageId },
      select: { aiModel: true },
    });

    const resumed = await loadTurn(runId);

    expect(resumed.assistantMessageId, "same row, not a second one").toBe(first.assistantMessageId);
    await expect(
      db.message
        .findUniqueOrThrow({ where: { id: first.assistantMessageId }, select: { aiModel: true } })
        .then((row) => row.aiModel),
    ).resolves.toEqual(before.aiModel);
  });
});

describe("loadTurn", () => {
  it("creates the assistant row and marks the run running", async () => {
    const { runId } = await seedRun();

    const turn = await loadTurn(runId);

    const message = await db.message.findUniqueOrThrow({
      where: { id: turn.assistantMessageId },
    });
    expect(message.role).toBe("assistant");
    expect(message.status).toBe("streaming");

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("running");
    expect(run.assistantMessageId).toBe(turn.assistantMessageId);
  });

  it("reuses the same assistant row on a second attempt", async () => {
    const { runId } = await seedRun();

    const first = await loadTurn(runId);
    const second = await loadTurn(runId);

    expect(second.assistantMessageId, "the partial unique index makes this idempotent").toBe(
      first.assistantMessageId,
    );
    await expect(
      db.message.count({ where: { runId, role: "assistant" } }),
    ).resolves.toBe(1);
  });

  it("returns history oldest-first and never the row it is about to write", async () => {
    const { runId } = await seedRun({
      history: [
        { role: "assistant", content: "earlier answer" },
        { role: "user", content: "follow up" },
      ],
    });

    const turn = await loadTurn(runId);

    expect(turn.history.map((m) => m.content)).toEqual([
      "draw",
      "earlier answer",
      "follow up",
    ]);
    expect(
      turn.history.some((m) => m.content === ""),
      "the streaming assistant row must not be sent to the model",
    ).toBe(false);
  });
});

describe("persistTurnBlocks", () => {
  it("writes the blocks and the flattened text a search would match", async () => {
    const { runId } = await seedRun();
    const turn = await loadTurn(runId);

    await persistTurnBlocks({ messageId: turn.assistantMessageId, blocks });

    const message = await db.message.findUniqueOrThrow({
      where: { id: turn.assistantMessageId },
    });
    expect(message.content).toBe("Here is your mountain.");
    expect(Array.isArray(message.contentBlocks)).toBe(true);
  });
});

describe("completeTurn", () => {
  it("refunds the admission hold, so the net cost is the tool charges alone", async () => {
    const { runId, userId } = await seedRun();
    const turn = await loadTurn(runId);

    expect(await getBalance(userId)).toBe(START - env.ADMISSION_CREDITS);

    await completeTurn({
      runId,
      userId,
      messageId: turn.assistantMessageId,
      blocks,
      tokenUsage: { inputTokens: 100, outputTokens: 40 },
    });

    expect(await getBalance(userId)).toBe(START);
    expect(await sumLedger(userId)).toBe(START);

    const message = await db.message.findUniqueOrThrow({
      where: { id: turn.assistantMessageId },
    });
    expect(message.status).toBe("success");
    expect(message.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 40 });

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("completed");
  });

  it("cannot resurrect a cancelled run", async () => {
    const { runId, userId } = await seedRun();
    const turn = await loadTurn(runId);
    await db.agentRun.update({ where: { id: runId }, data: { status: "cancelled" } });

    await completeTurn({
      runId,
      userId,
      messageId: turn.assistantMessageId,
      blocks,
      tokenUsage: null,
    });

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status, "cancel must not lose to a turn that was already mid-flight").toBe(
      "cancelled",
    );
    expect(await getBalance(userId), "the hold is still refunded either way").toBe(START);
  });

  it("pays the admission refund out exactly once across a replayed finalize", async () => {
    const { runId, userId } = await seedRun();
    const turn = await loadTurn(runId);
    const args = {
      runId,
      userId,
      messageId: turn.assistantMessageId,
      blocks,
      tokenUsage: null,
    };

    await completeTurn(args);
    await completeTurn(args);

    expect(await getBalance(userId)).toBe(START);
    expect(await sumLedger(userId)).toBe(START);
  });
});

describe("assets", () => {
  it("carries a completed tool's files onto the message the client reads", async () => {
    const { runId, userId } = await seedRun();
    const turn = await loadTurn(runId);

    await db.toolInvocation.create({
      data: {
        runId,
        toolUseId: "call_1",
        toolName: "gpt_image_2",
        status: "completed",
        input: {},
        output: { images: ["https://cdn.magica.com/fixtures/mountain.png"] },
        creditUsed: 5_880n,
      },
    });

    await completeTurn({
      runId,
      userId,
      messageId: turn.assistantMessageId,
      blocks,
      tokenUsage: null,
    });

    const message = await db.message.findUniqueOrThrow({
      where: { id: turn.assistantMessageId },
    });

    expect(
      message.assets,
      "the url lives in the invocation output; without this the client shows no image",
    ).toEqual([
      {
        url: "https://cdn.magica.com/fixtures/mountain.png",
        type: "image",
        model: "gpt_image_2",
        creditUsed: "5880",
        toolCallId: "call_1",
      },
    ]);
    expect(message.creditUsed, "and the spend is summed from the same invocations").toBe(5_880n);
  });

  it("reports which sub-model produced the output", async () => {
    const { runId } = await seedRun();
    await loadTurn(runId);

    await db.toolInvocation.create({
      data: {
        runId,
        toolUseId: "call_2",
        toolName: "gpt_image_2",
        subModelId: "gpt-image-2-text",
        status: "completed",
        input: {},
        output: { images: ["https://cdn.magica.com/fixtures/a.png"] },
        creditUsed: 5_880n,
      },
    });

    const { messages } = await listMessages({ chatId: (await db.agentRun.findUniqueOrThrow({
      where: { id: runId }, select: { chatId: true },
    })).chatId });

    const invocation = messages.flatMap((m) => m.toolInvocations).find((i) => i.toolUseId === "call_2");

    expect(
      invocation?.subModelId,
      "the card shows the model that ran; nothing else records it",
    ).toBe("gpt-image-2-text");
  });

  it("leaves assets untouched for a turn that produced no files", async () => {
    const { runId, userId } = await seedRun();
    const turn = await loadTurn(runId);

    await completeTurn({
      runId,
      userId,
      messageId: turn.assistantMessageId,
      blocks,
      tokenUsage: null,
    });

    const message = await db.message.findUniqueOrThrow({
      where: { id: turn.assistantMessageId },
    });

    expect(message.assets).toBeNull();
  });
});

describe("failTurn", () => {
  it("keeps the partial output and records why it failed", async () => {
    const { runId, userId } = await seedRun();
    const turn = await loadTurn(runId);

    await failTurn({
      runId,
      userId,
      messageId: turn.assistantMessageId,
      blocks,
      reason: "The model stopped responding partway through.",
    });

    const message = await db.message.findUniqueOrThrow({
      where: { id: turn.assistantMessageId },
    });
    expect(message.status).toBe("failed");
    expect(message.errorMessage).toBe("The model stopped responding partway through.");
    expect(message.content, "a failed turn still shows what the user watched happen").toBe(
      "Here is your mountain.",
    );

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("failed");
    expect(run.failureReason).toBe("The model stopped responding partway through.");
    expect(await getBalance(userId), "a failed turn costs nothing but its tools").toBe(START);
  });
});

describe("generated attachments in the media library", () => {
  const seedImageInvocation = (runId: string, url: string) =>
    db.toolInvocation.create({
      data: {
        runId,
        toolUseId: `call_${uuidv7()}`,
        toolName: "gpt_image_2",
        status: "completed",
        input: {},
        output: { images: [url] },
        creditUsed: 5_880n,
      },
      select: { id: true },
    });

  it("finalize inserts a ready generated row for each produced file", async () => {
    const { runId, userId, chatId } = await seedRun();
    const turn = await loadTurn(runId);
    const invocation = await seedImageInvocation(runId, "https://cdn.magica.com/gen/sunrise.png");

    await completeTurn({
      runId,
      userId,
      messageId: turn.assistantMessageId,
      blocks,
      tokenUsage: null,
    });

    const rows = await db.attachment.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "generated",
      status: "ready",
      chatId,
      toolInvocationId: invocation.id,
      type: "image",
      url: "https://cdn.magica.com/gen/sunrise.png",
      name: "sunrise.png",
      contentType: "image/png",
    });
  });

  it("a re-run finalize (what a retry does) lists each file once", async () => {
    const { runId, userId } = await seedRun();
    const turn = await loadTurn(runId);
    await seedImageInvocation(runId, "https://cdn.magica.com/gen/one.png");

    const args = { runId, userId, messageId: turn.assistantMessageId, blocks, tokenUsage: null };
    await completeTurn(args);
    await completeTurn(args);

    expect(await db.attachment.count({ where: { userId, source: "generated" } })).toBe(1);
  });

  it("a failed turn still lists what its completed tools produced", async () => {
    const { runId, userId } = await seedRun();
    const turn = await loadTurn(runId);
    await seedImageInvocation(runId, "https://cdn.magica.com/gen/partial.png");

    await failTurn({
      runId,
      userId,
      messageId: turn.assistantMessageId,
      blocks,
      reason: "The model is busy right now.",
    });

    expect(await db.attachment.count({ where: { userId, source: "generated" } })).toBe(1);
  });
});

describe("history carries file context", () => {
  it("threads attachment and asset URLs into the turn's history", async () => {
    const { runId, chatId } = await seedRun();

    await db.message.create({
      data: {
        chatId,
        role: "user",
        content: "Darken this",
        attachments: [
          {
            id: "att_1",
            type: "image",
            source: "uploaded",
            url: "https://tmp.transloadit.com/shot.png",
            name: "shot.png",
            contentType: "image/png",
            size: 100,
            status: "ready",
            metadata: null,
            expiresAt: null,
            createdAt: new Date().toISOString(),
          },
        ],
      },
    });
    await db.message.create({
      data: {
        chatId,
        role: "assistant",
        status: "success",
        content: "Done.",
        assets: [
          {
            url: "https://cdn.magica.com/gen/dark.png",
            type: "image",
            model: "gpt_image_2",
            creditUsed: "5880",
            toolCallId: "call_9",
          },
        ],
      },
    });

    const turn = await loadTurn(runId);

    const userEntry = turn.history.find((m) => m.content === "Darken this");
    expect(userEntry?.files).toEqual([
      { name: "shot.png", type: "image", url: "https://tmp.transloadit.com/shot.png" },
    ]);

    const assistantEntry = turn.history.find((m) => m.content === "Done.");
    expect(assistantEntry?.files, "cross-turn edits need the generated URL in history").toEqual([
      { name: "dark.png", type: "image", url: "https://cdn.magica.com/gen/dark.png" },
    ]);
  });
});
