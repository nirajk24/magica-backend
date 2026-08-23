import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";

/** Minute-granularity bucket key; `(userId, window)` is the table's primary key. */
const currentWindow = () => new Date().toISOString().slice(0, 16);

const secondsLeftInMinute = () => 60 - new Date().getSeconds();

/**
 * Counts one request against a named per-minute allowance, throwing `RATE_LIMITED` with a
 * `Retry-After` once it is exceeded.
 *
 * INVARIANT: the counter is incremented by the database, not read-then-written, so concurrent
 * callers cannot both see room under the limit.
 *
 * `scope` selects an independent bucket by prefixing the window key, so a caller exhausting one
 * allowance does not consume another. The table's key is `(userId, window)`, so this needs no
 * schema change.
 */
async function consumeAllowance(a: {
  userId: string;
  scope: string;
  perMinute: number;
  message: string;
}): Promise<void> {
  const window = `${a.scope}:${currentWindow()}`;

  const { count } = await db.sendRateLimit.upsert({
    where: { userId_window: { userId: a.userId, window } },
    create: { userId: a.userId, window, count: 1 },
    update: { count: { increment: 1 } },
    select: { count: true },
  });

  if (count > a.perMinute) {
    throw new AppError("RATE_LIMITED", a.message, undefined, secondsLeftInMinute());
  }
}

/** The conversational send path, shared by the application and the public API. */
export const consumeSendAllowance = (a: { userId: string; perMinute: number }) =>
  consumeAllowance({
    ...a,
    scope: "send",
    message: "You are sending messages too quickly. Try again in a moment.",
  });

/**
 * Direct tool execution through the public API.
 *
 * Credits already bound the total damage, but they do not bound the *rate*: without this an API
 * key can dispatch provider work as fast as HTTP allows, and every call is billable.
 */
export const consumeToolRunAllowance = (a: { userId: string; perMinute: number }) =>
  consumeAllowance({
    ...a,
    scope: "toolrun",
    message: "You are running tools too quickly. Try again in a moment.",
  });
