import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const clerk = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => Promise.resolve({ userId: clerk.userId }),
  currentUser: () =>
    Promise.resolve(
      clerk.userId ? { primaryEmailAddress: { emailAddress: `${clerk.userId}@clerk.test` } } : null,
    ),
}));

const { defineRoute, definePublicRoute, preflight } = await import("@/lib/api");
const { ensureUserWithGrant, forgetBootstrappedUsers } = await import("@/lib/users");
const { AppError } = await import("@/lib/errors");
const { db } = await import("@/lib/db");
const { env } = await import("@/lib/env");
const { uuidv7 } = await import("@/lib/ids");
const { getBalance, sumLedger } = await import("@/lib/credits");
const health = await import("@/app/api/v1/health/route");

const created: string[] = [];

function freshUserId(): string {
  const id = `test_${uuidv7()}`;
  created.push(id);
  return id;
}

const post = (body?: string) =>
  new Request("http://localhost/api/v1/thing", { method: "POST", body });

const get = (search = "") => new Request(`http://localhost/api/v1/thing${search}`);

async function envelope(res: Response) {
  return (await res.json()) as {
    data?: Record<string, unknown>;
    error?: { code: string; message: string; traceId: string; details?: unknown };
  };
}

beforeEach(() => {
  clerk.userId = freshUserId();
});

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
});

describe("defineRoute — auth", () => {
  it("401s an unauthenticated request without running the handler", async () => {
    clerk.userId = null;
    const handler = vi.fn();
    const route = defineRoute({ handler });

    const res = await route(get());
    const body = await envelope(res);

    expect(res.status).toBe(401);
    expect(body.error?.code).toBe("UNAUTHENTICATED");
    expect(body.error?.traceId).toMatch(/^req_/);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("defineRoute — input parsing", () => {
  const route = defineRoute({
    body: z.object({ n: z.number() }),
    handler: ({ body }) => Promise.resolve(body),
  });

  it("maps a body that is not JSON to 400, not 500", async () => {
    const res = await route(post("{"));
    const body = await envelope(res);

    expect(res.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_ERROR");
    expect(body.error?.message).toMatch(/valid JSON/);
  });

  it("maps a missing body to 400, not 500", async () => {
    const res = await route(post());

    expect(res.status).toBe(400);
    expect((await envelope(res)).error?.code).toBe("VALIDATION_ERROR");
  });

  it("maps a schema failure to 400 with field details", async () => {
    const res = await route(post(JSON.stringify({ n: "seven" })));
    const body = await envelope(res);

    expect(res.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_ERROR");
    expect(body.error?.details).toBeDefined();
  });

  it("rejects a query value outside its schema", async () => {
    const queried = defineRoute({
      query: z.object({ limit: z.coerce.number().int().max(50) }),
      handler: ({ query }) => Promise.resolve(query),
    });

    const res = await queried(get("?limit=999"));

    expect(res.status).toBe(400);
    expect((await envelope(res)).error?.code).toBe("VALIDATION_ERROR");
  });

  it("hands the handler parsed input", async () => {
    const res = await route(post(JSON.stringify({ n: 7 })));

    expect(res.status).toBe(200);
    expect((await envelope(res)).data).toEqual({ n: 7 });
  });
});

describe("defineRoute — error mapping", () => {
  it("keeps an AppError's own status and code", async () => {
    const route = defineRoute({
      handler: () => Promise.reject(new AppError("RUN_ALREADY_ACTIVE", "A run is already active.")),
    });

    const res = await route(get());
    const body = await envelope(res);

    expect(res.status).toBe(409);
    expect(body.error?.code).toBe("RUN_ALREADY_ACTIVE");
    expect(body.error?.message).toBe("A run is already active.");
  });

  it("reports an unexpected throw as INTERNAL and leaks nothing from it", async () => {
    const route = defineRoute({
      handler: () => Promise.reject(new Error("upstream rejected credential PRIVATE-DETAIL")),
    });

    const res = await route(get());
    const raw = await res.text();

    expect(res.status).toBe(500);
    expect(raw, "provider text and stack traces must never reach a client").not.toContain(
      "PRIVATE-DETAIL",
    );
    expect(JSON.parse(raw).error.message).toBe("Something went wrong on our side.");
  });
});

describe("defineRoute — response envelope", () => {
  it("carries exactly one CORS origin on a success", async () => {
    const route = defineRoute({ handler: () => Promise.resolve({ ok: true }) });
    const res = await route(get());

    expect(res.headers.get("access-control-allow-origin")).toBe(env.FRONTEND_URL);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("carries CORS on an error too, or the browser hides the message", async () => {
    const route = defineRoute({
      handler: () => Promise.reject(new AppError("NOT_FOUND", "No such chat.")),
    });

    const res = await route(get());

    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBe(env.FRONTEND_URL);
  });

  it("serializes a BigInt as a string instead of throwing", async () => {
    const route = defineRoute({
      handler: () => Promise.resolve({ creditUsed: 12_345_678_901_234_567_890n }),
    });

    const res = await route(get());

    expect(res.status).toBe(200);
    expect((await envelope(res)).data).toEqual({ creditUsed: "12345678901234567890" });
  });
});

describe("defineRoute — account bootstrap", () => {
  it("creates the user and grants credits on the first authenticated request", async () => {
    const userId = clerk.userId!;
    const route = defineRoute({ handler: ({ userId: id }) => Promise.resolve({ id }) });

    expect(await db.user.findUnique({ where: { id: userId } })).toBeNull();

    const res = await route(get());

    expect(res.status).toBe(200);

    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.email, "the email comes from Clerk, not a placeholder").toBe(
      `${userId}@clerk.test`,
    );
    expect(user.creditBalance).toBe(env.SIGNUP_GRANT_CREDITS);
    expect(await sumLedger(userId)).toBe(env.SIGNUP_GRANT_CREDITS);
  });

  it("grants once when several first requests race", async () => {
    const userId = freshUserId();
    forgetBootstrappedUsers();

    await Promise.all(
      Array.from({ length: 3 }, () =>
        ensureUserWithGrant(userId, () => Promise.resolve(`${userId}@parallel.test`)),
      ),
    );

    const grants = await db.creditLedgerEntry.count({
      where: { userId, idempotencyKey: `signup_grant:${userId}` },
    });

    expect(grants, "one grant row across racing callers").toBe(1);
    expect(await getBalance(userId)).toBe(await sumLedger(userId));
    expect(await getBalance(userId)).toBe(env.SIGNUP_GRANT_CREDITS);
  });

  it("repairs a user row that exists with no grant, instead of leaving it at zero", async () => {
    const userId = freshUserId();
    await db.user.create({ data: { id: userId, email: `${userId}@ungranted.test` } });

    await ensureUserWithGrant(userId, () => Promise.resolve("unused@test.local"));

    expect(await getBalance(userId)).toBe(env.SIGNUP_GRANT_CREDITS);
    expect(await sumLedger(userId)).toBe(env.SIGNUP_GRANT_CREDITS);
  });

  it("is a no-op on replay once the process cache is cold", async () => {
    const userId = freshUserId();
    const resolve = () => Promise.resolve(`${userId}@replay.test`);

    await ensureUserWithGrant(userId, resolve);
    forgetBootstrappedUsers();
    await ensureUserWithGrant(userId, resolve);

    expect(await sumLedger(userId)).toBe(env.SIGNUP_GRANT_CREDITS);
    expect(await getBalance(userId)).toBe(env.SIGNUP_GRANT_CREDITS);
  });
});

describe("definePublicRoute", () => {
  it("serves an unauthenticated caller, with CORS", async () => {
    clerk.userId = null;
    const route = definePublicRoute({ handler: () => Promise.resolve({ probe: true }) });

    const res = await route(get());

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(env.FRONTEND_URL);
    expect((await envelope(res)).data).toEqual({ probe: true });
  });

  it("answers a preflight with the headers a browser needs before it will send the real request", () => {
    const res = preflight();

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(env.FRONTEND_URL);
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
  });
});

describe("GET /api/v1/health", () => {
  it("returns the Health contract over a live database round trip, with CORS", async () => {
    clerk.userId = null;
    const res = await health.GET(new Request("http://localhost/api/v1/health"));
    const body = await envelope(res);

    expect(res.status).toBe(200);
    expect(
      res.headers.get("access-control-allow-origin"),
      "the browser drops the response without this",
    ).toBe(env.FRONTEND_URL);

    const { Health } = await import("@/contracts");
    expect(() => Health.parse(body.data)).not.toThrow();
  });

  it("answers its own preflight", () => {
    expect(health.OPTIONS().status).toBe(204);
  });
});
