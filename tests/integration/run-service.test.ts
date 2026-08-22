import { afterAll, describe, expect, it } from "vitest";
import type { ContentBlock, SendMessageResult } from "@/contracts";
import {
  chargeTool,
  getBalance,
  refundAdmission,
  reserveAdmission,
  sumLedger,
  topUp,
} from "@/lib/credits";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { uuidv7 } from "@/lib/ids";
import { logger } from "@/lib/logger";
import {
  cancelRun,
  resolveStaleRun,
  retryTurn,
  type DispatchArgs,
  type RunControl,
} from "@/services/run.service";

const START = 10_000_000n;
const TOOL_COST = 5_880n;
const created: string[] = [];

const blocks: ContentBlock[] = [
  { segment: 0, type: "text", text: "Working on that mountain." },
  { segment: 0, type: "tool_use", id: "call_1", name: "gpt_image_2", input: { prompt: "peak" } },
];

/** Records what the compensating path asked Trigger.dev to do, and in what order. */
function fakeControl(over?: Partial<RunControl>) {
  const calls: string[] = [];

  const control: RunControl = {
    cancel: async (id) => {
      calls.push(`cancel:${id}`);
      await over?.cancel?.(id);
    },
    statusOf: async (id) => {
      calls.push(`statusOf:${id}`);
      return (await over?.statusOf?.(id)) ?? null;
    },
    expireWaitpoint: async (id) => {
      calls.push(`expireWaitpoint:${id}`);
      await over?.expireWaitpoint?.(id);
    },
  };

  return { control, calls };
}

const dispatched: DispatchArgs[] = [];

const fakeDispatch = (args: DispatchArgs): Promise<SendMessageResult> => {
  dispatched.push(args);
  return Promise.resolve({
    chatId: args.chatId,
    userMessageId: args.userMessageId,
    assistantMessageId: args.assistantMessageId,
    runId: args.runId,
    triggerRunId: "run_fake",
    publicAccessToken: "tok_fake",
  });
};

async function seedRun(a?: {
  runStatus?: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";
  messageStatus?: "streaming" | "success" | "failed" | "cancelled";
  triggerRunId?: string | null;
  createdAt?: Date;
  admit?: boolean;
}) {
  const userId = `test_${uuidv7()}`;
  created.push(userId);

  const chatId = uuidv7();
  const runId = uuidv7();
  const userMessageId = uuidv7();
  const assistantMessageId = uuidv7();

  await db.user.create({ data: { id: userId, email: `${userId}@test.local` } });
  await db.$transaction((tx) => topUp(tx, { userId, amount: START, key: userId }));
  await db.chat.create({ data: { id: chatId, userId, title: "t" } });
  await db.message.create({ data: { id: userMessageId, chatId, role: "user", content: "draw" } });

  await db.agentRun.create({
    data: {
      id: runId,
      chatId,
      userId,
      userMessageId,
      idempotencyKey: `${userMessageId}:1`,
      status: a?.runStatus ?? "running",
      triggerRunId: a?.triggerRunId === undefined ? `run_${runId}` : a.triggerRunId,
      ...(a?.createdAt ? { createdAt: a.createdAt } : {}),
    },
  });

  await db.message.create({
    data: {
      id: assistantMessageId,
      chatId,
      runId,
      role: "assistant",
      status: a?.messageStatus ?? "streaming",
      content: "Working on that mountain.",
      contentBlocks: blocks as never,
    },
  });

  await db.agentRun.update({ where: { id: runId }, data: { assistantMessageId } });

  if (a?.admit !== false) {
    await db.$transaction((tx) => reserveAdmission(tx, { userId, runId }));
  }

  return { userId, chatId, runId, userMessageId, assistantMessageId };
}

/** A tool that was charged before it ran, which is the only order charges ever happen in. */
async function seedInvocation(a: {
  userId: string;
  runId: string;
  toolUseId: string;
  status: "pending" | "running" | "completed";
}) {
  const invocation = await db.toolInvocation.create({
    data: {
      runId: a.runId,
      toolUseId: a.toolUseId,
      toolName: "gpt_image_2",
      status: a.status,
      input: {},
      creditUsed: TOOL_COST,
      startedAt: new Date(),
      ...(a.status === "completed" ? { completedAt: new Date() } : {}),
    },
    select: { id: true },
  });

  await db.$transaction((tx) =>
    chargeTool(tx, {
      userId: a.userId,
      invocationId: invocation.id,
      runId: a.runId,
      amount: TOOL_COST,
    }),
  );

  return invocation.id;
}

const ledgerHolds = async (userId: string) => {
  expect(await getBalance(userId), "balance must equal SUM(ledger)").toBe(await sumLedger(userId));
};

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
});

describe("cancelRun", () => {
  it("keeps the partial output, refunds the hold, and leaves settled work paid for", async () => {
    const { userId, runId, assistantMessageId } = await seedRun();
    await seedInvocation({ userId, runId, toolUseId: "call_1", status: "completed" });

    await cancelRun({ userId, runId, log: logger, control: fakeControl().control });

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("cancelled");

    const message = await db.message.findUniqueOrThrow({ where: { id: assistantMessageId } });
    expect(message.status).toBe("cancelled");
    expect(message.content, "a cancelled turn still shows what the user watched").toBe(
      "Working on that mountain.",
    );
    expect(message.contentBlocks).not.toBeNull();
    expect(message.errorMessage, "a cancel is not an error").toBeNull();

    expect(
      await getBalance(userId),
      "the admission comes back; work already done stays paid for",
    ).toBe(START - TOOL_COST);
    await ledgerHolds(userId);
  });

  it("terminates our rows before stopping the machine", async () => {
    const { userId, runId } = await seedRun();

    let statusWhenStopped: string | null = null;
    const { control } = fakeControl({
      cancel: async () => {
        const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
        statusWhenStopped = run.status;
      },
    });

    await cancelRun({ userId, runId, log: logger, control });

    expect(
      statusWhenStopped,
      "the cancel guard must already bite when the task is still alive",
    ).toBe("cancelled");
  });

  it("sweeps a pending waitpoint and closes its token, so no overlay is left behind", async () => {
    const { userId, runId } = await seedRun({ runStatus: "waiting" });
    const tokenId = `wp_${uuidv7()}`;

    await db.waitpoint.create({
      data: { id: tokenId, runId, kind: "plan_approval", payload: { steps: [] } },
    });

    const { control, calls } = fakeControl();
    await cancelRun({ userId, runId, log: logger, control });

    const waitpoint = await db.waitpoint.findUniqueOrThrow({ where: { id: tokenId } });
    expect(waitpoint.status).toBe("expired");
    expect(waitpoint.resolution).toEqual({ expired: true });
    expect(calls).toContain(`expireWaitpoint:${tokenId}`);
  });

  it("closes an in-flight tool without refunding it — the provider may already have billed", async () => {
    const { userId, runId } = await seedRun();
    const open = await seedInvocation({ userId, runId, toolUseId: "call_open", status: "running" });
    await seedInvocation({ userId, runId, toolUseId: "call_done", status: "completed" });

    await cancelRun({ userId, runId, log: logger, control: fakeControl().control });

    const cancelled = await db.toolInvocation.findUniqueOrThrow({ where: { id: open } });
    expect(cancelled.status, "no card may claim to still be working").toBe("cancelled");
    expect(cancelled.creditUsed, "the charge for started work stands").toBe(TOOL_COST);

    expect(await getBalance(userId), "both charges stand; only the admission comes back").toBe(
      START - TOOL_COST * 2n,
    );
    await ledgerHolds(userId);
  });

  it("is a no-op on a run that already finished, and never touches the machine", async () => {
    const { userId, runId } = await seedRun({
      runStatus: "completed",
      messageStatus: "success",
    });

    const { control, calls } = fakeControl();
    await expect(cancelRun({ userId, runId, log: logger, control })).resolves.toBeUndefined();

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status, "a stop pressed as a turn lands must not rewrite the outcome").toBe(
      "completed",
    );
    expect(calls).toEqual([]);
  });

  it("survives a Trigger.dev failure, because our rows are the source of truth", async () => {
    const { userId, runId } = await seedRun();

    const { control } = fakeControl({
      cancel: () => Promise.reject(new Error("trigger.dev unreachable")),
    });

    await expect(cancelRun({ userId, runId, log: logger, control })).resolves.toBeUndefined();

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("cancelled");
    await ledgerHolds(userId);
  });

  it("hides another user's run behind a not-found", async () => {
    const { runId } = await seedRun();
    const stranger = await seedRun();

    await expect(
      cancelRun({ userId: stranger.userId, runId, log: logger, control: fakeControl().control }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("cancels a queued run that has no machine yet", async () => {
    const { userId, runId } = await seedRun({ runStatus: "queued", triggerRunId: null });

    const { control, calls } = fakeControl();
    await cancelRun({ userId, runId, log: logger, control });

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("cancelled");
    expect(calls, "there is no run id to cancel remotely").toEqual([]);
    await ledgerHolds(userId);
  });
});

describe("retryTurn", () => {
  it("resets the assistant row, bumps the attempt, and re-admits the run", async () => {
    const { userId, runId, userMessageId, assistantMessageId } = await seedRun({
      runStatus: "failed",
      messageStatus: "failed",
    });
    await db.message.update({
      where: { id: assistantMessageId },
      data: { errorMessage: "The model stopped responding partway through." },
    });
    await db.$transaction((tx) => reserveAdmission(tx, { userId, runId }));

    dispatched.length = 0;
    const result = await retryTurn({
      userId,
      messageId: assistantMessageId,
      log: logger,
      dispatch: fakeDispatch,
    });

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("queued");
    expect(run.attempt).toBe(2);
    expect(run.idempotencyKey, "a new key is what lets Trigger.dev accept the work twice").toBe(
      `${userMessageId}:2`,
    );
    expect(run.triggerRunId, "the dead attempt's machine must not be asked about again").toBeNull();
    expect(run.failureReason).toBeNull();

    const message = await db.message.findUniqueOrThrow({ where: { id: assistantMessageId } });
    expect(message.status).toBe("streaming");
    expect(message.content).toBe("");
    expect(message.contentBlocks).toBeNull();
    expect(message.errorMessage).toBeNull();
    expect(message.creditUsed).toBe(0n);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.idempotencyKey).toBe(`${userMessageId}:2`);
    expect(result.assistantMessageId, "the retry replaces the row the user is looking at").toBe(
      assistantMessageId,
    );

    await ledgerHolds(userId);
  });

  it("retries a cancelled turn, refunding whatever it still held", async () => {
    const { userId, runId, assistantMessageId } = await seedRun({
      runStatus: "cancelled",
      messageStatus: "cancelled",
    });
    const open = await seedInvocation({
      userId,
      runId,
      toolUseId: "call_open",
      status: "pending",
    });

    // Every terminal path refunds the admission, so a cancelled run holds none going in. Seeding
    // the status directly skips that, and leaving it held would have the run holding two at once.
    await db.$transaction((tx) => refundAdmission(tx, { userId, runId }));

    dispatched.length = 0;
    await retryTurn({ userId, messageId: assistantMessageId, log: logger, dispatch: fakeDispatch });

    const invocation = await db.toolInvocation.findUniqueOrThrow({ where: { id: open } });
    expect(invocation.status).toBe("cancelled");

    expect(
      await getBalance(userId),
      "the unsettled charge is refunded and exactly one fresh hold is taken",
    ).toBe(START - env.ADMISSION_CREDITS);
    await ledgerHolds(userId);
  });

  it("takes a hold the first attempt's key would have swallowed", async () => {
    const { userId, runId, assistantMessageId } = await seedRun({
      runStatus: "failed",
      messageStatus: "failed",
    });
    await db.$transaction((tx) => refundAdmission(tx, { userId, runId }));

    await retryTurn({ userId, messageId: assistantMessageId, log: logger, dispatch: fakeDispatch });

    const holds = await db.creditLedgerEntry.findMany({
      where: { runId, type: "reserve" },
      select: { idempotencyKey: true },
      orderBy: { idempotencyKey: "asc" },
    });

    expect(
      holds.map((h) => h.idempotencyKey),
      "the attempt is part of the key, or the second hold silently no-ops",
    ).toEqual([`reserve:${runId}:1`, `reserve:${runId}:2`]);

    expect(await getBalance(userId)).toBe(START - env.ADMISSION_CREDITS);
    await ledgerHolds(userId);
  });

  it("refuses a turn that succeeded", async () => {
    const { userId, assistantMessageId } = await seedRun({
      runStatus: "completed",
      messageStatus: "success",
    });

    await expect(
      retryTurn({ userId, messageId: assistantMessageId, log: logger, dispatch: fakeDispatch }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("refuses a turn that is still running", async () => {
    const { userId, assistantMessageId } = await seedRun({ runStatus: "running" });

    await expect(
      retryTurn({ userId, messageId: assistantMessageId, log: logger, dispatch: fakeDispatch }),
    ).rejects.toMatchObject({ code: "RUN_ALREADY_ACTIVE" });
  });

  it("hides another user's message behind a not-found", async () => {
    const { assistantMessageId } = await seedRun({ runStatus: "failed", messageStatus: "failed" });
    const stranger = await seedRun();

    await expect(
      retryTurn({
        userId: stranger.userId,
        messageId: assistantMessageId,
        log: logger,
        dispatch: fakeDispatch,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not dispatch when the run cannot be re-admitted", async () => {
    const { userId, chatId, assistantMessageId } = await seedRun({
      runStatus: "failed",
      messageStatus: "failed",
    });

    // A second live run already holds the chat's slot, so the partial index rejects the reset.
    const blockerMessageId = uuidv7();
    await db.message.create({
      data: { id: blockerMessageId, chatId, role: "user", content: "again" },
    });
    await db.agentRun.create({
      data: {
        chatId,
        userId,
        userMessageId: blockerMessageId,
        idempotencyKey: `${blockerMessageId}:1`,
        status: "running",
      },
    });

    dispatched.length = 0;
    await expect(
      retryTurn({ userId, messageId: assistantMessageId, log: logger, dispatch: fakeDispatch }),
    ).rejects.toMatchObject({ code: "RUN_ALREADY_ACTIVE" });

    expect(dispatched, "a rejected retry must not start a turn").toHaveLength(0);
    await ledgerHolds(userId);
  });
});

describe("resolveStaleRun", () => {
  it("reports a free slot", async () => {
    const { userId, chatId } = await seedRun({ runStatus: "completed", messageStatus: "success" });

    await expect(
      resolveStaleRun({ userId, chatId, log: logger, control: fakeControl().control }),
    ).resolves.toBe("gone");
  });

  it("holds the slot for a dispatch that may still be landing", async () => {
    const { userId, chatId } = await seedRun({ runStatus: "queued", triggerRunId: null });

    const { control, calls } = fakeControl();
    await expect(resolveStaleRun({ userId, chatId, log: logger, control })).resolves.toBe("active");
    expect(calls, "there is nothing to ask about").toEqual([]);
  });

  it("recovers a run whose dispatch never landed", async () => {
    const { userId, chatId, runId, assistantMessageId } = await seedRun({
      runStatus: "queued",
      triggerRunId: null,
      createdAt: new Date(Date.now() - 120_000),
    });

    await expect(
      resolveStaleRun({ userId, chatId, log: logger, control: fakeControl().control }),
    ).resolves.toBe("recovered");

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("failed");

    const message = await db.message.findUniqueOrThrow({ where: { id: assistantMessageId } });
    expect(message.status).toBe("failed");
    expect(message.errorMessage, "the user is told what to do next").toMatch(/try sending it again/i);

    expect(await getBalance(userId), "a run that never started costs nothing").toBe(START);
    await ledgerHolds(userId);
  });

  it("never judges a live run by its age", async () => {
    const { userId, chatId, runId } = await seedRun({
      runStatus: "waiting",
      createdAt: new Date(Date.now() - 14 * 60_000),
    });

    const { control } = fakeControl({ statusOf: () => Promise.resolve("WAITING") });
    await expect(resolveStaleRun({ userId, chatId, log: logger, control })).resolves.toBe("active");

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status, "a run suspended on a waitpoint is idle, not dead").toBe("waiting");
  });

  it("trusts Trigger.dev when it says the run is executing", async () => {
    const { userId, chatId } = await seedRun();

    const { control } = fakeControl({ statusOf: () => Promise.resolve("EXECUTING") });
    await expect(resolveStaleRun({ userId, chatId, log: logger, control })).resolves.toBe("active");
  });

  it("recovers a run that crashed without finalizing", async () => {
    const { userId, chatId, runId } = await seedRun();

    const { control } = fakeControl({ statusOf: () => Promise.resolve("CRASHED") });
    await expect(resolveStaleRun({ userId, chatId, log: logger, control })).resolves.toBe(
      "recovered",
    );

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("failed");
    expect(await getBalance(userId)).toBe(START);
    await ledgerHolds(userId);
  });

  it("treats a run Trigger.dev has never heard of as terminal", async () => {
    const { userId, chatId, runId } = await seedRun();

    const { control } = fakeControl({ statusOf: () => Promise.resolve(null) });
    await expect(resolveStaleRun({ userId, chatId, log: logger, control })).resolves.toBe(
      "recovered",
    );

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("failed");
  });

  it("keeps the slot held when it cannot find out, rather than admitting a second turn", async () => {
    const { userId, chatId, runId } = await seedRun();

    const { control } = fakeControl({
      statusOf: () => Promise.reject(new AppError("INTERNAL", "trigger.dev unreachable")),
    });
    await expect(resolveStaleRun({ userId, chatId, log: logger, control })).resolves.toBe("active");

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status, "not knowing is not the same as knowing it is dead").toBe("running");
    expect(await getBalance(userId)).toBe(START - env.ADMISSION_CREDITS);
  });

  it("expires the waitpoints of a run it recovers", async () => {
    const { userId, chatId, runId } = await seedRun({ runStatus: "waiting" });
    const tokenId = `wp_${uuidv7()}`;

    await db.waitpoint.create({
      data: { id: tokenId, runId, kind: "questions", payload: { questions: [] } },
    });

    const { control, calls } = fakeControl({ statusOf: () => Promise.resolve("TIMED_OUT") });
    await expect(resolveStaleRun({ userId, chatId, log: logger, control })).resolves.toBe(
      "recovered",
    );

    const waitpoint = await db.waitpoint.findUniqueOrThrow({ where: { id: tokenId } });
    expect(waitpoint.status).toBe("expired");
    expect(calls).toContain(`expireWaitpoint:${tokenId}`);
  });
});
