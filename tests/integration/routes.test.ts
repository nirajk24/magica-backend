import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const clerk = vi.hoisted(() => ({ userId: null as string | null }));
const trigger = vi.hoisted(() => ({
  dispatched: [] as string[],
  issued: 0,
  cancelled: [] as string[],
  // Stale-lock recovery asks Trigger.dev whether the holder of the slot is alive. A run this
  // suite just dispatched is, so the default answer keeps the double-send path a rejection.
  remoteStatus: "EXECUTING" as string,
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => Promise.resolve({ userId: clerk.userId }),
  currentUser: () =>
    Promise.resolve(
      clerk.userId ? { primaryEmailAddress: { emailAddress: `${clerk.userId}@clerk.test` } } : null,
    ),
}));

// The task module is replaced wholesale: importing the real one pulls in the whole agent graph, and
// `trigger()` would reach Trigger.dev.
vi.mock("@/trigger/agent-turn", () => ({
  agentTurn: {
    // `AgentRun.triggerRunId` is unique, so the id must be unique across every run of this suite,
    // not just within one — a run killed before its cleanup would otherwise leave a value behind
    // that every later run collides with. Real Trigger.dev ids are globally unique too.
    trigger: (payload: { runId: string }) => {
      trigger.dispatched.push(payload.runId);
      trigger.issued++;
      return Promise.resolve({ id: `run_${crypto.randomUUID()}` });
    },
  },
}));

vi.mock("@trigger.dev/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@trigger.dev/sdk")>();
  return {
    ...actual,
    auth: { ...actual.auth, createPublicToken: () => Promise.resolve("pat_test_token") },
    runs: {
      ...actual.runs,
      retrieve: (id: string) =>
        trigger.remoteStatus === "__throw__"
          ? Promise.reject(new Error("trigger.dev unreachable"))
          : Promise.resolve({ id, status: trigger.remoteStatus }),
      cancel: (id: string) => {
        trigger.cancelled.push(id);
        return Promise.resolve({ id });
      },
    },
    wait: { ...actual.wait, completeToken: () => Promise.resolve({ success: true }) },
  };
});

const { db } = await import("@/lib/db");
const { env } = await import("@/lib/env");
const { uuidv7 } = await import("@/lib/ids");
const { getBalance, sumLedger } = await import("@/lib/credits");

const chatsRoute = await import("@/app/api/v1/chats/route");
const chatRoute = await import("@/app/api/v1/chats/[chatId]/route");
const sendRoute = await import("@/app/api/v1/chats/[chatId]/messages/route");
const activeRunRoute = await import("@/app/api/v1/chats/[chatId]/active-run/route");
const creditsRoute = await import("@/app/api/v1/credits/route");
const topUpRoute = await import("@/app/api/v1/credits/top-up/route");
const cancelRoute = await import("@/app/api/v1/runs/[runId]/cancel/route");
const retryRoute = await import("@/app/api/v1/messages/[messageId]/retry/route");
const llmStatusRoute = await import("@/app/api/v1/llm/status/route");

const created: string[] = [];

function freshUser(): string {
  const id = `test_${uuidv7()}`;
  created.push(id);
  return id;
}

const segment = (chatId: string) => ({ params: Promise.resolve({ chatId }) });

const post = (chatId: string, body: unknown) =>
  sendRoute.POST(
    new Request(`http://localhost/api/v1/chats/${chatId}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    segment(chatId),
  );

async function envelope<T>(res: Response) {
  return (await res.json()) as { data?: T; error?: { code: string; message: string } };
}

const cancel = (runId: string) =>
  cancelRoute.POST(
    new Request(`http://localhost/api/v1/runs/${runId}/cancel`, { method: "POST" }),
    { params: Promise.resolve({ runId }) },
  );

const retry = (messageId: string) =>
  retryRoute.POST(
    new Request(`http://localhost/api/v1/messages/${messageId}/retry`, { method: "POST" }),
    { params: Promise.resolve({ messageId }) },
  );

beforeEach(() => {
  clerk.userId = freshUser();
  trigger.dispatched.length = 0;
  trigger.cancelled.length = 0;
  trigger.remoteStatus = "EXECUTING";
});

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
});

describe("POST /chats/:id/messages", () => {
  it("creates the chat, the message and the run, and dispatches once", async () => {
    const res = await post("new", { content: "Generate an image of a mountain" });
    const body = await envelope<{ chatId: string; runId: string; triggerRunId: string }>(res);

    expect(res.status).toBe(200);
    expect(trigger.dispatched).toEqual([body.data?.runId]);

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: body.data!.runId } });
    expect(run.status).toBe("queued");
    expect(run.triggerRunId, "written back after dispatch").toBe(body.data?.triggerRunId);
    expect(run.idempotencyKey).toBe(`${run.userMessageId}:1`);

    const chat = await db.chat.findUniqueOrThrow({ where: { id: body.data!.chatId } });
    expect(chat.title, "titled from the first message, not left as the default").toBe(
      "Generate an image of a mountain",
    );
  });

  it("records plan mode on the run without pre-deciding how an approved plan runs", async () => {
    const body = await envelope<{ runId: string }>(
      await post("new", { content: "plan this out", planMode: true }),
    );

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: body.data!.runId } });
    expect(run.planMode).toBe(true);
    expect(run.executionMode, "step mode is chosen at approval, not at send").toBe("auto");
  });

  it("defaults plan mode off", async () => {
    const body = await envelope<{ runId: string }>(await post("new", { content: "just do it" }));

    await expect(
      db.agentRun.findUniqueOrThrow({ where: { id: body.data!.runId } }),
    ).resolves.toMatchObject({ planMode: false });
  });

  it("holds the admission reserve while the run is in flight", async () => {
    const userId = clerk.userId!;
    await post("new", { content: "hello" });

    expect(await getBalance(userId)).toBe(env.SIGNUP_GRANT_CREDITS - env.ADMISSION_CREDITS);
    expect(await sumLedger(userId)).toBe(await getBalance(userId));
  });

  it("rejects a second send with 409 and leaves exactly one run", async () => {
    const first = await envelope<{ chatId: string }>(await post("new", { content: "one" }));
    const chatId = first.data!.chatId;

    const res = await post(chatId, { content: "two" });
    const body = await envelope(res);

    expect(res.status).toBe(409);
    expect(body.error?.code).toBe("RUN_ALREADY_ACTIVE");
    await expect(db.agentRun.count({ where: { chatId } })).resolves.toBe(1);
    expect(trigger.dispatched, "the rejected send must not dispatch").toHaveLength(1);
  });

  it("refuses to admit a turn the balance cannot cover", async () => {
    const userId = clerk.userId!;
    await post("new", { content: "warm the account" });
    await db.$executeRaw`UPDATE "User" SET "creditBalance" = 0 WHERE "id" = ${userId}`;

    const res = await post("new", { content: "no credits left" });

    expect(res.status).toBe(402);
    expect((await envelope(res)).error?.code).toBe("INSUFFICIENT_CREDITS");
    expect(trigger.dispatched, "nothing dispatched for an unadmitted turn").toHaveLength(1);
  });

  it("rate limits and says when to come back", async () => {
    const userId = clerk.userId!;
    // The allowance is exhausted up front rather than by sending N times: N sequential round trips
    // to Neon can straddle the minute boundary, which resets the counter and makes the test flake.
    //
    // Both the current bucket and the next are seeded, because the seeding itself takes seconds
    // against a remote database — filling only the current minute leaves the request landing in a
    // fresh, empty bucket whenever the clock happens to roll over mid-test.
    await db.user.create({ data: { id: userId, email: `${userId}@seed.test` } });

    const minute = 60_000;
    const windows = [Date.now(), Date.now() + minute].map((at) =>
      new Date(at).toISOString().slice(0, 16),
    );

    await db.sendRateLimit.createMany({
      data: windows.map((window) => ({ userId, window, count: env.SEND_RATE_PER_MINUTE })),
    });

    const res = await post("new", { content: "one too many" });

    expect(res.status).toBe(429);
    expect((await envelope(res)).error?.code).toBe("RATE_LIMITED");
    expect(res.headers.get("Retry-After"), "the client needs to know when to retry").toMatch(
      /^\d+$/,
    );
    expect(trigger.dispatched, "a throttled send must not dispatch").toEqual([]);
  });

  it("honours the model chosen on every send, not only when the chat is created", async () => {
    const first = await envelope<{ chatId: string; runId: string }>(
      await post("new", { content: "one", modelId: "openrouter/free" }),
    );
    const chatId = first.data!.chatId;

    await expect(
      db.chat.findUniqueOrThrow({ where: { id: chatId } }).then((c) => c.modelId),
    ).resolves.toBe("openrouter/free");

    // The first run has to finish before a second send is admitted.
    await db.agentRun.update({ where: { id: first.data!.runId }, data: { status: "completed" } });

    await post(chatId, {
      content: "two",
      modelId: "nvidia/nemotron-3-super-120b-a12b:free",
    });

    await expect(
      db.chat.findUniqueOrThrow({ where: { id: chatId } }).then((c) => c.modelId),
      "silently ignoring the composer's model control was the one clearly wrong option",
    ).resolves.toBe("nvidia/nemotron-3-super-120b-a12b:free");
  });

  it("rejects a model that is not on the allowlist", async () => {
    const res = await post("new", { content: "hi", modelId: "openai/gpt-5" });

    expect(res.status).toBe(400);
    expect((await envelope(res)).error?.code).toBe("VALIDATION_ERROR");
  });

  it("404s a chat the caller does not own", async () => {
    const mine = await envelope<{ chatId: string }>(await post("new", { content: "mine" }));
    clerk.userId = freshUser();

    const res = await post(mine.data!.chatId, { content: "theirs" });

    expect(res.status, "a 403 would confirm the id exists").toBe(404);
  });
});

describe("GET /chats/:id", () => {
  it("returns the chat with messages oldest first and credits as strings", async () => {
    const sent = await envelope<{ chatId: string }>(
      await post("new", { content: "first question" }),
    );
    const chatId = sent.data!.chatId;

    const res = await chatRoute.GET(
      new Request(`http://localhost/api/v1/chats/${chatId}`),
      segment(chatId),
    );
    const body = await envelope<{
      chat: { id: string };
      messages: { role: string; content: string; creditUsed: unknown }[];
      messagesNextCursor: string | null;
    }>(res);

    expect(res.status).toBe(200);
    expect(body.data?.chat.id).toBe(chatId);
    expect(body.data?.messages.map((m) => m.role)).toEqual(["user"]);
    expect(typeof body.data?.messages[0]?.creditUsed, "BigInt never reaches the wire").toBe(
      "string",
    );
    expect(body.data?.messagesNextCursor).toBeNull();
  });

  it("404s another user's chat", async () => {
    const mine = await envelope<{ chatId: string }>(await post("new", { content: "mine" }));
    clerk.userId = freshUser();
    const chatId = mine.data!.chatId;

    const res = await chatRoute.GET(
      new Request(`http://localhost/api/v1/chats/${chatId}`),
      segment(chatId),
    );

    expect(res.status).toBe(404);
  });
});

describe("GET /chats", () => {
  it("lists only the caller's chats, most recently touched first", async () => {
    await post("new", { content: "older" });
    const newer = await envelope<{ chatId: string }>(await post("new", { content: "newer" }));

    const res = await chatsRoute.GET(new Request("http://localhost/api/v1/chats?limit=10"));
    const body = await envelope<{ chats: { id: string }[] }>(res);

    expect(res.status).toBe(200);
    expect(body.data?.chats).toHaveLength(2);
    expect(body.data?.chats[0]?.id, "send bumps the chat").toBe(newer.data?.chatId);
  });

  it("does not leak another user's chats", async () => {
    await post("new", { content: "mine" });
    clerk.userId = freshUser();

    const res = await chatsRoute.GET(new Request("http://localhost/api/v1/chats"));

    expect((await envelope<{ chats: unknown[] }>(res)).data?.chats).toEqual([]);
  });
});

describe("GET /chats/:id/active-run", () => {
  it("returns the in-flight run with a realtime token", async () => {
    const sent = await envelope<{ chatId: string; runId: string; triggerRunId: string }>(
      await post("new", { content: "still working" }),
    );
    const chatId = sent.data!.chatId;

    const res = await activeRunRoute.GET(
      new Request(`http://localhost/api/v1/chats/${chatId}/active-run`),
      segment(chatId),
    );
    const body = await envelope<{ runId: string; triggerRunId: string; status: string }>(res);

    expect(body.data, "a reloading client must be pointed at the run send just dispatched").toMatchObject({
      runId: sent.data!.runId,
      triggerRunId: sent.data!.triggerRunId,
      status: "queued",
    });
  });

  it("returns null once nothing is in flight", async () => {
    const sent = await envelope<{ chatId: string; runId: string }>(
      await post("new", { content: "done" }),
    );
    const chatId = sent.data!.chatId;
    await db.agentRun.update({
      where: { id: sent.data!.runId },
      data: { status: "completed" },
    });

    const res = await activeRunRoute.GET(
      new Request(`http://localhost/api/v1/chats/${chatId}/active-run`),
      segment(chatId),
    );

    expect((await envelope(res)).data).toBeNull();
  });
});

describe("GET /credits", () => {
  it("serves the balance and the ledger it summarises, all as strings", async () => {
    const userId = clerk.userId!;
    await post("new", { content: "spend something" });

    const res = await creditsRoute.GET(new Request("http://localhost/api/v1/credits"));
    const body = await envelope<{
      balance: string;
      entries: { amount: string; type: string }[];
    }>(res);

    expect(res.status).toBe(200);
    expect(body.data?.balance).toBe((await getBalance(userId)).toString());
    expect(
      body.data?.entries.reduce((sum, e) => sum + BigInt(e.amount), 0n),
      "balance === SUM(ledger), over REST",
    ).toBe(await sumLedger(userId));
    expect(body.data?.entries.map((e) => e.type)).toContain("reserve");
  });
});

describe("POST /credits/top-up", () => {
  let keySeed: string;
  beforeEach(() => {
    keySeed = crypto.randomUUID();
  });

  const topUp = (amount: string, key?: string) =>
    topUpRoute.POST(
      new Request("http://localhost/api/v1/credits/top-up", {
        method: "POST",
        body: JSON.stringify({ amount }),
        headers: key ? { "Idempotency-Key": key } : {},
      }),
    );

  it("adds credits and returns the new balance as a string", async () => {
    const userId = clerk.userId!;
    const res = await topUp("1000000", `${keySeed}-a`);
    const body = await envelope<{ balance: string }>(res);

    expect(res.status).toBe(200);
    expect(body.data?.balance).toBe((env.SIGNUP_GRANT_CREDITS + 1_000_000n).toString());
    expect(await sumLedger(userId)).toBe(await getBalance(userId));
  });

  it("grants once for a repeated idempotency key", async () => {
    const userId = clerk.userId!;
    await topUp("1000000", `${keySeed}-same`);
    await topUp("1000000", `${keySeed}-same`);

    expect(await getBalance(userId)).toBe(env.SIGNUP_GRANT_CREDITS + 1_000_000n);
    expect(await sumLedger(userId)).toBe(await getBalance(userId));
  });

  it("requires the header, because without it a retry would grant twice", async () => {
    const res = await topUp("1000000");
    expect(res.status).toBe(400);
    expect((await envelope(res)).error?.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an amount that is not a positive integer string", async () => {
    for (const amount of ["0", "-5", "1.5", "abc", ""]) {
      const res = await topUp(amount, `${keySeed}-${amount}`);
      expect(res.status, `amount ${JSON.stringify(amount)}`).toBe(400);
    }
  });
});

describe("POST /runs/:id/cancel", () => {
  it("stops the run, keeps the partial output, and refunds the hold", async () => {
    const userId = clerk.userId!;
    const sent = await envelope<{ runId: string; chatId: string; triggerRunId: string }>(
      await post("new", { content: "draw a mountain" }),
    );
    const runId = sent.data!.runId;

    // The task would have created this; the route under test is the one being exercised.
    const assistant = await db.message.create({
      data: {
        chatId: sent.data!.chatId,
        runId,
        role: "assistant",
        status: "streaming",
        content: "Starting on that",
      },
    });
    await db.agentRun.update({
      where: { id: runId },
      data: { status: "running", assistantMessageId: assistant.id },
    });

    const res = await cancel(runId);
    expect(res.status).toBe(200);
    expect((await envelope<{ ok: boolean }>(res)).data).toEqual({ ok: true });

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("cancelled");
    expect(trigger.cancelled, "the machine this run was dispatched to, not some other").toEqual([
      sent.data!.triggerRunId,
    ]);

    const message = await db.message.findUniqueOrThrow({ where: { id: assistant.id } });
    expect(message.status).toBe("cancelled");
    expect(message.content).toBe("Starting on that");

    expect(await getBalance(userId), "a cancelled turn costs nothing on its own").toBe(
      env.SIGNUP_GRANT_CREDITS,
    );
    expect(await sumLedger(userId)).toBe(await getBalance(userId));
  });

  it("answers 200 twice, because pressing stop twice is not an error", async () => {
    const sent = await envelope<{ runId: string }>(await post("new", { content: "hello" }));

    await expect(cancel(sent.data!.runId).then((r) => r.status)).resolves.toBe(200);
    await expect(cancel(sent.data!.runId).then((r) => r.status)).resolves.toBe(200);
  });

  it("does not reveal another user's run", async () => {
    const sent = await envelope<{ runId: string }>(await post("new", { content: "mine" }));

    clerk.userId = freshUser();
    const res = await cancel(sent.data!.runId);

    expect(res.status).toBe(404);
    expect((await envelope(res)).error?.code).toBe("NOT_FOUND");
  });

  it("frees the chat so the next send is admitted", async () => {
    const sent = await envelope<{ runId: string; chatId: string }>(
      await post("new", { content: "first" }),
    );
    await cancel(sent.data!.runId);

    const res = await post(sent.data!.chatId, { content: "second" });
    expect(res.status, "cancel must actually release the slot").toBe(200);
  });
});

describe("POST /messages/:id/retry", () => {
  /** Drives a chat to a failed turn the way the task would, so retry has something to act on. */
  async function failedTurn() {
    const sent = await envelope<{ runId: string; chatId: string }>(
      await post("new", { content: "draw a mountain" }),
    );
    const runId = sent.data!.runId;

    const assistant = await db.message.create({
      data: {
        chatId: sent.data!.chatId,
        runId,
        role: "assistant",
        status: "failed",
        content: "I got part way",
        errorMessage: "The model stopped responding partway through.",
      },
    });

    await db.agentRun.update({
      where: { id: runId },
      data: { status: "failed", assistantMessageId: assistant.id },
    });

    return { ...sent.data!, assistantMessageId: assistant.id };
  }

  it("returns SendMessageResult and dispatches a second attempt", async () => {
    const { runId, assistantMessageId } = await failedTurn();

    const res = await retry(assistantMessageId);
    const body = await envelope<{
      runId: string;
      assistantMessageId: string | null;
      triggerRunId: string;
      publicAccessToken: string;
    }>(res);

    expect(res.status).toBe(200);
    expect(body.data?.runId).toBe(runId);
    expect(body.data?.assistantMessageId).toBe(assistantMessageId);
    expect(body.data?.publicAccessToken).toBe("pat_test_token");
    expect(trigger.dispatched, "the same run dispatched a second time").toEqual([runId, runId]);

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.attempt).toBe(2);
    expect(run.status).toBe("queued");

    const message = await db.message.findUniqueOrThrow({ where: { id: assistantMessageId } });
    expect(message.status).toBe("streaming");
    expect(message.errorMessage, "the old failure is cleared, not shown beside the new attempt")
      .toBeNull();
  });

  it("takes a genuinely new hold, so a retry can still be refused for credits", async () => {
    const userId = clerk.userId!;
    const { assistantMessageId, runId } = await failedTurn();

    // Stands in for the failed turn's own finalize, which always returns the admission.
    const { refundAdmission } = await import("@/lib/credits");
    await db.$transaction((tx) => refundAdmission(tx, { userId, runId }));
    expect(await getBalance(userId), "nothing held going in").toBe(env.SIGNUP_GRANT_CREDITS);

    await retry(assistantMessageId);

    expect(
      await getBalance(userId),
      "the second attempt is admitted on its own hold, keyed by attempt",
    ).toBe(env.SIGNUP_GRANT_CREDITS - env.ADMISSION_CREDITS);
    expect(await sumLedger(userId)).toBe(await getBalance(userId));
  });

  it("refuses a retry the balance cannot cover", async () => {
    const userId = clerk.userId!;
    const { assistantMessageId, runId } = await failedTurn();

    const { refundAdmission } = await import("@/lib/credits");
    await db.$transaction((tx) => refundAdmission(tx, { userId, runId }));
    await db.$executeRaw`UPDATE "User" SET "creditBalance" = 0 WHERE "id" = ${userId}`;

    trigger.dispatched.length = 0;
    const res = await retry(assistantMessageId);

    expect(res.status).toBe(402);
    expect((await envelope(res)).error?.code).toBe("INSUFFICIENT_CREDITS");
    expect(trigger.dispatched, "an unadmitted retry must not start a turn").toHaveLength(0);
  });

  it("rejects a retry of a turn that succeeded", async () => {
    const sent = await envelope<{ runId: string; chatId: string }>(
      await post("new", { content: "hello" }),
    );
    const assistant = await db.message.create({
      data: { chatId: sent.data!.chatId, runId: sent.data!.runId, role: "assistant", status: "success" },
    });
    await db.agentRun.update({ where: { id: sent.data!.runId }, data: { status: "completed" } });

    const res = await retry(assistant.id);
    expect(res.status).toBe(400);
    expect((await envelope(res)).error?.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a retry while the turn is still running", async () => {
    const sent = await envelope<{ runId: string; chatId: string }>(
      await post("new", { content: "hello" }),
    );
    const assistant = await db.message.create({
      data: {
        chatId: sent.data!.chatId,
        runId: sent.data!.runId,
        role: "assistant",
        status: "streaming",
      },
    });

    const res = await retry(assistant.id);
    expect(res.status).toBe(409);
    expect((await envelope(res)).error?.code).toBe("RUN_ALREADY_ACTIVE");
  });

  it("does not reveal another user's message", async () => {
    const { assistantMessageId } = await failedTurn();

    clerk.userId = freshUser();
    const res = await retry(assistantMessageId);

    expect(res.status).toBe(404);
  });
});

describe("stale-lock recovery on send", () => {
  it("recovers a dead run and admits the new send", async () => {
    const userId = clerk.userId!;
    const sent = await envelope<{ chatId: string; runId: string }>(
      await post("new", { content: "first" }),
    );

    // The worker died without finalizing: our row still says running, Trigger.dev says otherwise.
    await db.agentRun.update({ where: { id: sent.data!.runId }, data: { status: "running" } });
    trigger.remoteStatus = "CRASHED";

    const res = await post(sent.data!.chatId, { content: "second" });
    expect(res.status, "a corpse must not hold the chat forever").toBe(200);

    const dead = await db.agentRun.findUniqueOrThrow({ where: { id: sent.data!.runId } });
    expect(dead.status).toBe("failed");
    expect(dead.failureReason).toMatch(/stopped unexpectedly/i);

    await expect(db.agentRun.count({ where: { chatId: sent.data!.chatId } })).resolves.toBe(2);
    expect(
      await getBalance(userId),
      "the dead run's hold is refunded and only the live one is held",
    ).toBe(env.SIGNUP_GRANT_CREDITS - env.ADMISSION_CREDITS);
    expect(await sumLedger(userId)).toBe(await getBalance(userId));
  });

  it("still rejects when the holder is genuinely alive", async () => {
    const sent = await envelope<{ chatId: string }>(await post("new", { content: "first" }));
    trigger.remoteStatus = "EXECUTING";

    const res = await post(sent.data!.chatId, { content: "second" });
    expect(res.status).toBe(409);
    expect(trigger.dispatched, "the rejected send must not dispatch").toHaveLength(1);
  });

  it("keeps the slot held when Trigger.dev cannot be reached", async () => {
    const sent = await envelope<{ chatId: string; runId: string }>(
      await post("new", { content: "first" }),
    );
    await db.agentRun.update({ where: { id: sent.data!.runId }, data: { status: "running" } });
    trigger.remoteStatus = "__throw__";

    const res = await post(sent.data!.chatId, { content: "second" });
    expect(res.status, "not knowing is not the same as knowing it is dead").toBe(409);

    const held = await db.agentRun.findUniqueOrThrow({ where: { id: sent.data!.runId } });
    expect(held.status).toBe("running");
  });
});

describe("GET /llm/status", () => {
  const status = () => llmStatusRoute.GET(new Request("http://localhost/api/v1/llm/status"));

  it("reports a live cooldown so the composer can say when to come back", async () => {
    const { recordRateLimit } = await import("@/lib/llm-status");
    await recordRateLimit({ modelId: "z-ai/glm-5.2:free", retryAfterSeconds: 120 });

    const body = await envelope<{ limitedModel: string; rateLimitedUntil: string }>(
      await status(),
    );

    expect(body.data?.limitedModel).toBe("z-ai/glm-5.2:free");
    expect(Date.parse(body.data!.rateLimitedUntil)).toBeGreaterThan(Date.now());

    await db.llmStatus.deleteMany({});
  });

  it("reports clear when nothing is limited", async () => {
    await db.llmStatus.deleteMany({});

    const body = await envelope<{ rateLimitedUntil: string | null }>(await status());
    expect(body.data?.rateLimitedUntil).toBeNull();
  });
});

describe("send with attachments", () => {
  const seedAttachment = async (userId: string, over?: { status?: "uploading" | "ready" }) => {
    await db.user.upsert({
      where: { id: userId },
      create: { id: userId, email: `${userId}@test.local` },
      update: {},
    });

    return db.attachment.create({
      data: {
        userId,
        status: over?.status ?? "ready",
        type: "image",
        url: "https://tmp.transloadit.com/shot.png",
        name: "shot.png",
        contentType: "image/png",
        size: 100,
      },
      select: { id: true },
    });
  };

  it("binds them to the message in order, snapshots them, and claims them for the chat", async () => {
    const first = await seedAttachment(clerk.userId!);
    const second = await seedAttachment(clerk.userId!);

    const res = await post("new", {
      content: "Merge these",
      attachmentIds: [second.id, first.id],
    });
    const body = await envelope<{ chatId: string; userMessageId: string }>(res);
    expect(res.status).toBe(200);

    const joins = await db.messageAttachment.findMany({
      where: { messageId: body.data!.userMessageId },
      orderBy: { position: "asc" },
      select: { attachmentId: true, position: true },
    });
    expect(joins, "position preserves the order the user attached in").toEqual([
      { attachmentId: second.id, position: 0 },
      { attachmentId: first.id, position: 1 },
    ]);

    const message = await db.message.findUniqueOrThrow({
      where: { id: body.data!.userMessageId },
      select: { attachments: true },
    });
    const snapshot = message.attachments as { id: string; url: string }[];
    expect(snapshot.map((s) => s.id)).toEqual([second.id, first.id]);

    const claimed = await db.attachment.findUniqueOrThrow({ where: { id: first.id } });
    expect(claimed.chatId, "the files-in-task modal filters on this").toBe(body.data!.chatId);
  });

  it("rejects a stranger's attachment with NOT_FOUND and admits nothing", async () => {
    const owner = clerk.userId!;
    const foreign = await seedAttachment(freshUser());

    clerk.userId = owner;
    const res = await post("new", { content: "use it", attachmentIds: [foreign.id] });
    const body = await envelope(res);

    expect(res.status).toBe(404);
    expect(body.error?.code).toBe("NOT_FOUND");
    expect(trigger.dispatched, "nothing may dispatch off a rejected send").toEqual([]);
    expect(
      await db.message.count({ where: { content: "use it" } }),
      "the whole admission rolls back",
    ).toBe(0);
  });

  it("rejects an attachment that is still uploading", async () => {
    const pending = await seedAttachment(clerk.userId!, { status: "uploading" });

    const res = await post("new", { content: "too soon", attachmentIds: [pending.id] });

    expect(res.status).toBe(404);
    expect(trigger.dispatched).toEqual([]);
  });

  it("rejects duplicate ids at the boundary", async () => {
    const one = await seedAttachment(clerk.userId!);

    const res = await post("new", { content: "twice", attachmentIds: [one.id, one.id] });
    const body = await envelope(res);

    expect(res.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_ERROR");
  });
});
