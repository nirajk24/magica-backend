import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";

/** Minute-granularity bucket key; `(userId, window)` is the table's primary key. */
const currentWindow = () => new Date().toISOString().slice(0, 16);

const currentDay = () => new Date().toISOString().slice(0, 10);

const secondsLeftInMinute = () => 60 - new Date().getSeconds();

function secondsLeftInDay(): number {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);

  return Math.ceil((midnight - now.getTime()) / 1000);
}

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
async function countAgainst(subject: string, window: string): Promise<number> {
  const { count } = await db.sendRateLimit.upsert({
    where: { userId_window: { userId: subject, window } },
    create: { userId: subject, window, count: 1 },
    update: { count: { increment: 1 } },
    select: { count: true },
  });

  return count;
}

async function consumeAllowance(a: {
  userId: string;
  scope: string;
  perMinute: number;
  message: string;
}): Promise<void> {
  const count = await countAgainst(a.userId, `${a.scope}:${currentWindow()}`);

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

/**
 * Counts one public-API request against the key's own ceilings.
 *
 * INVARIANT: the subject is the key, not the account, so one credential exhausting its allowance
 * leaves the others untouched — which is the whole point of setting a limit per key. The subject
 * is prefixed so it can never collide with an account's own buckets.
 *
 * A null ceiling means unlimited and skips its bucket entirely, so an unconfigured key costs no
 * extra query.
 */
export async function consumeApiKeyAllowance(a: {
  apiKeyId: string;
  perMinute: number | null;
  perDay: number | null;
}): Promise<void> {
  const subject = `key:${a.apiKeyId}`;

  if (a.perMinute !== null) {
    const count = await countAgainst(subject, `min:${currentWindow()}`);

    if (count > a.perMinute) {
      throw new AppError(
        "RATE_LIMITED",
        `This key is limited to ${a.perMinute} requests per minute.`,
        undefined,
        secondsLeftInMinute(),
      );
    }
  }

  if (a.perDay !== null) {
    const count = await countAgainst(subject, `day:${currentDay()}`);

    if (count > a.perDay) {
      throw new AppError(
        "RATE_LIMITED",
        `This key is limited to ${a.perDay} requests per day.`,
        undefined,
        secondsLeftInDay(),
      );
    }
  }
}
