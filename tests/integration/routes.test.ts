import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const clerk = vi.hoisted(() => ({ userId: null as string | null }));
const trigger = vi.hoisted(() => ({ dispatched: [] as string[], issued: 0 }));

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
    // `AgentRun.triggerRunId` is unique, so the id must be unique across the whole file, not just
    // within a test — real Trigger.dev ids are.
    trigger: (payload: { runId: string }) => {
      trigger.dispatched.push(payload.runId);
      trigger.issued++;
      return Promise.resolve({ id: `run_trigger_${trigger.issued}` });
    },
  },
}));

vi.mock("@trigger.dev/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@trigger.dev/sdk")>();
  return {
    ...actual,
    auth: { ...actual.auth, createPublicToken: () => Promise.resolve("pat_test_token") },
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

beforeEach(() => {
  clerk.userId = freshUser();
  trigger.dispatched.length = 0;
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
    expect(body.data?.triggerRunId).toMatch(/^run_trigger_\d+$/);
    expect(trigger.dispatched).toEqual([body.data?.runId]);

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: body.data!.runId } });
    expect(run.status).toBe("queued");
    expect(run.triggerRunId, "written back after dispatch").toBe("run_trigger_1");
    expect(run.idempotencyKey).toBe(`${run.userMessageId}:1`);

    const chat = await db.chat.findUniqueOrThrow({ where: { id: body.data!.chatId } });
    expect(chat.title, "titled from the first message, not left as the default").toBe(
      "Generate an image of a mountain",
    );
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
    await db.user.create({ data: { id: userId, email: `${userId}@seed.test` } });
    await db.sendRateLimit.create({
      data: {
        userId,
        window: new Date().toISOString().slice(0, 16),
        count: env.SEND_RATE_PER_MINUTE,
      },
    });

    const res = await post("new", { content: "one too many" });

    expect(res.status).toBe(429);
    expect((await envelope(res)).error?.code).toBe("RATE_LIMITED");
    expect(res.headers.get("Retry-After"), "the client needs to know when to retry").toMatch(
      /^\d+$/,
    );
    expect(trigger.dispatched, "a throttled send must not dispatch").toEqual([]);
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
    const sent = await envelope<{ chatId: string; runId: string }>(
      await post("new", { content: "still working" }),
    );
    const chatId = sent.data!.chatId;

    const res = await activeRunRoute.GET(
      new Request(`http://localhost/api/v1/chats/${chatId}/active-run`),
      segment(chatId),
    );
    const body = await envelope<{ runId: string; triggerRunId: string; status: string }>(res);

    expect(body.data).toMatchObject({
      runId: sent.data!.runId,
      triggerRunId: expect.stringMatching(/^run_trigger_\d+$/) as unknown as string,
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
