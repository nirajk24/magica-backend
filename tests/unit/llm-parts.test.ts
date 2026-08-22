import { describe, expect, it } from "vitest";
import type { TextStreamPart, ToolSet } from "ai";
import { toTurnStreamPart } from "@/agent/llm";

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

  it("surfaces a mid-stream error, which the SDK reports as a part and not a rejection", () => {
    const error = new Error("provider died");

    expect(part({ type: "error", error })).toEqual({ type: "error", error });
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
