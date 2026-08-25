import type { ErrorCode } from "@/contracts";
import { isRetryable, type ToolFailureCode } from "@/lib/tool-failure";

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  RUN_ALREADY_ACTIVE: 409,
  INSUFFICIENT_CREDITS: 402,
  LIMIT_EXCEEDED: 400,
  QUOTA_EXCEEDED: 413,
  WAITPOINT_EXPIRED: 410,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

/**
 * Error carrying a user-safe message and a contract error code. Anything thrown that is
 * not an AppError is reported as INTERNAL with a generic message, so provider text and
 * stack traces can never reach a client.
 */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AppError";
  }

  get status(): number {
    return STATUS[this.code];
  }
}

export function statusFor(code: ErrorCode): number {
  return STATUS[code];
}

/** True for Prisma's unique-constraint violation, the signal behind every idempotency guard. */
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

/**
 * A failure the model should see and react to, rather than an HTTP response. The tool wrapper
 * feeds it back as a tool-result so the model can rephrase and continue.
 *
 * INVARIANT: `message` is safe to show a user and a model. Never construct one from a raw
 * provider string or stack.
 * INVARIANT: `retryable` is derived from `code`, never passed. The two disagreeing is what made a
 * rewordable provider rejection read as "do not use this tool again".
 */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly code: ToolFailureCode = "internal",
  ) {
    super(message);
    this.name = "ToolError";
  }

  get retryable(): boolean {
    return isRetryable(this.code);
  }
}
