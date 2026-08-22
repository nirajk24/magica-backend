import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";

export const server = setupServer();

/**
 * `onUnhandledRequest: "error"` is the point of this file, not a detail. OpenRouter's free tier
 * allows 50 requests a day and every Magica node run spends real credits, so a test suite that
 * can reach the network is a test suite that quietly drains both. An unmocked call fails loudly
 * instead.
 *
 * Postgres is untouched by this — the pg driver opens raw TCP sockets rather than going through
 * the http module MSW intercepts, so integration tests still talk to a real database.
 */
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
