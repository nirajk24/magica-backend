import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const clerk = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => Promise.resolve({ userId: clerk.userId }),
  currentUser: () =>
    Promise.resolve(
      clerk.userId ? { primaryEmailAddress: { emailAddress: `${clerk.userId}@clerk.test` } } : null,
    ),
}));

const { db } = await import("@/lib/db");
const { uuidv7 } = await import("@/lib/ids");
const { verifyWebhook } = await import("@/lib/webhook-signature");
const { emitWebhookEvent, sendWebhookDelivery } = await import("@/services/webhook.service");

const webhooksRoute = await import("@/app/api/v1/webhooks/route");
const webhookRoute = await import("@/app/api/v1/webhooks/[endpointId]/route");
const deliveriesRoute = await import("@/app/api/v1/webhooks/[endpointId]/deliveries/route");

const created: string[] = [];

function freshUser(): string {
  const id = `test_${uuidv7()}`;
  created.push(id);
  return id;
}

async function envelope<T>(res: Response) {
  return (await res.json()) as { data?: T; error?: { code: string; message: string } };
}

const register = (body: unknown) =>
  webhooksRoute.POST(
    new Request("http://localhost/api/v1/webhooks", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );

type Registered = { endpoint: { id: string; url: string }; secret: string };

async function registerEndpoint(events: string[] = ["agent.completed"]): Promise<Registered> {
  const body = await envelope<Registered>(
    await register({ url: "https://receiver.test/hook", events }),
  );

  return body.data!;
}

/** Collects deliveries with no worker anywhere: emission hands us the id directly. */
function collector() {
  const ids: string[] = [];

  return { ids, dispatch: async (deliveryId: string) => void ids.push(deliveryId) };
}

beforeEach(() => {
  clerk.userId = freshUser();
});

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
});

describe("endpoint registration", () => {
  it("returns the signing secret once and keeps it out of every later read", async () => {
    const { endpoint, secret } = await registerEndpoint();

    expect(secret.startsWith("whsec_")).toBe(true);

    const listed = await envelope<{ endpoints: unknown[] }>(
      await webhooksRoute.GET(new Request("http://localhost/api/v1/webhooks"), {
        params: Promise.resolve({}),
      }),
    );

    expect(listed.data?.endpoints).toHaveLength(1);
    expect(JSON.stringify(listed.data), "the secret must never reappear").not.toContain(secret);
    expect(endpoint.url).toBe("https://receiver.test/hook");
  });

  it("refuses a plaintext http receiver", async () => {
    const res = await register({ url: "http://receiver.test/hook", events: ["agent.completed"] });

    expect(res.status).toBe(400);
  });

  it("refuses an unknown event name", async () => {
    const res = await register({ url: "https://receiver.test/hook", events: ["agent.exploded"] });

    expect(res.status).toBe(400);
  });

  it("deletes only the caller's own endpoint", async () => {
    const { endpoint } = await registerEndpoint();

    clerk.userId = freshUser();
    const stranger = await webhookRoute.DELETE(
      new Request(`http://localhost/api/v1/webhooks/${endpoint.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ endpointId: endpoint.id }) },
    );
    expect(stranger.status).toBe(404);

    expect(await db.webhookEndpoint.count({ where: { id: endpoint.id } })).toBe(1);
  });
});

describe("emission", () => {
  it("queues one delivery per subscribed endpoint and none for the rest", async () => {
    const userId = clerk.userId!;
    await registerEndpoint(["agent.completed"]);
    await registerEndpoint(["agent.failed"]);
    const { ids, dispatch } = collector();

    await emitWebhookEvent({
      userId,
      event: "agent.completed",
      data: { runId: "run_1" },
      dispatch,
    });

    expect(ids, "only the endpoint subscribed to this event").toHaveLength(1);

    const delivery = await db.webhookDelivery.findUniqueOrThrow({ where: { id: ids[0]! } });
    expect(delivery.status).toBe("pending");
    expect(delivery.event).toBe("agent.completed");
    expect((delivery.payload as { type: string; data: { runId: string } }).data.runId).toBe("run_1");
  });

  it("never emits to another account's endpoint", async () => {
    await registerEndpoint(["agent.completed"]);
    const stranger = freshUser();
    await db.user.create({ data: { id: stranger, email: `${stranger}@test.local` } });
    const { ids, dispatch } = collector();

    await emitWebhookEvent({
      userId: stranger,
      event: "agent.completed",
      data: {},
      dispatch,
    });

    expect(ids).toEqual([]);
  });

  it("swallows its own failure, because a turn must not die over a webhook", async () => {
    const userId = clerk.userId!;
    await registerEndpoint(["agent.completed"]);
    const errors: unknown[] = [];

    await expect(
      emitWebhookEvent({
        userId,
        event: "agent.completed",
        data: {},
        dispatch: () => Promise.reject(new Error("queue is down")),
        onError: (error) => errors.push(error),
      }),
    ).resolves.toBeUndefined();

    expect(errors, "the failure is reported, not raised").toHaveLength(1);
  });
});

describe("delivery", () => {
  it("signs a body a receiver can verify, and records the success", async () => {
    const userId = clerk.userId!;
    const { secret } = await registerEndpoint();
    const { ids, dispatch } = collector();
    await emitWebhookEvent({ userId, event: "agent.completed", data: { runId: "r" }, dispatch });

    let seen: { body: string; headers: Headers } | null = null;
    const result = await sendWebhookDelivery({
      deliveryId: ids[0]!,
      fetchImpl: async (_url, init) => {
        seen = { body: String(init?.body), headers: new Headers(init?.headers) };
        return new Response(null, { status: 200 });
      },
    });

    expect(result.delivered).toBe(true);

    const captured = seen as unknown as { body: string; headers: Headers };
    expect(
      verifyWebhook({
        secret,
        body: captured.body,
        headers: {
          "svix-id": captured.headers.get("svix-id")!,
          "svix-timestamp": captured.headers.get("svix-timestamp")!,
          "svix-signature": captured.headers.get("svix-signature")!,
        },
      }),
      "a receiver holding the secret must be able to verify what we sent",
    ).toBe(true);

    const row = await db.webhookDelivery.findUniqueOrThrow({ where: { id: ids[0]! } });
    expect(row.status).toBe("delivered");
    expect(row.attempts).toBe(1);
    expect(row.lastAttemptAt).not.toBeNull();
  });

  it("records a rejecting receiver as failed, and a retry that lands as delivered", async () => {
    const userId = clerk.userId!;
    await registerEndpoint();
    const { ids, dispatch } = collector();
    await emitWebhookEvent({ userId, event: "agent.completed", data: {}, dispatch });

    const failed = await sendWebhookDelivery({
      deliveryId: ids[0]!,
      fetchImpl: async () => new Response(null, { status: 500 }),
    });
    expect(failed.delivered).toBe(false);
    expect(failed.status).toBe(500);

    const afterFirst = await db.webhookDelivery.findUniqueOrThrow({ where: { id: ids[0]! } });
    expect(afterFirst.status).toBe("failed");
    expect(afterFirst.attempts).toBe(1);

    await sendWebhookDelivery({
      deliveryId: ids[0]!,
      fetchImpl: async () => new Response(null, { status: 204 }),
    });

    const afterRetry = await db.webhookDelivery.findUniqueOrThrow({ where: { id: ids[0]! } });
    expect(afterRetry.status, "any 2xx is success").toBe("delivered");
    expect(afterRetry.attempts, "every attempt is counted").toBe(2);
  });

  it("treats an unreachable receiver as a failed attempt, not a crash", async () => {
    const userId = clerk.userId!;
    await registerEndpoint();
    const { ids, dispatch } = collector();
    await emitWebhookEvent({ userId, event: "agent.completed", data: {}, dispatch });

    const result = await sendWebhookDelivery({
      deliveryId: ids[0]!,
      fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
    });

    expect(result.delivered).toBe(false);
    expect(result.status).toBeUndefined();
  });

  it("does not send a delivery twice", async () => {
    const userId = clerk.userId!;
    await registerEndpoint();
    const { ids, dispatch } = collector();
    await emitWebhookEvent({ userId, event: "agent.completed", data: {}, dispatch });

    let sends = 0;
    const send = () =>
      sendWebhookDelivery({
        deliveryId: ids[0]!,
        fetchImpl: async () => {
          sends += 1;
          return new Response(null, { status: 200 });
        },
      });

    await send();
    await send();

    expect(sends, "a redelivered task must not repeat a delivered event").toBe(1);
  });

  it("exposes the delivery log for the endpoint's owner only", async () => {
    const userId = clerk.userId!;
    const { endpoint } = await registerEndpoint();
    const { ids, dispatch } = collector();
    await emitWebhookEvent({ userId, event: "agent.completed", data: {}, dispatch });
    await sendWebhookDelivery({
      deliveryId: ids[0]!,
      fetchImpl: async () => new Response(null, { status: 200 }),
    });

    const log = await envelope<{ deliveries: { status: string; attempts: number }[] }>(
      await deliveriesRoute.GET(
        new Request(`http://localhost/api/v1/webhooks/${endpoint.id}/deliveries`),
        { params: Promise.resolve({ endpointId: endpoint.id }) },
      ),
    );
    expect(log.data?.deliveries[0]).toMatchObject({ status: "delivered", attempts: 1 });

    clerk.userId = freshUser();
    const stranger = await deliveriesRoute.GET(
      new Request(`http://localhost/api/v1/webhooks/${endpoint.id}/deliveries`),
      { params: Promise.resolve({ endpointId: endpoint.id }) },
    );
    expect(stranger.status).toBe(404);
  });
});
