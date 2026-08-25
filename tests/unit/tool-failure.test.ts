import { describe, expect, it } from "vitest";
import { FAILURE_POLICY, isRetryable, ToolFailureCode } from "@/lib/tool-failure";
import type { ToolFailureCode as Code } from "@/lib/tool-failure";
import { ToolError } from "@/lib/errors";

describe("the failure policy table", () => {
  it("covers every code, so a new one cannot ship without a policy", () => {
    expect(Object.keys(FAILURE_POLICY).sort()).toEqual([...ToolFailureCode.options].sort());
  });

  it("gives every code guidance, because the model is told what to do about it", () => {
    for (const [code, policy] of Object.entries(FAILURE_POLICY)) {
      expect(policy.guidance.length, code).toBeGreaterThan(20);
    }
  });

  /**
   * A rejection is fixed by rewording, which is a retry. Marked non-retryable it read to the model
   * as "do not use this tool again this turn" — the tool being benched for the one failure it is
   * meant to recover from.
   */
  it("makes a provider rejection retryable and an exhausted balance not", () => {
    expect(isRetryable("rejected_by_provider")).toBe(true);
    expect(isRetryable("out_of_credits")).toBe(false);
    expect(isRetryable("cancelled")).toBe(false);
    expect(isRetryable("timed_out")).toBe(true);
  });
});

describe("ToolError", () => {
  it("derives retryable from the code rather than taking it from the caller", () => {
    expect(new ToolError("blocked", "rejected_by_provider").retryable).toBe(true);
    expect(new ToolError("broke", "out_of_credits").retryable).toBe(false);
  });

  it("defaults to internal, the code that assumes nothing", () => {
    expect(new ToolError("something").code).toBe("internal");
  });
});

/**
 * The bug this whole type exists for: a poll timeout reached the model as "that generation could
 * not be completed", so the model — owing the user an explanation and given none — invented one.
 * The reply blamed copyright restrictions for a request that was never refused.
 */
describe("a failure crossing the child-task boundary", () => {
  const failed = (code: Code, message: string) =>
    ({ ok: false as const, failure: { code, message } });

  it("carries the reason rather than a generic message", () => {
    const result = failed("timed_out", "The Magica run did not finish in time.");
    const rebuilt = new ToolError(result.failure.message, result.failure.code);

    expect(rebuilt.message).toBe("The Magica run did not finish in time.");
    expect(rebuilt.code).toBe("timed_out");
    expect(rebuilt.retryable).toBe(true);
  });

  it("keeps a timeout distinguishable from a refusal, which is what got confused", () => {
    expect(FAILURE_POLICY.timed_out.guidance).toMatch(/not refused/i);
    expect(FAILURE_POLICY.rejected_by_provider.guidance).toMatch(/reword/i);
  });
});
