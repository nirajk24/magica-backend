import pino from "pino";
import { env } from "@/lib/env";

export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : env.NODE_ENV === "production" ? "info" : "debug",
  base: undefined,
  redact: {
    paths: ["req.headers.authorization", "*.apiKey", "*.token", "*.publicAccessToken"],
    censor: "[redacted]",
  },
  ...(env.NODE_ENV === "development" ? { transport: { target: "pino-pretty" } } : {}),
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
  },
): Logger {
  return parent.child(ctx);
}
