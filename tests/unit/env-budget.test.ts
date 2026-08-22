import { describe, expect, it } from "vitest";
import { env, exceedsRequestBudget } from "@/lib/env";

const budget = (maxTurns: number, maxSteps: number, dailyRequests = 50) =>
  exceedsRequestBudget({ maxTurns, maxSteps, dailyRequests });

describe("the loop's request budget", () => {
  it("rejects the pair that once multiplied out to 96 requests against a cap of 50", () => {
    expect(budget(12, 8), "the bug decision #49 caught by hand").toBe(true);
  });

  it("accepts the shipped defaults with room to spare", () => {
    expect(budget(3, 4)).toBe(false);
  });

  it("allows raising one bound for the demo but not both", () => {
    expect(budget(3, 6), "more inner tool rounds").toBe(false);
    expect(budget(4, 4), "one more outer turn").toBe(false);
    expect(budget(6, 8), "both at their maximum").toBe(true);
  });

  it("bounds one turn at half the day, whatever the day is", () => {
    expect(budget(5, 5, 50), "25 is exactly half").toBe(false);
    expect(budget(26, 1, 50), "26 is over").toBe(true);
    expect(budget(26, 1, 1_000), "the same pair is fine on a bigger allowance").toBe(false);
  });

  it("is enforced at boot, so a bad pair cannot reach the loop", () => {
    expect(
      budget(env.MAX_TURNS, env.MAX_STEPS, env.OPENROUTER_DAILY_REQUESTS),
      "the parsed env would have thrown if this were true",
    ).toBe(false);
  });
});
