import { describe, expect, it } from "vitest";
import type { ContentBlock } from "@/contracts";
import { buildSystemPrompt, toModelMessages } from "@/prompts/system";

const SYSTEM_PROMPT = buildSystemPrompt([]);

const build = (a: Partial<Parameters<typeof toModelMessages>[0]>) =>
  toModelMessages({ history: [], blocks: [], resolutions: [], ...a });

describe("the base prompt", () => {
  it("tells the model how to read a failed tool result", () => {
    expect(SYSTEM_PROMPT, "the wrapper returns ok:false instead of throwing").toContain('"ok": false');
    expect(SYSTEM_PROMPT).toMatch(/retryable/);
    expect(SYSTEM_PROMPT).toMatch(/arguments\s+that just failed/);
  });

  it("forbids inventing a url, which is the one hallucination that looks real", () => {
    expect(SYSTEM_PROMPT).toMatch(/never\s+write\s+a\s+file\s+URL\s+yourself/i);
  });

  it("asks for a sentence before each tool call, and names more than images", () => {
    expect(SYSTEM_PROMPT).toMatch(/before\s+each\s+tool\s+call/i);
    expect(SYSTEM_PROMPT, "Magica is not image-only").toMatch(/video/i);
  });
});

describe("a fresh turn", () => {
  it("sends the conversation only, with no system message", () => {
    const messages = build({
      history: [
        { role: "user", content: "draw me a mountain" },
        { role: "assistant", content: "Here it is." },
        { role: "user", content: "now crop it" },
      ],
    });

    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(
      messages.some((m) => m.role === "system"),
      "the SDK rejects a system message inside `messages`; it goes in `instructions`",
    ).toBe(false);
  });

  it("drops an empty message rather than sending a blank turn", () => {
    const messages = build({
      history: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "" },
      ],
    });

    expect(messages.map((m) => m.role)).toEqual(["user"]);
  });
});

describe("a turn resuming after an interaction", () => {
  const blocks: ContentBlock[] = [
    { segment: 0, type: "text", text: "Here is the plan." },
    { segment: 1, type: "tool_use", id: "call_plan", name: "submit_plan", input: { steps: [] } },
  ];

  it("replays the assistant's own output with the resolution as that tool's result", () => {
    const messages = build({
      history: [{ role: "user", content: "make me a poster" }],
      blocks,
      resolutions: [
        { toolUseId: "call_plan", toolName: "submit_plan", output: { approved: true } },
      ],
    });

    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);

    const assistant = messages[1];
    expect(Array.isArray(assistant?.content) && assistant.content).toEqual([
      { type: "text", text: "Here is the plan." },
      { type: "tool-call", toolCallId: "call_plan", toolName: "submit_plan", input: { steps: [] } },
    ]);

    const toolMessage = messages[2];
    expect(Array.isArray(toolMessage?.content) && toolMessage.content[0]).toMatchObject({
      type: "tool-result",
      toolCallId: "call_plan",
      output: { type: "json", value: { approved: true } },
    });
  });

  it("never emits a tool call it cannot answer", () => {
    const messages = build({
      blocks: [
        { segment: 0, type: "tool_use", id: "call_image", name: "gpt_image_2", input: {} },
        { segment: 0, type: "text", text: "Made the image." },
        { segment: 1, type: "tool_use", id: "call_plan", name: "submit_plan", input: {} },
      ],
      resolutions: [{ toolUseId: "call_plan", toolName: "submit_plan", output: { approved: true } }],
    });

    const assistant = messages.find((m) => m.role === "assistant");
    const calls = (Array.isArray(assistant?.content) ? assistant.content : []).filter(
      (p) => typeof p === "object" && p.type === "tool-call",
    );

    expect(calls, "one dangling call makes a provider reject the whole request").toHaveLength(1);
    expect(calls[0]).toMatchObject({ toolCallId: "call_plan" });
  });

  it("does not replay reasoning, which is ours to display and not part of the conversation", () => {
    const messages = build({
      blocks: [
        { segment: 0, type: "thinking", thinking: "private deliberation", durationMs: 10 },
        { segment: 0, type: "tool_use", id: "call_plan", name: "submit_plan", input: {} },
      ],
      resolutions: [{ toolUseId: "call_plan", toolName: "submit_plan", output: {} }],
    });

    expect(JSON.stringify(messages)).not.toContain("private deliberation");
  });

  it("emits no assistant message when the turn produced nothing to replay", () => {
    const messages = build({ history: [{ role: "user", content: "hi" }] });

    expect(messages.some((m) => m.role === "assistant")).toBe(false);
    expect(messages.some((m) => m.role === "tool")).toBe(false);
  });
});
