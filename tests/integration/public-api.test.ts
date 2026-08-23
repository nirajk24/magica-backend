import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const clerk = vi.hoisted(() => ({ userId: null as string | null }));
const trigger = vi.hoisted(() => ({ dispatched: [] as string[] }));

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => Promise.resolve({ userId: clerk.userId }),
  currentUser: () =>
    Promise.resolve(
      clerk.userId ? { primaryEmailAddress: { emailAddress: `${clerk.userId}@clerk.test` } } : null,
    ),
}));

vi.mock("@/trigger/agent-turn", () => ({
  agentTurn: {
    trigger: (payload: { runId: string }) => {
      trigger.dispatched.push(payload.runId);
      return Promise.resolve({ id: `run_${payload.runId}` });
    },
  },
}));

vi.mock("@/trigger/public-tool-run", () => ({
  publicToolRun: {
    trigger: (payload: { runId: string }) => {
      trigger.dispatched.push(payload.runId);
      return Promise.resolve({ id: `run_${payload.runId}` });
    },
  },
}));

vi.mock("@trigger.dev/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@trigger.dev/sdk")>();
  return {
    ...actual,
    auth: { ...actual.auth, createPublicToken: () => Promise.resolve("pat_test_token") },
    runs: { ...actual.runs, retrieve: (id: string) => Promise.resolve({ id, status: "EXECUTING" }) },
  };
});

const { db } = await import("@/lib/db");
const { uuidv7 } = await import("@/lib/ids");

const apiKeysRoute = await import("@/app/api/v1/api-keys/route");
const apiKeyRoute = await import("@/app/api/v1/api-keys/[apiKeyId]/route");
const publicChatsRoute = await import("@/app/api/public/v1/chats/route");
const publicChatRoute = await import("@/app/api/public/v1/chats/[chatId]/route");
const publicSendRoute = await import("@/app/api/public/v1/chats/[chatId]/messages/route");
const publicRunRoute = await import("@/app/api/public/v1/runs/[runId]/route");
const publicToolsRoute = await import("@/app/api/public/v1/tools/route");
const publicToolRunRoute = await import("@/app/api/public/v1/tools/[toolName]/run/route");

const created: string[] = [];

function freshUser(): string {
  const id = `test_${uuidv7()}`;
  created.push(id);
  return id;
}

async function envelope<T>(res: Response) {
  return (await res.json()) as { data?: T; error?: { code: string; message: string } };
}

/** Creates a key through the real session route, so the test uses what a user would. */
async function issueKey(): Promise<string> {
  const res = await apiKeysRoute.POST(
    new Request("http://localhost/api/v1/api-keys", {
      method: "POST",
      body: JSON.stringify({ name: "integration" }),
    }),
    { params: Promise.resolve({}) },
  );

  const body = await envelope<{ key: string; apiKey: { id: string } }>(res);
  return body.data!.key;
}

const withKey = (key: string | null, url: string, init?: RequestInit) =>
  new Request(url, {
    ...init,
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });

beforeEach(() => {
  clerk.userId = freshUser();
  trigger.dispatched.length = 0;
});

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
});

describe("API key lifecycle", () => {
  it("returns the plaintext once and never stores it", async () => {
    const key = await issueKey();

    expect(key.startsWith("mk_live_")).toBe(true);

    const rows = await db.apiKey.findMany({ where: { userId: clerk.userId! } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hashedKey).not.toBe(key);

    const listed = await envelope<{ apiKeys: { fingerprint: string }[] }>(
      await apiKeysRoute.GET(new Request("http://localhost/api/v1/api-keys"), {
        params: Promise.resolve({}),
      }),
    );
    expect(JSON.stringify(listed.data), "the key must never reappear in a read").not.toContain(key);
  });

  it("authenticates the public API, and stops the moment it is revoked", async () => {
    const key = await issueKey();
    const list = () =>
      publicChatsRoute.GET(withKey(key, "http://localhost/api/public/v1/chats"), {
        params: Promise.resolve({}),
      });

    expect((await list()).status).toBe(200);

    const rows = await db.apiKey.findMany({ where: { userId: clerk.userId! } });
    await apiKeyRoute.DELETE(
      new Request(`http://localhost/api/v1/api-keys/${rows[0]!.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ apiKeyId: rows[0]!.id }) },
    );

    expect((await list()).status, "revocation takes effect on the next request").toBe(401);
  });

  it("rejects a missing, malformed or unknown key with 401", async () => {
    const unknown = `mk_live_${"a".repeat(48)}`;

    for (const key of [null, "not-a-key", unknown]) {
      const res = await publicChatsRoute.GET(
        withKey(key, "http://localhost/api/public/v1/chats"),
        { params: Promise.resolve({}) },
      );

      expect(res.status).toBe(401);
    }
  });

  it("does not accept a Clerk session in place of a key", async () => {
    const res = await publicChatsRoute.GET(
      new Request("http://localhost/api/public/v1/chats"),
      { params: Promise.resolve({}) },
    );

    expect(res.status, "a signed-in browser is not an API caller").toBe(401);
  });
});

describe("public API surface", () => {
  it("submits a message through the same path the app uses", async () => {
    const key = await issueKey();

    const res = await publicSendRoute.POST(
      withKey(key, "http://localhost/api/public/v1/chats/new/messages", {
        method: "POST",
        body: JSON.stringify({ content: "Generate a poster" }),
      }),
      { params: Promise.resolve({ chatId: "new" }) },
    );
    const body = await envelope<{ chatId: string; runId: string }>(res);

    expect(res.status).toBe(200);
    expect(trigger.dispatched, "the durable turn is dispatched exactly once").toEqual([
      body.data?.runId,
    ]);

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: body.data!.runId } });
    expect(run.userId).toBe(clerk.userId);
  });

  it("reads a conversation and its run status back", async () => {
    const key = await issueKey();
    const sent = await envelope<{ chatId: string; runId: string }>(
      await publicSendRoute.POST(
        withKey(key, "http://localhost/api/public/v1/chats/new/messages", {
          method: "POST",
          body: JSON.stringify({ content: "hello" }),
        }),
        { params: Promise.resolve({ chatId: "new" }) },
      ),
    );

    const chat = await envelope<{ messages: { content: string }[] }>(
      await publicChatRoute.GET(
        withKey(key, `http://localhost/api/public/v1/chats/${sent.data!.chatId}`),
        { params: Promise.resolve({ chatId: sent.data!.chatId }) },
      ),
    );
    expect(chat.data?.messages.map((m) => m.content)).toContain("hello");

    const run = await envelope<{ status: string; runId: string }>(
      await publicRunRoute.GET(
        withKey(key, `http://localhost/api/public/v1/runs/${sent.data!.runId}`),
        { params: Promise.resolve({ runId: sent.data!.runId }) },
      ),
    );
    expect(run.data?.runId).toBe(sent.data?.runId);
    expect(run.data?.status).toBe("queued");
  });

  it("lists only runnable provider tools, with the schema the runtime parses", async () => {
    const key = await issueKey();

    const res = await publicToolsRoute.GET(
      withKey(key, "http://localhost/api/public/v1/tools"),
      { params: Promise.resolve({}) },
    );
    const body = await envelope<{ tools: { name: string; inputSchema: unknown }[] }>(res);

    // Asserted before the list is read: an error envelope would otherwise read as "no tools".
    expect(res.status).toBe(200);

    const names = body.data!.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["gpt_image_2", "crop_image", "merge_videos"]));
    expect(names, "interaction tools mean nothing outside a turn").not.toContain("submit_plan");
    expect(names, "skill loaders are not provider work").not.toContain("load_skill");
    const cropSchema = body.data!.tools.find((t) => t.name === "crop_image")?.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(
      cropSchema?.properties?.image_url,
      "the published schema is generated from the one the runtime parses",
    ).toBeTruthy();

    // The image tool clamps quality with a transform, which has no JSON Schema form; it must
    // degrade to an unconstrained field rather than take the whole listing down.
    expect(body.data!.tools.find((t) => t.name === "gpt_image_2")?.inputSchema).toBeTruthy();
  });

  it("accepts a direct tool run and dispatches it durably", async () => {
    const key = await issueKey();

    const res = await publicToolRunRoute.POST(
      withKey(key, "http://localhost/api/public/v1/tools/crop_image/run", {
        method: "POST",
        body: JSON.stringify({
          input: {
            image_url: "https://cdn.magica.com/a.png",
            x_percent: 0,
            y_percent: 0,
            width_percent: 100,
            height_percent: 50,
          },
        }),
      }),
      { params: Promise.resolve({ toolName: "crop_image" }) },
    );
    const body = await envelope<{ runId: string; chatId: string }>(res);

    expect(res.status).toBe(200);
    expect(trigger.dispatched).toEqual([body.data?.runId]);

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: body.data!.runId } });
    expect(run.status, "accepted-then-poll, like the Magica API it calls").toBe("running");
  });

  it("rejects invalid tool input before writing anything", async () => {
    const key = await issueKey();
    const before = await db.agentRun.count({ where: { userId: clerk.userId! } });

    const res = await publicToolRunRoute.POST(
      withKey(key, "http://localhost/api/public/v1/tools/crop_image/run", {
        method: "POST",
        body: JSON.stringify({ input: { image_url: "not-a-url" } }),
      }),
      { params: Promise.resolve({ toolName: "crop_image" }) },
    );

    expect(res.status).toBe(400);
    expect(await db.agentRun.count({ where: { userId: clerk.userId! } })).toBe(before);
    expect(trigger.dispatched).toEqual([]);
  });

  it("404s a tool that is not runnable, without confirming whether it exists", async () => {
    const key = await issueKey();

    for (const toolName of ["submit_plan", "no_such_tool"]) {
      const res = await publicToolRunRoute.POST(
        withKey(key, `http://localhost/api/public/v1/tools/${toolName}/run`, {
          method: "POST",
          body: JSON.stringify({ input: {} }),
        }),
        { params: Promise.resolve({ toolName }) },
      );

      expect(res.status).toBe(404);
    }
  });

  it("never lets one caller read another's chat or run", async () => {
    const ownerKey = await issueKey();
    const sent = await envelope<{ chatId: string; runId: string }>(
      await publicSendRoute.POST(
        withKey(ownerKey, "http://localhost/api/public/v1/chats/new/messages", {
          method: "POST",
          body: JSON.stringify({ content: "private" }),
        }),
        { params: Promise.resolve({ chatId: "new" }) },
      ),
    );

    clerk.userId = freshUser();
    const strangerKey = await issueKey();

    const chat = await publicChatRoute.GET(
      withKey(strangerKey, `http://localhost/api/public/v1/chats/${sent.data!.chatId}`),
      { params: Promise.resolve({ chatId: sent.data!.chatId }) },
    );
    const run = await publicRunRoute.GET(
      withKey(strangerKey, `http://localhost/api/public/v1/runs/${sent.data!.runId}`),
      { params: Promise.resolve({ runId: sent.data!.runId }) },
    );

    expect(chat.status, "a 403 would confirm the id exists").toBe(404);
    expect(run.status).toBe(404);
  });
});
