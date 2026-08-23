import type {
  CreateWebhookEndpoint,
  CreateWebhookEndpointResult,
  WebhookDeliveriesPage,
  WebhookEndpointDTO,
  WebhookEndpointsPage,
  WebhookEvent,
} from "@/contracts";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { uuidv7 } from "@/lib/ids";
import { mintWebhookSecret, signWebhook } from "@/lib/webhook-signature";

const toEndpointDTO = (row: {
  id: string;
  url: string;
  events: string[];
  createdAt: Date;
}): WebhookEndpointDTO => ({
  id: row.id,
  url: row.url,
  events: row.events as WebhookEvent[],
  createdAt: row.createdAt.toISOString(),
});

/** Registers an endpoint and returns its signing secret, which is shown only here. */
export async function createWebhookEndpoint(a: {
  userId: string;
  endpoint: CreateWebhookEndpoint;
}): Promise<CreateWebhookEndpointResult> {
  const secret = mintWebhookSecret();

  const row = await db.webhookEndpoint.create({
    data: { userId: a.userId, url: a.endpoint.url, events: a.endpoint.events, secret },
    select: { id: true, url: true, events: true, createdAt: true },
  });

  return { endpoint: toEndpointDTO(row), secret };
}

export async function listWebhookEndpoints(userId: string): Promise<WebhookEndpointsPage> {
  const rows = await db.webhookEndpoint.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, url: true, events: true, createdAt: true },
  });

  return { endpoints: rows.map(toEndpointDTO) };
}

export async function deleteWebhookEndpoint(a: {
  userId: string;
  endpointId: string;
}): Promise<void> {
  const { count } = await db.webhookEndpoint.deleteMany({
    where: { id: a.endpointId, userId: a.userId },
  });

  if (count === 0) throw new AppError("NOT_FOUND", "That webhook endpoint does not exist.");
}

/** The delivery log for one endpoint, newest first — how a caller debugs a receiver. */
export async function listWebhookDeliveries(a: {
  userId: string;
  endpointId: string;
  limit: number;
}): Promise<WebhookDeliveriesPage> {
  const endpoint = await db.webhookEndpoint.findFirst({
    where: { id: a.endpointId, userId: a.userId },
    select: { id: true },
  });

  if (!endpoint) throw new AppError("NOT_FOUND", "That webhook endpoint does not exist.");

  const rows = await db.webhookDelivery.findMany({
    where: { endpointId: a.endpointId },
    orderBy: { createdAt: "desc" },
    take: a.limit,
    select: {
      id: true,
      event: true,
      status: true,
      attempts: true,
      lastAttemptAt: true,
      createdAt: true,
    },
  });

  return {
    deliveries: rows.map((row) => ({
      id: row.id,
      event: row.event as WebhookEvent,
      status: row.status as "pending" | "delivered" | "failed",
      attempts: row.attempts,
      lastAttemptAt: row.lastAttemptAt ? row.lastAttemptAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/** Queues one delivery per subscribed endpoint. Injected so emission is testable with no worker. */
export type WebhookDispatcher = (deliveryId: string) => Promise<void>;

/**
 * Records a lifecycle event for every endpoint subscribed to it, and hands each delivery to the
 * durable dispatcher.
 *
 * INVARIANT: this never throws. A webhook is an outbound notification; failing a paid turn because
 * a customer's receiver is unreachable would be the wrong trade every time. Errors are logged by
 * the caller's logger and the delivery row carries the outcome.
 *
 * The row is written BEFORE the dispatch, so a crash between the two leaves a `pending` delivery
 * that is visible rather than an event that silently never happened.
 */
export async function emitWebhookEvent(a: {
  userId: string;
  event: WebhookEvent;
  data: Record<string, unknown>;
  dispatch: WebhookDispatcher;
  onError?: (error: unknown) => void;
}): Promise<void> {
  try {
    const endpoints = await db.webhookEndpoint.findMany({
      where: { userId: a.userId, events: { has: a.event } },
      select: { id: true },
    });

    for (const endpoint of endpoints) {
      const delivery = await db.webhookDelivery.create({
        data: {
          endpointId: endpoint.id,
          event: a.event,
          payload: {
            id: `evt_${uuidv7()}`,
            type: a.event,
            createdAt: new Date().toISOString(),
            data: a.data as never,
          },
          status: "pending",
        },
        select: { id: true },
      });

      await a.dispatch(delivery.id);
    }
  } catch (error) {
    a.onError?.(error);
  }
}

/**
 * Sends one recorded delivery and writes back what happened.
 *
 * INVARIANT: any 2xx is success. A receiver is required to answer 200 immediately and verify the
 * signature afterwards, so a slow or erroring receiver is retried by the caller (the task's own
 * retry policy), not re-queued here.
 */
export async function sendWebhookDelivery(a: {
  deliveryId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ delivered: boolean; status?: number }> {
  const delivery = await db.webhookDelivery.findUnique({
    where: { id: a.deliveryId },
    select: {
      id: true,
      event: true,
      payload: true,
      status: true,
      endpoint: { select: { url: true, secret: true } },
    },
  });

  if (!delivery) throw new AppError("NOT_FOUND", "That delivery does not exist.");
  if (delivery.status === "delivered") return { delivered: true };

  const body = JSON.stringify(delivery.payload);
  const headers = signWebhook({
    id: delivery.id,
    secret: delivery.endpoint.secret,
    body,
    timestamp: new Date(),
  });

  const send = a.fetchImpl ?? fetch;
  let status: number | undefined;

  try {
    const response = await send(delivery.endpoint.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
      signal: AbortSignal.timeout(a.timeoutMs ?? 10_000),
    });
    status = response.status;
  } catch {
    status = undefined;
  }

  const delivered = status !== undefined && status >= 200 && status < 300;

  await db.webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      status: delivered ? "delivered" : "failed",
      attempts: { increment: 1 },
      lastAttemptAt: new Date(),
    },
  });

  return { delivered, ...(status === undefined ? {} : { status }) };
}
