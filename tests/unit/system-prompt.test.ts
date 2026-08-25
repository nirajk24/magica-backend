import { describe, expect, it } from "vitest";
import type { ContentBlock } from "@/contracts";
import { buildSystemPrompt, toModelMessages } from "@/prompts/system";
import { FAILURE_POLICY } from "@/lib/tool-failure";
import { getTool } from "@/tools/registry";

const SYSTEM_PROMPT = buildSystemPrompt({ index: [] });

const build = (a: Partial<Parameters<typeof toModelMessages>[0]>) =>
  toModelMessages({ history: [], blocks: [], resolutions: [], ...a });

describe("the base prompt", () => {
  it("tells the model how to read a failed tool result", () => {
    expect(SYSTEM_PROMPT, "the wrapper returns ok:false instead of throwing").toContain('"ok": false');
    expect(SYSTEM_PROMPT).toMatch(/retryable/);
    expect(SYSTEM_PROMPT).toMatch(/arguments\s+that just failed/);
  });

  it("forbids inventing a url, which is the one hallucination that looks real", () => {
    expect(SYSTEM_PROMPT).toMatch(/never construct or guess one/i);
  });

  it("says nothing about planning unless the user asked for it", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/submit_plan/);
  });

  it("asks for a plan first when plan mode is on, without naming a tool anywhere else", () => {
    const planning = buildSystemPrompt({ planMode: true, index: [] });

    expect(planning).toMatch(/submit_plan/);
    expect(planning).toMatch(/before any tool that costs credits/i);
    expect(planning.startsWith(SYSTEM_PROMPT), "plan mode is added to the base, not a rewrite").toBe(
      true,
    );
  });

  it("runs one step at a time while a step-by-step plan has work left", () => {
    const prompt = buildSystemPrompt({
      index: [],
      activePlan: {
        title: "Poster",
        executionMode: "step_by_step",
        steps: [
          { key: "hero", title: "Generate", estimatedCredits: "5880", status: "completed" },
          { key: "crop", title: "Crop", estimatedCredits: "5000", status: "pending" },
        ],
      },
    });

    expect(prompt).toMatch(/STEP BY STEP/);
    expect(prompt).toMatch(/exactly ONE unfinished step/i);
    expect(prompt).toMatch(/update_step/);
    expect(prompt, "the model must see each step's state").toMatch(/hero \(completed\)/);
    expect(prompt).toMatch(/crop \(pending\)/);
  });

  it("leaves step mode once every step is finished", () => {
    const prompt = buildSystemPrompt({
      index: [],
      activePlan: {
        title: "Poster",
        executionMode: "step_by_step",
        steps: [
          { key: "hero", title: "Generate", estimatedCredits: "5880", status: "completed" },
          { key: "crop", title: "Crop", estimatedCredits: "5000", status: "failed" },
        ],
      },
    });

    expect(prompt).toBe(SYSTEM_PROMPT);
  });

  it("ignores a plan that was approved to run all at once", () => {
    const prompt = buildSystemPrompt({
      index: [],
      activePlan: {
        title: "Poster",
        executionMode: "auto",
        steps: [{ key: "hero", title: "Generate", estimatedCredits: "5880", status: "pending" }],
      },
    });

    expect(prompt).toBe(SYSTEM_PROMPT);
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

describe("file context on history messages", () => {
  it("appends a user message's attachments as labelled lines the model can act on", () => {
    const messages = build({
      history: [
        {
          role: "user",
          content: "Make this dark mode",
          files: [{ name: "shot.png", type: "image", url: "https://tmp.transloadit.com/shot.png" }],
        },
      ],
    });

    expect(messages[0]?.content).toBe(
      "Make this dark mode\n\n[Attached image: shot.png — https://tmp.transloadit.com/shot.png]",
    );
  });

  it("labels an assistant message's files as generated, which is what they were", () => {
    const messages = build({
      history: [
        {
          role: "assistant",
          content: "Here it is.",
          files: [{ name: "out.png", type: "image", url: "https://cdn.magica.com/out.png" }],
        },
      ],
    });

    expect(messages[0]?.content).toContain("[Generated image: out.png — https://cdn.magica.com/out.png]");
  });

  it("leaves a message without files untouched", () => {
    const messages = build({ history: [{ role: "user", content: "hello" }] });

    expect(messages[0]?.content).toBe("hello");
  });
});

/**
 * A rule whose absence makes the output WRONG rather than merely worse cannot sit behind
 * `load_skill`, which the model may or may not call. These are the ones that moved out of the
 * skills, and this is what stops them drifting back.
 */
describe("the tool-result contract", () => {
  it("writes every code's guidance from the policy table, so none can ship unexplained", () => {
    for (const [code, policy] of Object.entries(FAILURE_POLICY)) {
      expect(SYSTEM_PROMPT, code).toContain(`\`${code}\``);
      expect(SYSTEM_PROMPT, code).toContain(policy.guidance);
    }
  });

  it("forbids guessing a cause, which is how a poll timeout became a copyright story", () => {
    expect(SYSTEM_PROMPT).toMatch(/never speculate about why something failed/i);
  });
});

describe("rules that cannot depend on a skill being loaded", () => {
  it("forbids inventing a price in the prompt, not in media-planning", () => {
    expect(SYSTEM_PROMPT).toMatch(/never state a price/i);
  });

  it("forbids constructing a url in the prompt, not in video-production", () => {
    expect(SYSTEM_PROMPT).toMatch(/never construct or guess one/i);
  });

  /**
   * These two pulled in opposite directions inside one sentence — a ban on writing urls, then
   * "refer only to files a tool returned", which reads as leave to paste the tool's own url. 12 of
   * 112 assistant replies embedded one, mostly as `![alt](url)`. They are separate rules and the
   * prompt has to keep them apart.
   */
  it("bans a url in the reply without that reading as leave to paste a tool's own", () => {
    expect(SYSTEM_PROMPT).toMatch(/never appears in your reply/i);
    expect(SYSTEM_PROMPT, "the observed failure is a markdown embed").toContain("![alt](url)");
    expect(
      SYSTEM_PROMPT,
      "the old wording licensed the very thing the same sentence forbade",
    ).not.toMatch(/refer only\s+to files a tool returned/i);
  });

  it("puts the per-image charge on the tool that charges it", () => {
    expect(getTool("gpt_image_2")?.description).toMatch(/every extra image is charged/i);
  });

  it("puts the size rule on the tool whose enum it describes", () => {
    expect(getTool("gpt_image_2")?.description).toMatch(/`Auto` is the answer/);
  });

  it("puts crop-before-generate on the tool that is the cheaper path", () => {
    expect(getTool("crop_image")?.description).toMatch(/crop BEFORE generating/);
  });

  it("puts merge order on the tool that consumes the order", () => {
    expect(getTool("merge_videos")?.description).toMatch(/never sort the list/i);
  });
});
