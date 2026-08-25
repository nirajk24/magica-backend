import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";

/**
 * The minute bucket a scope counts into. `(userId, window)` is the table's primary key, so the
 * scope prefix is what keeps one allowance from consuming another.
 *
 * Exported because a test that wants to arrive at a limit pre-fills the bucket rather than sending
 * N times — and a test that builds the key itself drifts silently the moment a scope is added.
 */
export const allowanceWindow = (scope: string, at: Date = new Date()) =>
  `${scope}:${at.toISOString().slice(0, 16)}`;

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
async function countAgainst(subject: string, window: string, by = 1): Promise<number> {
  const { count } = await db.sendRateLimit.upsert({
    where: { userId_window: { userId: subject, window } },
    create: { userId: subject, window, count: by },
    update: { count: { increment: by } },
    select: { count: true },
  });

  return count;
}

/** Reads a bucket without consuming it, for a ceiling checked before the work it bounds. */
async function currentCount(subject: string, window: string): Promise<number> {
  const row = await db.sendRateLimit.findUnique({
    where: { userId_window: { userId: subject, window } },
    select: { count: true },
  });

  return row?.count ?? 0;
}

async function consumeAllowance(a: {
  userId: string;
  scope: string;
  perMinute: number;
  message: string;
}): Promise<void> {
  const count = await countAgainst(a.userId, allowanceWindow(a.scope));

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
    const count = await countAgainst(subject, allowanceWindow("min"));

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

const GLOBAL_SUBJECT = "openrouter";

const requestWindow = () => `openrouter:day:${currentDay()}`;

/**
 * Refuses a turn that would run against an exhausted model-request budget.
 *
 * Requests rather than messages, because the two are not comparable: a question is one request and
 * a plan-driven turn is up to `MAX_TURNS × MAX_STEPS`. Capping messages lets the expensive user
 * through and stops the cheap one, which is backwards.
 *
 * Checked BEFORE the turn and recorded after, so a turn is never abandoned halfway. A user can
 * therefore overshoot by at most one turn's worth, which is the price of not killing work in flight.
 *
 * The global bucket exists because per-user ceilings do not bound the total: ten users at their own
 * limits will exhaust a shared daily quota between them without any of them exceeding anything.
 */
export async function assertRequestAllowance(a: {
  userId: string;
  perUserPerDay: number;
  globalPerDay: number;
}): Promise<void> {
  const window = requestWindow();
  const [mine, everyone] = await Promise.all([
    currentCount(a.userId, window),
    currentCount(GLOBAL_SUBJECT, window),
  ]);

  if (everyone >= a.globalPerDay) {
    throw new AppError(
      "RATE_LIMITED",
      "This demo has reached its limit for today. It resets in a few hours.",
      undefined,
      secondsLeftInDay(),
    );
  }

  if (mine >= a.perUserPerDay) {
    throw new AppError(
      "RATE_LIMITED",
      "You have reached today's limit. It resets in a few hours.",
      undefined,
      secondsLeftInDay(),
    );
  }
}

/** Adds one finished turn's model requests to the day, for the account and for everyone. */
export async function recordRequestUsage(a: { userId: string; requests: number }): Promise<void> {
  if (a.requests <= 0) return;

  const window = requestWindow();
  await Promise.all([
    countAgainst(a.userId, window, a.requests),
    countAgainst(GLOBAL_SUBJECT, window, a.requests),
  ]);
}
