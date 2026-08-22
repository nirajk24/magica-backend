import { describe, expect, it } from "vitest";
import type { TextStreamPart, ToolSet } from "ai";
import { describeStreamError, toTurnStreamPart } from "@/agent/llm";
import { AppError } from "@/lib/errors";

const part = (p: unknown) => toTurnStreamPart(p as TextStreamPart<ToolSet>);

/**
 * These are the AI SDK v7 field names verified in decisions #48. They differ from v5 — `.text`
 * where v5 had `.textDelta`, `.input` where v5 had `.args` — and a rename would otherwise show up
 * as a stream that silently yields nothing.
 */
describe("mapping the SDK's stream onto ours", () => {
  it("reads text from `.text`", () => {
    expect(part({ type: "text-delta", text: "hello", id: "1" })).toEqual({
      type: "text-delta",
      text: "hello",
    });
  });

  it("reads reasoning from `.text` too, and passes the end marker through", () => {
    expect(part({ type: "reasoning-delta", text: "thinking", id: "1" })).toEqual({
      type: "reasoning-delta",
      text: "thinking",
    });
    expect(part({ type: "reasoning-end", id: "1" })).toEqual({ type: "reasoning-end" });
  });

  it("reads tool arguments from `.input`, not `.args`", () => {
    expect(
      part({
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "gpt_image_2",
        input: { prompt: "a mountain" },
      }),
    ).toEqual({
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "gpt_image_2",
      input: { prompt: "a mountain" },
    });
  });

  it("surfaces a mid-stream error as user-safe copy, not the raw provider error", () => {
    const mapped = part({ type: "error", error: new Error("provider died") });

    expect(mapped?.type).toBe("error");
    expect(
      mapped?.type === "error" && mapped.error instanceof AppError,
      "the loop persists this message, so it must already be safe to show",
    ).toBe(true);
  });

  it("drops the parts we do not act on rather than passing them on as unknowns", () => {
    for (const type of [
      "start",
      "finish",
      "start-step",
      "finish-step",
      "text-start",
      "text-end",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-result",
    ]) {
      expect(part({ type }), `${type} should be dropped`).toBeNull();
    }
  });
});

describe("classifying a provider failure", () => {
  /** Detected structurally: the provider bundles its own copy of the error class. */
  const apiError = (fields: { statusCode?: number; isRetryable?: boolean }) =>
    Object.assign(new Error("Provider returned error"), fields);

  it("says the model is busy for a rate limit, not that it crashed", () => {
    const mapped = describeStreamError(apiError({ statusCode: 429, isRetryable: true }));

    expect(mapped.code).toBe("RATE_LIMITED");
    expect(mapped.message).toBe("The model is busy right now. Try again in a moment.");
  });

  it("separates a rejected request from an unavailable one", () => {
    expect(describeStreamError(apiError({ statusCode: 401 })).code).toBe("FORBIDDEN");
    expect(describeStreamError(apiError({ statusCode: 403 })).code).toBe("FORBIDDEN");
  });

  it("tells the user to try again when the provider says it is retryable", () => {
    expect(describeStreamError(apiError({ isRetryable: true })).message).toMatch(
      /temporarily unavailable/,
    );
  });

  it("falls back to one generic sentence for anything unrecognised", () => {
    expect(describeStreamError(new Error("boom")).message).toBe(
      "The model stopped responding partway through.",
    );
    expect(describeStreamError(null).message).toBe(
      "The model stopped responding partway through.",
    );
  });

  it("never leaks the provider's own text", () => {
    const leaky = apiError({ statusCode: 429 });
    leaky.message = "upstream rejected credential PRIVATE-DETAIL";

    expect(describeStreamError(leaky).message).not.toContain("PRIVATE");
  });
});
