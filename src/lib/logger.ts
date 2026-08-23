import pino from "pino";
import { env } from "@/lib/env";

/**
 * Structured JSON on stdout, with no pretty-printing transport.
 *
 * A pino transport runs in a worker thread that the runtime resolves from `pino/lib/worker.js`. That
 * path does not exist inside Trigger.dev's flattened bundle, so configuring one makes the task build
 * fail — reported only as a missing `lib/worker.js`, with nothing pointing at pino. Both places these
 * logs are actually read, the Trigger.dev dashboard and Vercel, parse JSON anyway; the cost is raw
 * JSON in a local terminal.
 */
export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : env.NODE_ENV === "production" ? "info" : "debug",
  base: undefined,
  redact: {
    paths: ["req.headers.authorization", "*.apiKey", "*.token", "*.publicAccessToken"],
    censor: "[redacted]",
  },
});

export type Logger = pino.Logger;

/**
 * Binds the six correlation keys the trial requires on every log line. Call once at the
 * top of a request or task and pass the result down; never re-bind per statement.
 */
export function bindContext(
  parent: Logger,
  ctx: {
    traceId?: string;
    chatId?: string;
    runId?: string;
    messageId?: string;
    processId?: string;
    waitpointTokenId?: string;
    deliveryId?: string;
  },
): Logger {
  return parent.child(ctx);
}
