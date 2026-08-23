import { afterAll, describe, expect, it, vi } from "vitest";

const clerk = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => Promise.resolve({ userId: clerk.userId }),
  currentUser: () =>
    Promise.resolve(
      clerk.userId ? { primaryEmailAddress: { emailAddress: `${clerk.userId}@clerk.test` } } : null,
    ),
}));

const { db } = await import("@/lib/db");
const { env } = await import("@/lib/env");
const { topUp } = await import("@/lib/credits");
const { uuidv7 } = await import("@/lib/ids");
const { summarizeUsage } = await import("@/services/usage.service");
const usageRoute = await import("@/app/api/v1/credits/usage/route");

const created: string[] = [];

async function seedSpend() {
  const userId = `test_${uuidv7()}`;
  created.push(userId);

  const chatId = uuidv7();
  const userMessageId = uuidv7();
  const runId = uuidv7();

  await db.user.create({ data: { id: userId, email: `${userId}@test.local` } });
  await db.$transaction((tx) => topUp(tx, { userId, amount: 10_000_000n, key: userId }));
  await db.chat.create({ data: { id: chatId, userId, title: "t" } });
  await db.message.create({ data: { id: userMessageId, chatId, role: "user", content: "go" } });
  await db.agentRun.create({
    data: {
      id: runId,
      chatId,
      userId,
      userMessageId,
      idempotencyKey: `${userMessageId}:1`,
      status: "completed",
    },
  });

  const invocation = (toolName: string, creditUsed: bigint, status = "completed" as const) =>
    db.toolInvocation.create({
      data: {
        runId,
        toolUseId: `call_${uuidv7()}`,
        toolName,
        status,
        input: {},
        creditUsed,
        startedAt: new Date(),
        completedAt: new Date(),
      },
    });

  await invocation("gpt_image_2", 5_880n);
  await invocation("gpt_image_2", 11_130n);
  await invocation("crop_image", 5_000n);
  await invocation("load_skill", 0n);

  return { userId, chatId, runId };
}

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
});

describe("GET /credits/usage", () => {
  it("aggregates settled actuals per tool, adjustments apart, and answers on the wire", async () => {
    const { userId, chatId, runId } = await seedSpend();
    clerk.userId = userId;

    const res = await usageRoute.GET(
      new Request("http://localhost/api/v1/credits/usage?category=gpt_image_2"),
      { params: Promise.resolve({}) },
    );
    const { data } = (await res.json()) as {
      data: {
        totalDebited: string;
        totalCredited: string;
        records: number;
        categories: {
          key: string;
          kind: string;
          debited: string;
          count: number;
          latestAt: string | null;
          records?: { chatId: string | null; runId: string | null; amount: string }[];
        }[];
      };
    };

    expect(res.status).toBe(200);
    expect(data.totalDebited).toBe("22010");
    // The route's own auth bootstrap grants signup credits, so both sources show.
    expect(data.totalCredited).toBe((10_000_000n + env.SIGNUP_GRANT_CREDITS).toString());
    expect(data.records).toBe(5);

    const byKey = Object.fromEntries(data.categories.map((c) => [c.key, c]));
    expect(byKey.gpt_image_2).toMatchObject({ kind: "tool", debited: "17010", count: 2 });
    expect(byKey.crop_image).toMatchObject({ kind: "tool", debited: "5000", count: 1 });
    expect(byKey.top_up).toMatchObject({ kind: "adjustment", credited: "10000000", count: 1 });
    expect(byKey.signup_grant).toMatchObject({ kind: "adjustment", count: 1 });
    expect(byKey.load_skill, "a free tool is not usage").toBeUndefined();

    expect(byKey.gpt_image_2.records, "only the named category carries records").toHaveLength(2);
    expect(byKey.gpt_image_2.records?.[0]).toMatchObject({ chatId, runId });
    expect(byKey.crop_image.records).toBeUndefined();

    expect(data.categories[0]?.key, "biggest spender first").toBe("gpt_image_2");
  });

  it("scopes everything to the caller", async () => {
    const theirs = await seedSpend();
    const { userId } = { userId: `test_${uuidv7()}` };
    created.push(userId);
    await db.user.create({ data: { id: userId, email: `${userId}@test.local` } });

    const page = await summarizeUsage({ userId });

    expect(page.categories, `${theirs.userId}'s spend must not appear`).toEqual([]);
    expect(page.totalDebited).toBe("0");
  });

  it("honours the period and rejects a malformed one at the boundary", async () => {
    const { userId } = await seedSpend();
    clerk.userId = userId;

    const empty = await summarizeUsage({
      userId,
      from: "2020-01-01T00:00:00Z",
      to: "2020-01-02T00:00:00Z",
    });
    expect(empty.records).toBe(0);

    const bad = await usageRoute.GET(
      new Request("http://localhost/api/v1/credits/usage?from=yesterday"),
      { params: Promise.resolve({}) },
    );
    expect(bad.status).toBe(400);
  });
});
