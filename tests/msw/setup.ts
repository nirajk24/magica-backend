import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";

export const server = setupServer();

/**
 * `onUnhandledRequest: "error"` is the point: OpenRouter allows 50 requests a day and every Magica
 * run spends real credits, so an unmocked call must fail loudly rather than reach the network.
 *
 * Postgres is unaffected — the pg driver uses raw TCP, not the http module MSW intercepts.
 */
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
