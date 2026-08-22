import { describe, expect, it } from "vitest";
import { REASONING_TAIL_CHARS } from "@/contracts";
import { createTurnState } from "@/agent/turn-state";

const types = (state: ReturnType<typeof createTurnState>) =>
  state.blocks().map((b) => `${b.segment}:${b.type}`);

describe("segment breaks", () => {
  it("keeps text and the tool call it leads into in different groups", () => {
    const state = createTurnState();

    state.appendText("I'll generate that.");
    state.pushToolUse({ id: "call_1", name: "gpt_image_2", input: {} });

    expect(types(state)).toEqual(["0:text", "1:tool_use"]);
  });

  it("counts reasoning inside a group rather than breaking it", () => {
    const state = createTurnState();

    state.appendReasoning("weighing options", 1_000);
    state.closeReasoning(1_500);
    state.pushToolUse({ id: "call_1", name: "gpt_image_2", input: {} });

    expect(types(state), "a Reasoned row is a row in the group, not a new group").toEqual([
      "0:thinking",
      "0:tool_use",
    ]);
  });

  it("groups a multi-step turn the way the reference renders it", () => {
    const state = createTurnState();

    state.appendText("First I'll make the image.");
    state.pushToolUse({ id: "call_1", name: "gpt_image_2", input: {} });
    state.appendText("Now I'll crop it.");
    state.pushToolUse({ id: "call_2", name: "crop_image", input: {} });
    state.appendText("Done.");
    state.closeText();

    expect(types(state)).toEqual([
      "0:text",
      "1:tool_use",
      "1:text",
      "2:tool_use",
      "2:text",
    ]);
    expect(state.segments()).toBe(3);
  });

  it("leaves no dangling group when the turn ends on text", () => {
    const state = createTurnState();

    state.appendText("Just answering.");
    state.closeText();

    expect(state.segments(), "closing trailing text must not open an empty group").toBe(1);
  });

  it("starts a new group after a waitpoint resolves", () => {
    const state = createTurnState();

    state.pushToolUse({ id: "call_1", name: "submit_plan", input: {} });
    state.breakSegment();
    state.appendText("Approved, starting.");
    state.closeText();

    expect(types(state)).toEqual(["0:tool_use", "1:text"]);
  });

  it("does not emit an empty text block", () => {
    const state = createTurnState();

    expect(state.closeText()).toBe(false);
    expect(state.blocks()).toEqual([]);
  });
});

describe("stream offsets", () => {
  it("counts characters only on closed text blocks", () => {
    const state = createTurnState();

    state.appendText("twelve chars");
    state.pushToolUse({ id: "call_1", name: "gpt_image_2", input: {} });

    const projection = state.projection();

    expect(projection[0]).toMatchObject({ type: "text", chars: 12 });
    expect(projection[1]).toMatchObject({ type: "tool_use", toolUseId: "call_1" });
    expect(projection[1]?.chars, "a tool call consumes no stream characters").toBeUndefined();
  });

  it("never charges the stream for reasoning, which does not travel on it", () => {
    const state = createTurnState();

    state.appendText("abc");
    state.appendReasoning("a very long private deliberation", 0);
    state.closeReasoning(100);
    state.appendText("de");
    state.closeText();

    const thinking = state.projection().find((b) => b.type === "thinking");

    expect(thinking?.chars, "counting it would offset every later text block").toBeUndefined();
    expect(state.streamOffset(), "only 'abc' + 'de' were streamed").toBe(5);
  });

  it("marks exactly one block streaming, and it is the open one", () => {
    const state = createTurnState();

    state.appendText("closed");
    state.pushToolUse({ id: "call_1", name: "gpt_image_2", input: {} });
    state.appendText("still writing");

    const streaming = state.projection().filter((b) => b.streaming);

    expect(streaming).toHaveLength(1);
    expect(streaming[0]).toMatchObject({ segment: 1, type: "text" });
    expect(streaming[0]?.chars, "an open block has no final count yet").toBeUndefined();
  });

  it("bounds the projection to the metadata cap, keeping the newest rows", () => {
    const state = createTurnState();

    for (let i = 0; i < 80; i++) {
      state.pushToolUse({ id: `call_${i}`, name: "gpt_image_2", input: {} });
    }

    const projection = state.projection();

    expect(projection, "RunMetadata.blocks maxes at 60 and would reject a longer snapshot")
      .toHaveLength(60);
    expect(projection.at(-1)?.toolUseId).toBe("call_79");
    expect(state.blocks(), "the persisted timeline keeps everything").toHaveLength(80);
  });
});

describe("reasoning", () => {
  it("returns a bounded tail while open and the full text once closed", () => {
    const state = createTurnState();
    const long = "x".repeat(REASONING_TAIL_CHARS + 500);

    state.appendReasoning(long, 0);

    expect(state.reasoningTail()).toHaveLength(REASONING_TAIL_CHARS);

    state.closeReasoning(0);
    const block = state.blocks()[0];

    expect(block?.type).toBe("thinking");
    expect(block?.type === "thinking" && block.thinking).toHaveLength(long.length);
  });

  it("records how long it thought for", () => {
    const state = createTurnState();

    state.appendReasoning("hmm", 1_000);
    state.closeReasoning(3_500);

    const block = state.blocks()[0];

    expect(block?.type === "thinking" && block.durationMs).toBe(2_500);
  });

  it("has no tail before any reasoning arrives", () => {
    expect(createTurnState().reasoningTail()).toBeUndefined();
  });
});

describe("the usage footer", () => {
  it("joins the last group instead of opening one of its own", () => {
    const state = createTurnState();

    state.appendText("Just answering.");
    state.closeText();
    state.pushUsage({ inputTokens: 100, outputTokens: 40 });

    expect(types(state)).toEqual(["0:text", "0:usage"]);
    expect(state.segments(), "a group holding only a token count is not a step").toBe(1);
  });

  it("joins the tool's group when the turn ended on a tool call", () => {
    const state = createTurnState();

    state.pushToolUse({ id: "call_1", name: "gpt_image_2", input: {} });
    state.pushUsage({ inputTokens: 1, outputTokens: 2 });

    expect(types(state)).toEqual(["0:tool_use", "0:usage"]);
  });
});
