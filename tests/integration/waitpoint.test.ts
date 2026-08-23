import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const clerk = vi.hoisted(() => ({ userId: null as string | null }));
const trigger = vi.hoisted(() => ({ completed: [] as { id: string; resolution: unknown }[] }));

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => Promise.resolve({ userId: clerk.userId }),
  currentUser: () =>
    Promise.resolve(
      clerk.userId ? { primaryEmailAddress: { emailAddress: `${clerk.userId}@clerk.test` } } : null,
    ),
}));

// The route reaches Trigger.dev for real: minting the client's realtime token, and completing the
// token that wakes the parked task. Both are recorded rather than performed.
vi.mock("@trigger.dev/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@trigger.dev/sdk")>();
  return {
    ...actual,
    auth: { ...actual.auth, createPublicToken: () => Promise.resolve("pat_test_token") },
    wait: {
      ...actual.wait,
      completeToken: (token: string | { id: string }, resolution: unknown) => {
        trigger.completed.push({
          id: typeof token === "string" ? token : token.id,
          resolution,
        });
        return Promise.resolve({ success: true });
      },
    },
  };
});

const { db } = await import("@/lib/db");
const { uuidv7 } = await import("@/lib/ids");
const { logger } = await import("@/lib/logger");
const { AppError } = await import("@/lib/errors");
const { closeWaitpoint, openWaitpoint, resolveWaitpoint } = await import(
  "@/services/waitpoint.service"
);
type WaitpointControl = import("@/services/waitpoint.service").WaitpointControl;
const { markTurnRunning, markTurnWaiting } = await import("@/services/turn.service");

const resolveRoute = await import("@/app/api/v1/waitpoints/[waitpointId]/resolve/route");
const activeRunRoute = await import("@/app/api/v1/chats/[chatId]/active-run/route");

const created: string[] = [];

const PLAN = {
  title: "Poster",
  overview: "One image.",
  steps: [
    {
      key: "hero",
      title: "Generate",
      description: "The poster",
      tool: "gpt_image_2",
      subModelId: null,
      estimatedCredits: "5880",
    },
  ],
  estimatedTotal: "5880",
};

/** Records what the resolve path asked Trigger.dev to do, without a worker anywhere. */
function fakeControl(over?: { completeToken?: (id: string) => Promise<void> }) {
  const completed: { id: string; resolution: unknown }[] = [];

  const control: WaitpointControl = {
    completeToken: async (id, resolution) => {
      completed.push({ id, resolution });
      await over?.completeToken?.(id);
    },
  };

  return { control, completed };
}

async function seedWaitpoint(a?: {
  status?: "pending" | "completed" | "expired";
  kind?: "plan_approval" | "questions";
  payload?: unknown;
}) {
  const userId = `test_${uuidv7()}`;
  created.push(userId);

  const chatId = uuidv7();
  const runId = uuidv7();
  const userMessageId = uuidv7();
  const waitpointId = `waitpoint_${uuidv7()}`;

  await db.user.create({ data: { id: userId, email: `${userId}@test.local` } });
  await db.chat.create({ data: { id: chatId, userId, title: "t" } });
  await db.message.create({ data: { id: userMessageId, chatId, role: "user", content: "draw" } });
  await db.agentRun.create({
    data: {
      id: runId,
      chatId,
      userId,
      userMessageId,
      idempotencyKey: `${userMessageId}:1`,
      status: "running",
      triggerRunId: `run_${runId}`,
    },
  });

  const invocation = await db.toolInvocation.create({
    data: {
      runId,
      toolUseId: `call_${uuidv7()}`,
      toolName: "submit_plan",
      status: "running",
      input: PLAN,
      startedAt: new Date(),
    },
    select: { id: true },
  });

  await openWaitpoint({
    id: waitpointId,
    runId,
    kind: a?.kind ?? "plan_approval",
    payload: a?.payload ?? PLAN,
    invocationId: invocation.id,
  });

  if (a?.status && a.status !== "pending") {
    await db.waitpoint.update({
      where: { id: waitpointId },
      data: { status: a.status, resolution: a.status === "expired" ? { expired: true } : {} },
    });
  }

  return { userId, chatId, runId, waitpointId, invocationId: invocation.id };
}

const resolve = (waitpointId: string, body: unknown) =>
  resolveRoute.POST(
    new Request(`http://localhost/api/v1/waitpoints/${waitpointId}/resolve`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ waitpointId }) },
  );

async function envelope<T>(res: Response) {
  return (await res.json()) as { data?: T; error?: { code: string; message: string } };
}

beforeEach(() => {
  clerk.userId = null;
  trigger.completed.length = 0;
});

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
});

describe("resolveWaitpoint", () => {
  it("records the answer and wakes the run exactly once", async () => {
    const seeded = await seedWaitpoint();
    const { control, completed } = fakeControl();
    const resolution = { kind: "plan_approval" as const, approved: true, executionMode: "auto" as const };

    await resolveWaitpoint({
      userId: seeded.userId,
      waitpointId: seeded.waitpointId,
      resolution,
      log: logger,
      control,
    });

    const row = await db.waitpoint.findUniqueOrThrow({ where: { id: seeded.waitpointId } });
    expect(row.status).toBe("completed");
    expect(row.resolution).toEqual(resolution);
    expect(completed).toEqual([{ id: seeded.waitpointId, resolution }]);
  });

  it("passes the resolution through verbatim, so a new kind needs no change here", async () => {
    const seeded = await seedWaitpoint({ kind: "questions" });
    const { control, completed } = fakeControl();
    const resolution = {
      kind: "questions" as const,
      answers: { city: "New York", palette: ["warm", "gold"] },
      skipped: ["reference_photo"],
    };

    await resolveWaitpoint({
      userId: seeded.userId,
      waitpointId: seeded.waitpointId,
      resolution,
      log: logger,
      control,
    });

    expect(completed[0]?.resolution).toEqual(resolution);
  });

  it("treats a double-clicked resolve as a no-op, not a second resumption", async () => {
    const seeded = await seedWaitpoint();
    const { control, completed } = fakeControl();
    const resolution = { kind: "plan_approval" as const, approved: true };
    const twice = () =>
      resolveWaitpoint({
        userId: seeded.userId,
        waitpointId: seeded.waitpointId,
        resolution,
        log: logger,
        control,
      });

    await twice();
    await twice();

    expect(completed, "the parked task must be woken once").toHaveLength(1);
  });

  it("resolves concurrently only once, because the update is conditional", async () => {
    const seeded = await seedWaitpoint();
    const { control, completed } = fakeControl();
    const resolution = { kind: "plan_approval" as const, approved: true };

    await Promise.all(
      Array.from({ length: 3 }, () =>
        resolveWaitpoint({
          userId: seeded.userId,
          waitpointId: seeded.waitpointId,
          resolution,
          log: logger,
          control,
        }),
      ),
    );

    expect(completed).toHaveLength(1);
  });

  it("reports an expired waitpoint as expired, not as already answered", async () => {
    const seeded = await seedWaitpoint({ status: "expired" });
    const { control, completed } = fakeControl();

    await expect(
      resolveWaitpoint({
        userId: seeded.userId,
        waitpointId: seeded.waitpointId,
        resolution: { kind: "plan_approval", approved: true },
        log: logger,
        control,
      }),
    ).rejects.toMatchObject({ code: "WAITPOINT_EXPIRED" });

    expect(completed).toHaveLength(0);
  });

  it("rejects a resolution of the wrong kind for the row", async () => {
    const seeded = await seedWaitpoint({ kind: "plan_approval" });
    const { control, completed } = fakeControl();

    await expect(
      resolveWaitpoint({
        userId: seeded.userId,
        waitpointId: seeded.waitpointId,
        resolution: { kind: "questions", answers: {}, skipped: [] },
        log: logger,
        control,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const row = await db.waitpoint.findUniqueOrThrow({ where: { id: seeded.waitpointId } });
    expect(row.status, "a mismatch must not settle the row").toBe("pending");
    expect(completed).toHaveLength(0);
  });

  it("answers NOT_FOUND for someone else's waitpoint, which does not confirm it exists", async () => {
    const seeded = await seedWaitpoint();
    const stranger = await seedWaitpoint();
    const { control, completed } = fakeControl();

    await expect(
      resolveWaitpoint({
        userId: stranger.userId,
        waitpointId: seeded.waitpointId,
        resolution: { kind: "plan_approval", approved: true },
        log: logger,
        control,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const row = await db.waitpoint.findUniqueOrThrow({ where: { id: seeded.waitpointId } });
    expect(row.status).toBe("pending");
    expect(completed).toHaveLength(0);
  });

  it("answers NOT_FOUND for an id that does not exist", async () => {
    const seeded = await seedWaitpoint();

    await expect(
      resolveWaitpoint({
        userId: seeded.userId,
        waitpointId: `waitpoint_${uuidv7()}`,
        resolution: { kind: "plan_approval", approved: true },
        log: logger,
        control: fakeControl().control,
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("reports a token that cannot be completed as expired", async () => {
    const seeded = await seedWaitpoint();
    const { control } = fakeControl({
      completeToken: () => Promise.reject(new Error("trigger.dev unreachable")),
    });

    await expect(
      resolveWaitpoint({
        userId: seeded.userId,
        waitpointId: seeded.waitpointId,
        resolution: { kind: "plan_approval", approved: true },
        log: logger,
        control,
      }),
    ).rejects.toMatchObject({ code: "WAITPOINT_EXPIRED" });
  });
});

describe("the parked side of the same row", () => {
  it("marks the run waiting while parked and running again once answered", async () => {
    const seeded = await seedWaitpoint();

    await markTurnWaiting(seeded.runId);
    await expect(
      db.agentRun.findUniqueOrThrow({ where: { id: seeded.runId } }),
    ).resolves.toMatchObject({ status: "waiting" });

    await markTurnRunning(seeded.runId);
    await expect(
      db.agentRun.findUniqueOrThrow({ where: { id: seeded.runId } }),
    ).resolves.toMatchObject({ status: "running" });
  });

  it("never resurrects a run cancelled while it was parked", async () => {
    const seeded = await seedWaitpoint();
    await db.agentRun.update({ where: { id: seeded.runId }, data: { status: "cancelled" } });

    await markTurnRunning(seeded.runId);

    await expect(
      db.agentRun.findUniqueOrThrow({ where: { id: seeded.runId } }),
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it("does not overwrite an answer already recorded, when the task wakes up afterwards", async () => {
    const seeded = await seedWaitpoint();
    const resolution = { kind: "plan_approval" as const, approved: true };

    await resolveWaitpoint({
      userId: seeded.userId,
      waitpointId: seeded.waitpointId,
      resolution,
      log: logger,
      control: fakeControl().control,
    });

    await closeWaitpoint({ id: seeded.waitpointId, status: "completed", resolution });

    const row = await db.waitpoint.findUniqueOrThrow({ where: { id: seeded.waitpointId } });
    expect(row.resolution).toEqual(resolution);
  });

  it("records a timeout as expired", async () => {
    const seeded = await seedWaitpoint();

    await closeWaitpoint({
      id: seeded.waitpointId,
      status: "expired",
      resolution: { expired: true },
    });

    const row = await db.waitpoint.findUniqueOrThrow({ where: { id: seeded.waitpointId } });
    expect(row.status).toBe("expired");
    expect(row.resolution).toEqual({ expired: true });
  });

  it("links the waitpoint to the invocation whose card renders it", async () => {
    const seeded = await seedWaitpoint();

    const row = await db.waitpoint.findUniqueOrThrow({ where: { id: seeded.waitpointId } });
    expect(row.invocationId).toBe(seeded.invocationId);
  });
});

describe("POST /waitpoints/:id/resolve", () => {
  it("answers { ok: true } and records the approval", async () => {
    const seeded = await seedWaitpoint();
    clerk.userId = seeded.userId;

    const res = await resolve(seeded.waitpointId, { kind: "plan_approval", approved: true });

    expect(res.status).toBe(200);
    expect((await envelope<{ ok: true }>(res)).data).toEqual({ ok: true });
    await expect(
      db.waitpoint.findUniqueOrThrow({ where: { id: seeded.waitpointId } }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(
      trigger.completed,
      "the route wakes the parked task through the real seam, not an injected one",
    ).toEqual([
      { id: seeded.waitpointId, resolution: { kind: "plan_approval", approved: true } },
    ]);
  });

  it("carries a change request back with its feedback", async () => {
    const seeded = await seedWaitpoint();
    clerk.userId = seeded.userId;

    await resolve(seeded.waitpointId, {
      kind: "plan_approval",
      approved: false,
      feedback: "Also add a bit of flair",
    });

    const row = await db.waitpoint.findUniqueOrThrow({ where: { id: seeded.waitpointId } });
    expect(row.resolution).toMatchObject({ approved: false, feedback: "Also add a bit of flair" });
  });

  it("refuses an expiry submitted by a client, which is the server's to write", async () => {
    const seeded = await seedWaitpoint();
    clerk.userId = seeded.userId;

    const res = await resolve(seeded.waitpointId, { expired: true });

    expect(res.status).toBe(400);
    expect((await envelope(res)).error?.code).toBe("VALIDATION_ERROR");
    await expect(
      db.waitpoint.findUniqueOrThrow({ where: { id: seeded.waitpointId } }),
    ).resolves.toMatchObject({ status: "pending" });
  });

  it("requires a signed-in caller", async () => {
    const seeded = await seedWaitpoint();
    clerk.userId = null;

    const res = await resolve(seeded.waitpointId, { kind: "plan_approval", approved: true });

    expect(res.status).toBe(401);
  });

  it("hides another user's waitpoint behind a 404", async () => {
    const seeded = await seedWaitpoint();
    const stranger = await seedWaitpoint();
    clerk.userId = stranger.userId;

    const res = await resolve(seeded.waitpointId, { kind: "plan_approval", approved: true });

    expect(res.status).toBe(404);
    expect((await envelope(res)).error?.code).toBe("NOT_FOUND");
  });

  it("returns 410 once the request has expired", async () => {
    const seeded = await seedWaitpoint({ status: "expired" });
    clerk.userId = seeded.userId;

    const res = await resolve(seeded.waitpointId, { kind: "plan_approval", approved: true });

    expect(res.status).toBe(410);
    expect((await envelope(res)).error?.code).toBe("WAITPOINT_EXPIRED");
  });
});

describe("a client reloading while a turn is parked", () => {
  it("rebuilds the overlay from the database alone", async () => {
    const seeded = await seedWaitpoint();
    await markTurnWaiting(seeded.runId);
    clerk.userId = seeded.userId;

    const res = await activeRunRoute.GET(
      new Request(`http://localhost/api/v1/chats/${seeded.chatId}/active-run`),
      { params: Promise.resolve({ chatId: seeded.chatId }) },
    );

    const body = await envelope<{
      status: string;
      pendingWaitpoint: { id: string; kind: string; payload: typeof PLAN } | null;
    }>(res);

    expect(body.data?.status, "a parked run is waiting, not running").toBe("waiting");
    expect(body.data?.pendingWaitpoint).toMatchObject({
      id: seeded.waitpointId,
      kind: "plan_approval",
    });
    expect(
      body.data?.pendingWaitpoint?.payload.steps[0]?.estimatedCredits,
      "the priced plan survives a reload",
    ).toBe("5880");
  });
});

describe("image answers", () => {
  const QUESTIONS = {
    message: "Two things before I spend credits.",
    questions: [
      { id: "reference", type: "image", prompt: "A reference photo?", required: false, maxImages: 2 },
      { id: "mood", type: "text", prompt: "What mood?", required: false },
    ],
  };

  const seedReadyAttachment = (userId: string, url: string) =>
    db.attachment.create({
      data: {
        userId,
        status: "ready",
        type: "image",
        url,
        name: "ref.png",
        contentType: "image/png",
        size: 100,
      },
      select: { id: true },
    });

  it("resolves attachment ids to URLs server-side, for the row and the woken task alike", async () => {
    const seeded = await seedWaitpoint({ kind: "questions", payload: QUESTIONS });
    const { control, completed } = fakeControl();
    const attachment = await seedReadyAttachment(seeded.userId, "https://tmp.transloadit.com/ref.png");

    await resolveWaitpoint({
      userId: seeded.userId,
      waitpointId: seeded.waitpointId,
      resolution: {
        kind: "questions",
        answers: { reference: attachment.id, mood: "calm" },
        skipped: [],
      },
      log: logger,
      control,
    });

    const row = await db.waitpoint.findUniqueOrThrow({ where: { id: seeded.waitpointId } });
    const stored = row.resolution as { answers: Record<string, unknown> };
    expect(stored.answers.reference, "ids never survive past resolve time").toBe(
      "https://tmp.transloadit.com/ref.png",
    );
    expect(stored.answers.mood, "non-image answers pass through untouched").toBe("calm");
    expect(
      (completed[0]?.resolution as { answers: Record<string, unknown> }).answers.reference,
    ).toBe("https://tmp.transloadit.com/ref.png");
  });

  it("resolves a multi-image answer in order", async () => {
    const seeded = await seedWaitpoint({ kind: "questions", payload: QUESTIONS });
    const { control } = fakeControl();
    const first = await seedReadyAttachment(seeded.userId, "https://tmp.transloadit.com/a.png");
    const second = await seedReadyAttachment(seeded.userId, "https://tmp.transloadit.com/b.png");

    await resolveWaitpoint({
      userId: seeded.userId,
      waitpointId: seeded.waitpointId,
      resolution: {
        kind: "questions",
        answers: { reference: [second.id, first.id] },
        skipped: ["mood"],
      },
      log: logger,
      control,
    });

    const row = await db.waitpoint.findUniqueOrThrow({ where: { id: seeded.waitpointId } });
    expect((row.resolution as { answers: Record<string, unknown> }).answers.reference).toEqual([
      "https://tmp.transloadit.com/b.png",
      "https://tmp.transloadit.com/a.png",
    ]);
  });

  it("answers NOT_FOUND for a stranger's attachment and leaves the waitpoint pending", async () => {
    const seeded = await seedWaitpoint({ kind: "questions", payload: QUESTIONS });
    const stranger = await seedWaitpoint();
    const { control, completed } = fakeControl();
    const foreign = await seedReadyAttachment(stranger.userId, "https://tmp.transloadit.com/x.png");

    await expect(
      resolveWaitpoint({
        userId: seeded.userId,
        waitpointId: seeded.waitpointId,
        resolution: { kind: "questions", answers: { reference: foreign.id }, skipped: [] },
        log: logger,
        control,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const row = await db.waitpoint.findUniqueOrThrow({ where: { id: seeded.waitpointId } });
    expect(row.status, "a failed resolve must stay answerable").toBe("pending");
    expect(completed).toHaveLength(0);
  });
});
