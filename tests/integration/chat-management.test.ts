import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const clerk = vi.hoisted(() => ({ userId: null as string | null }));
const trigger = vi.hoisted(() => ({ cancelled: [] as string[] }));

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => Promise.resolve({ userId: clerk.userId }),
  currentUser: () =>
    Promise.resolve(
      clerk.userId ? { primaryEmailAddress: { emailAddress: `${clerk.userId}@clerk.test` } } : null,
    ),
}));

vi.mock("@trigger.dev/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@trigger.dev/sdk")>();
  return {
    ...actual,
    runs: {
      ...actual.runs,
      cancel: (id: string) => {
        trigger.cancelled.push(id);
        return Promise.resolve({ id });
      },
      retrieve: (id: string) => Promise.resolve({ id, status: "EXECUTING" }),
    },
    wait: { ...actual.wait, completeToken: () => Promise.resolve({ success: true }) },
  };
});

const { db } = await import("@/lib/db");
const { uuidv7 } = await import("@/lib/ids");

const chatRoute = await import("@/app/api/v1/chats/[chatId]/route");
const chatsRoute = await import("@/app/api/v1/chats/route");
const feedbackRoute = await import("@/app/api/v1/messages/[messageId]/feedback/route");

const created: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `test_${uuidv7()}`;
  created.push(userId);
  await db.user.create({ data: { id: userId, email: `${userId}@test.local` } });

  return userId;
}

async function seedChat(userId: string, a?: { title?: string; isFavorite?: boolean }) {
  const chat = await db.chat.create({
    data: {
      userId,
      title: a?.title ?? "A task",
      isFavorite: a?.isFavorite ?? false,
    },
    select: { id: true, updatedAt: true },
  });

  return chat;
}

const segment = (chatId: string) => ({ params: Promise.resolve({ chatId }) });

const patchChat = (chatId: string, body: unknown) =>
  chatRoute.PATCH(
    new Request(`http://localhost/api/v1/chats/${chatId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    segment(chatId),
  );

const deleteChat = (chatId: string) =>
  chatRoute.DELETE(
    new Request(`http://localhost/api/v1/chats/${chatId}`, { method: "DELETE" }),
    segment(chatId),
  );

const listChats = (query = "") =>
  chatsRoute.GET(new Request(`http://localhost/api/v1/chats${query}`), {
    params: Promise.resolve({}),
  });

const rate = (messageId: string, body: unknown) =>
  feedbackRoute.PATCH(
    new Request(`http://localhost/api/v1/messages/${messageId}/feedback`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ messageId }) },
  );

async function envelope<T>(res: Response) {
  return (await res.json()) as { data?: T; error?: { code: string; message: string } };
}

beforeEach(() => {
  clerk.userId = null;
  trigger.cancelled.length = 0;
});

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
});

describe("PATCH /chats/:id", () => {
  it("renames a chat and answers with the row", async () => {
    clerk.userId = await seedUser();
    const chat = await seedChat(clerk.userId);

    const res = await patchChat(chat.id, { title: "Poster for the launch" });
    const body = await envelope<{ chat: { title: string } }>(res);

    expect(res.status).toBe(200);
    expect(body.data?.chat.title).toBe("Poster for the launch");
  });

  it("pins and unpins, which is the same write", async () => {
    clerk.userId = await seedUser();
    const chat = await seedChat(clerk.userId);

    await patchChat(chat.id, { isFavorite: true });
    await expect(
      db.chat.findUniqueOrThrow({ where: { id: chat.id } }),
    ).resolves.toMatchObject({ isFavorite: true });

    await patchChat(chat.id, { isFavorite: false });
    await expect(
      db.chat.findUniqueOrThrow({ where: { id: chat.id } }),
    ).resolves.toMatchObject({ isFavorite: false });
  });

  it("does not reorder the sidebar, because renaming is not activity", async () => {
    clerk.userId = await seedUser();
    const chat = await seedChat(clerk.userId);

    await patchChat(chat.id, { title: "Renamed" });

    const after = await db.chat.findUniqueOrThrow({ where: { id: chat.id } });
    expect(after.updatedAt.getTime()).toBe(chat.updatedAt.getTime());
  });

  it("rejects a title that is empty or too long, before it reaches the database", async () => {
    clerk.userId = await seedUser();
    const chat = await seedChat(clerk.userId);

    expect((await patchChat(chat.id, { title: "" })).status).toBe(400);
    expect((await patchChat(chat.id, { title: "x".repeat(201) })).status).toBe(400);
  });

  it("hides another user's chat behind a 404", async () => {
    const owner = await seedUser();
    const chat = await seedChat(owner);
    clerk.userId = await seedUser();

    const res = await patchChat(chat.id, { title: "mine now" });

    expect(res.status).toBe(404);
    expect((await envelope(res)).error?.code).toBe("NOT_FOUND");
    await expect(
      db.chat.findUniqueOrThrow({ where: { id: chat.id } }),
    ).resolves.toMatchObject({ title: "A task" });
  });
});

describe("DELETE /chats/:id", () => {
  it("removes the chat from every read without erasing it", async () => {
    clerk.userId = await seedUser();
    const chat = await seedChat(clerk.userId);

    const res = await deleteChat(chat.id);

    expect(res.status).toBe(200);
    const row = await db.chat.findUniqueOrThrow({ where: { id: chat.id } });
    expect(row.deletedAt, "soft, so its ledger entries stay explainable").not.toBeNull();

    const listed = await envelope<{ chats: { id: string }[] }>(await listChats());
    expect(listed.data?.chats.map((c) => c.id)).not.toContain(chat.id);
  });

  it("stops a turn still running inside it", async () => {
    clerk.userId = await seedUser();
    const chat = await seedChat(clerk.userId);
    const userMessage = await db.message.create({
      data: { chatId: chat.id, role: "user", content: "draw" },
      select: { id: true },
    });
    const run = await db.agentRun.create({
      data: {
        chatId: chat.id,
        userId: clerk.userId,
        userMessageId: userMessage.id,
        idempotencyKey: `${userMessage.id}:1`,
        status: "running",
        triggerRunId: `run_${uuidv7()}`,
      },
      select: { id: true, triggerRunId: true },
    });

    await deleteChat(chat.id);

    await expect(db.agentRun.findUniqueOrThrow({ where: { id: run.id } })).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(trigger.cancelled, "the machine is stopped too, not just our row").toEqual([
      run.triggerRunId,
    ]);
  });

  it("is a no-op the second time", async () => {
    clerk.userId = await seedUser();
    const chat = await seedChat(clerk.userId);

    await deleteChat(chat.id);
    const first = await db.chat.findUniqueOrThrow({ where: { id: chat.id } });
    const res = await deleteChat(chat.id);

    expect(res.status).toBe(200);
    await expect(
      db.chat.findUniqueOrThrow({ where: { id: chat.id } }),
    ).resolves.toMatchObject({ deletedAt: first.deletedAt });
  });

  it("hides another user's chat behind a 404 and leaves it alone", async () => {
    const owner = await seedUser();
    const chat = await seedChat(owner);
    clerk.userId = await seedUser();

    expect((await deleteChat(chat.id)).status).toBe(404);
    await expect(
      db.chat.findUniqueOrThrow({ where: { id: chat.id } }),
    ).resolves.toMatchObject({ deletedAt: null });
  });
});

describe("GET /chats?search", () => {
  it("finds a chat by something said inside it, not only by its title", async () => {
    clerk.userId = await seedUser();
    const chat = await seedChat(clerk.userId, { title: "Untitled" });
    await db.message.create({
      data: { chatId: chat.id, role: "user", content: "a poster of a mountain at sunrise" },
    });
    await seedChat(clerk.userId, { title: "Something else" });

    const body = await envelope<{ chats: { id: string }[] }>(
      await listChats("?search=mountain%20at%20sunrise"),
    );

    expect(body.data?.chats.map((c) => c.id)).toEqual([chat.id]);
  });

  it("still finds it by title, case-insensitively", async () => {
    clerk.userId = await seedUser();
    const chat = await seedChat(clerk.userId, { title: "Launch Poster" });

    const body = await envelope<{ chats: { id: string }[] }>(await listChats("?search=poster"));

    expect(body.data?.chats.map((c) => c.id)).toEqual([chat.id]);
  });

  it("never reaches another user's messages", async () => {
    const owner = await seedUser();
    const theirs = await seedChat(owner, { title: "Untitled" });
    await db.message.create({
      data: { chatId: theirs.id, role: "user", content: "a very distinctive phrase" },
    });

    clerk.userId = await seedUser();
    const body = await envelope<{ chats: unknown[] }>(await listChats("?search=distinctive"));

    expect(body.data?.chats).toEqual([]);
  });

  it("pages a filtered search without losing the filter", async () => {
    clerk.userId = await seedUser();
    await seedChat(clerk.userId, { title: "pinned poster one", isFavorite: true });
    await seedChat(clerk.userId, { title: "pinned poster two", isFavorite: true });
    await seedChat(clerk.userId, { title: "loose poster", isFavorite: false });

    const first = await envelope<{ chats: { id: string }[]; nextCursor: string | null }>(
      await listChats("?search=poster&filter=pinned&limit=1"),
    );

    expect(first.data?.chats).toHaveLength(1);
    expect(first.data?.nextCursor).not.toBeNull();

    const second = await envelope<{ chats: { id: string }[]; nextCursor: string | null }>(
      await listChats(
        `?search=poster&filter=pinned&limit=1&cursor=${encodeURIComponent(first.data!.nextCursor!)}`,
      ),
    );

    expect(second.data?.chats).toHaveLength(1);
    expect(
      second.data?.chats[0]?.id,
      "the second page must not repeat the first",
    ).not.toBe(first.data?.chats[0]?.id);
    expect(second.data?.nextCursor, "the unpinned match is excluded, so there is no third").toBeNull();
  });
});

describe("PATCH /messages/:id/feedback", () => {
  async function seedAnswer(userId: string) {
    const chat = await seedChat(userId);
    const message = await db.message.create({
      data: { chatId: chat.id, role: "assistant", status: "success", content: "Here you go." },
      select: { id: true },
    });

    return message.id;
  }

  it("records a like and clears it again", async () => {
    clerk.userId = await seedUser();
    const messageId = await seedAnswer(clerk.userId);

    expect((await rate(messageId, { type: "like" })).status).toBe(200);
    await expect(
      db.message.findUniqueOrThrow({ where: { id: messageId } }),
    ).resolves.toMatchObject({ feedback: "like" });

    await rate(messageId, { type: null });
    await expect(
      db.message.findUniqueOrThrow({ where: { id: messageId } }),
    ).resolves.toMatchObject({ feedback: null });
  });

  it("rejects anything that is not a like, a dislike, or nothing", async () => {
    clerk.userId = await seedUser();
    const messageId = await seedAnswer(clerk.userId);

    expect((await rate(messageId, { type: "love" })).status).toBe(400);
  });

  it("refuses to rate the user's own message", async () => {
    clerk.userId = await seedUser();
    const chat = await seedChat(clerk.userId);
    const mine = await db.message.create({
      data: { chatId: chat.id, role: "user", content: "draw a cat" },
      select: { id: true },
    });

    expect((await rate(mine.id, { type: "like" })).status).toBe(404);
  });

  it("hides another user's message behind a 404", async () => {
    const owner = await seedUser();
    const messageId = await seedAnswer(owner);
    clerk.userId = await seedUser();

    expect((await rate(messageId, { type: "dislike" })).status).toBe(404);
    await expect(
      db.message.findUniqueOrThrow({ where: { id: messageId } }),
    ).resolves.toMatchObject({ feedback: null });
  });
});
