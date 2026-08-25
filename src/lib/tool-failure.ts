import { z } from "zod";

/**
 * Why a tool call failed, in the terms the model has to act on.
 *
 * Codes name a RESPONSE, not a cause: `rejected_by_provider` and `invalid_input` are both "the call
 * was wrong", but one is fixed by rewording and the other by correcting an argument, and the model
 * needs to know which.
 */
export const ToolFailureCode = z.enum([
  "rate_limited",
  "rejected_by_provider",
  "out_of_credits",
  "invalid_input",
  "provider_unavailable",
  "timed_out",
  "cancelled",
  "internal",
]);
export type ToolFailureCode = z.infer<typeof ToolFailureCode>;

/**
 * What each code means for the next action.
 *
 * `retryable` lives here rather than on the error, so a code and its retry policy cannot disagree —
 * a provider rejection carrying `retryable: false` reads to the model as "stop using this tool",
 * which is the opposite of what a rejection calls for.
 *
 * `guidance` is written to the model in the tool-result contract, so a new code cannot ship without
 * saying what to do about it.
 */
export const FAILURE_POLICY: Record<ToolFailureCode, { retryable: boolean; guidance: string }> = {
  rate_limited: {
    retryable: true,
    guidance: "the provider is throttling us; wait for any stated delay before calling it again",
  },
  rejected_by_provider: {
    retryable: true,
    guidance: "the provider refused this input; reword it and call again, never resend it unchanged",
  },
  out_of_credits: {
    retryable: false,
    guidance: "there is no balance left; say so and stop, no tool that spends credits will succeed",
  },
  invalid_input: {
    retryable: true,
    guidance: "the arguments were wrong; fix the ones named and call again",
  },
  provider_unavailable: {
    retryable: true,
    guidance: "the provider is down; one further attempt is reasonable, a third is not",
  },
  timed_out: {
    retryable: true,
    guidance: "the work was abandoned before it finished, not refused; it may succeed on a retry",
  },
  cancelled: {
    retryable: false,
    guidance: "the run was stopped deliberately; do nothing further",
  },
  internal: {
    retryable: true,
    guidance: "the cause is unknown; do not guess one, and do not repeat the same call twice",
  },
};

export const isRetryable = (code: ToolFailureCode): boolean => FAILURE_POLICY[code].retryable;
