import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";

/** Minute-granularity bucket key; `(userId, window)` is the table's primary key. */
const currentWindow = () => new Date().toISOString().slice(0, 16);

const secondsLeftInMinute = () => 60 - new Date().getSeconds();

/**
 * Counts one request against the caller's per-minute allowance, throwing `RATE_LIMITED` with a
 * `Retry-After` once it is exceeded.
 *
 * INVARIANT: the counter is incremented by the database, not read-then-written, so concurrent sends
 * cannot both see room under the limit.
 */
export async function consumeSendAllowance(a: {
  userId: string;
  perMinute: number;
}): Promise<void> {
  const window = currentWindow();

  const { count } = await db.sendRateLimit.upsert({
    where: { userId_window: { userId: a.userId, window } },
    create: { userId: a.userId, window, count: 1 },
    update: { count: { increment: 1 } },
    select: { count: true },
  });

  if (count > a.perMinute) {
    throw new AppError(
      "RATE_LIMITED",
      "You are sending messages too quickly. Try again in a moment.",
      undefined,
      secondsLeftInMinute(),
    );
  }
}
