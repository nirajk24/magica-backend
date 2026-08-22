import { describe, expect, it, vi } from "vitest";
import type { ContentBlock, RunMetadata } from "@/contracts";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  runAgentTurn,
  type AgentTurnDeps,
  type TurnStreamPart,
  type TurnUsage,
} from "@/agent/run-agent-turn";

type Recorder = {
  deps: AgentTurnDeps;
  calls: string[];
  metadata: Partial<RunMetadata>;
  patches: Partial<RunMetadata>[];
  streamed: string[];
  persisted: ContentBlock[][];
  finalized: { blocks: ContentBlock[]; tokenUsage: unknown } | null;
  failed: { reason: string; blocks: ContentBlock[] } | null;
  turnsStarted: number;
};

const USAGE: TurnUsage = { inputTokens: 100, outputTokens: 40 };

/**
 * Fakes for every seam. `turns` is a list of stream scripts, one per expected model call, so a test
 * declares the conversation and asserts what the loop did with it.
 */
function harness(a: {
  turns: TurnStreamPart[][];
  usage?: TurnUsage;
  resolution?: unknown;
  onSuspend?: () => void;
}): Recorder {
  const rec: Recorder = {
    calls: [],
    metadata: {},
    patches: [],
    streamed: [],
    persisted: [],
    finalized: null,
    failed: null,
    turnsStarted: 0,
    deps: {} as AgentTurnDeps,
  };

  let clock = 1_000;

  rec.deps = {
    bootstrap: (runId) => {
      rec.calls.push(`bootstrap(${runId})`);
      return Promise.resolve({
        modelId: "google/gemma-4-31b-it:free",
        assistantMessageId: "msg_assistant",
        history: [],
      });
    },

    startStream: () => {
      const script = a.turns[rec.turnsStarted] ?? [];
      rec.turnsStarted++;
      rec.calls.push(`startStream#${rec.turnsStarted}`);

      return {
        parts: (async function* () {
          for (const part of script) yield await Promise.resolve(part);
        })(),
        usage: Promise.resolve(a.usage ?? USAGE),
      };
    },

    appendText: (delta) => {
      rec.streamed.push(delta);
      return Promise.resolve();
    },

    setMetadata: (patch) => {
      rec.patches.push(patch);
      Object.assign(rec.metadata, patch);
      return Promise.resolve();
    },

    flushMetadata: () => {
      rec.calls.push("flush");
      return Promise.resolve();
    },

    persistBlocks: ({ blocks }) => {
      rec.persisted.push(blocks as ContentBlock[]);
      return Promise.resolve();
    },

    suspendOn: (interaction) => {
      rec.calls.push(`suspendOn(${interaction.toolName})`);
      a.onSuspend?.();
      return Promise.resolve(
        (a.resolution ?? { kind: "plan_approval", approved: true }) as never,
      );
    },

    recordResolution: ({ interaction, resolution }) => {
      rec.calls.push("recordResolution");
      return Promise.resolve({ toolUseId: interaction.toolUseId, output: resolution });
    },

    finalize: ({ blocks, tokenUsage }) => {
      rec.calls.push("finalize");
      rec.finalized = { blocks: blocks as ContentBlock[], tokenUsage };
      return Promise.resolve();
    },

    finalizeFailed: ({ reason, blocks }) => {
      rec.calls.push("finalizeFailed");
      rec.failed = { reason, blocks: blocks as ContentBlock[] };
      return Promise.resolve();
    },

    now: () => (clock += 500),
    log: logger,
  };

  return rec;
}

const text = (t: string): TurnStreamPart => ({ type: "text-delta", text: t });
const toolCall = (name: string, id = "call_1"): TurnStreamPart => ({
  type: "tool-call",
  toolCallId: id,
  toolName: name,
  input: { prompt: "a mountain" },
});

describe("a plain answer", () => {
  it("streams the text, finalizes once, and reports one turn", async () => {
    const rec = harness({ turns: [[text("Hello "), text("there.")]] });

    const result = await runAgentTurn(rec.deps, { runId: "run_1" });

    expect(result).toMatchObject({ status: "completed", turns: 1, segments: 1 });
    expect(rec.streamed.join("")).toBe("Hello there.");
    expect(rec.calls.filter((c) => c === "finalize")).toHaveLength(1);
    expect(rec.failed).toBeNull();
  });

  it("closes the trailing text block before finalizing, or the prose is lost", async () => {
    const rec = harness({ turns: [[text("The whole answer.")]] });

    await runAgentTurn(rec.deps, { runId: "run_1" });

    expect(rec.finalized?.blocks.find((b) => b.type === "text")).toEqual({
      segment: 0,
      type: "text",
      text: "The whole answer.",
    });
  });

  it("records both token counts or neither, never a zero", async () => {
    const complete = harness({ turns: [[text("hi")]], usage: USAGE });
    const partial = harness({ turns: [[text("hi")]], usage: { inputTokens: 100 } });

    await runAgentTurn(complete.deps, { runId: "run_1" });
    await runAgentTurn(partial.deps, { runId: "run_2" });

    expect(complete.finalized?.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 40 });
    expect(partial.finalized?.tokenUsage, "0 tokens is a wrong number, not a missing one").toBeNull();
    expect(
      partial.finalized?.blocks.some((b) => b.type === "usage"),
      "no counts means no usage row",
    ).toBe(false);
  });
});

describe("tool calls", () => {
  it("breaks the step group between text and the tool it leads into", async () => {
    const rec = harness({ turns: [[text("I'll draw it."), toolCall("gpt_image_2")]] });

    const result = await runAgentTurn(rec.deps, { runId: "run_1" });

    expect(rec.finalized?.blocks.map((b) => `${b.segment}:${b.type}`)).toEqual([
      "0:text",
      "1:tool_use",
      "1:usage",
    ]);
    expect(result.segments).toBe(2);
  });

  it("persists blocks as they close, not only at the end", async () => {
    const rec = harness({
      turns: [[text("one"), toolCall("gpt_image_2", "call_1"), text("two")]],
    });

    await runAgentTurn(rec.deps, { runId: "run_1" });

    expect(rec.persisted.length, "a crash mid-turn must not lose the tool call").toBeGreaterThan(0);
    expect(rec.persisted.at(-1)?.some((b) => b.type === "tool_use")).toBe(true);
  });

  it("names the running step from the registry, never from a hardcoded label", async () => {
    const rec = harness({ turns: [[toolCall("gpt_image_2")]] });

    await runAgentTurn(rec.deps, { runId: "run_1" });

    expect(rec.metadata.currentStep).toBe("Generating image");
    expect(rec.metadata.phase).toBe("finalizing");
  });

  it("tolerates a tool name it does not know instead of throwing", async () => {
    const rec = harness({ turns: [[toolCall("not_a_registered_tool")]] });

    const result = await runAgentTurn(rec.deps, { runId: "run_1" });

    expect(result.status).toBe("completed");
    expect(rec.finalized?.blocks.some((b) => b.type === "tool_use")).toBe(true);
  });
});

describe("reasoning", () => {
  it("streams the tail to metadata and persists the block on close", async () => {
    const rec = harness({
      turns: [
        [
          { type: "reasoning-delta", text: "weighing " },
          { type: "reasoning-delta", text: "options" },
          { type: "reasoning-end" },
          text("Here you go."),
        ],
      ],
    });

    await runAgentTurn(rec.deps, { runId: "run_1" });

    expect(rec.patches.some((p) => p.reasoningText === "weighing options")).toBe(true);

    const thinking = rec.finalized?.blocks.find((b) => b.type === "thinking");
    expect(thinking).toMatchObject({ type: "thinking", thinking: "weighing options" });
  });

  it("never puts reasoning on the text stream", async () => {
    const rec = harness({
      turns: [[{ type: "reasoning-delta", text: "private" }, { type: "reasoning-end" }, text("ok")]],
    });

    await runAgentTurn(rec.deps, { runId: "run_1" });

    expect(rec.streamed.join(""), "it would offset every later text block").toBe("ok");
  });
});

describe("waitpoints", () => {
  it("suspends on an interaction tool, records the resolution, and continues", async () => {
    const rec = harness({
      turns: [[text("Here is the plan."), toolCall("submit_plan")], [text("Starting now.")]],
    });

    // `submit_plan` is not registered until Phase 4, so drive the interaction through a stub.
    const registry = await import("@/tools/registry");
    const spy = vi.spyOn(registry, "getTool").mockImplementation((name) =>
      name === "submit_plan"
        ? ({
            name,
            description: "d",
            display: { label: "Waiting for approval", icon: "check" },
            interaction: "plan_approval",
          } as never)
        : undefined,
    );

    const result = await runAgentTurn(rec.deps, { runId: "run_1" });
    spy.mockRestore();

    expect(result).toMatchObject({ status: "completed", turns: 2 });
    expect(rec.calls.filter((c) => c.startsWith("suspendOn"))).toHaveLength(1);
    expect(rec.calls.filter((c) => c === "recordResolution")).toHaveLength(1);
  });

  it("flushes metadata BEFORE suspending, or a reload renders no approval card", async () => {
    let phaseAtSuspend: string | undefined;
    let flushedBefore = false;

    const rec = harness({
      turns: [[toolCall("submit_plan")], [text("done")]],
      onSuspend: () => {
        phaseAtSuspend = rec.metadata.phase;
        flushedBefore = rec.calls.includes("flush");
      },
    });

    const registry = await import("@/tools/registry");
    const spy = vi.spyOn(registry, "getTool").mockImplementation((name) =>
      name === "submit_plan"
        ? ({
            name,
            description: "d",
            display: { label: "Waiting", icon: "check" },
            interaction: "plan_approval",
          } as never)
        : undefined,
    );

    await runAgentTurn(rec.deps, { runId: "run_1" });
    spy.mockRestore();

    expect(phaseAtSuspend, "the client must see it is waiting").toBe("waiting");
    expect(flushedBefore, "Trigger.dev batches metadata writes").toBe(true);
    expect(
      rec.calls.indexOf("flush") < rec.calls.indexOf("suspendOn(submit_plan)"),
      "flush must precede the suspend",
    ).toBe(true);
  });
});

describe("failure paths", () => {
  it("retries an empty stream exactly once, then fails safely", async () => {
    const rec = harness({ turns: [[], []] });

    const result = await runAgentTurn(rec.deps, { runId: "run_1" });

    expect(rec.turnsStarted, "one retry, not a loop").toBe(2);
    expect(result).toMatchObject({ status: "failed", reason: "empty response" });
    expect(rec.failed?.reason).toMatch(/empty response/i);
    expect(rec.finalized).toBeNull();
  });

  it("recovers when the retry produces content", async () => {
    const rec = harness({ turns: [[], [text("second time lucky")]] });

    const result = await runAgentTurn(rec.deps, { runId: "run_1" });

    expect(result).toMatchObject({ status: "completed", turns: 2 });
    expect(rec.streamed.join("")).toBe("second time lucky");
  });

  it("converts a mid-stream error part instead of ending the turn silently", async () => {
    const rec = harness({
      turns: [[text("partial"), { type: "error", error: new Error("provider exploded") }]],
    });

    const result = await runAgentTurn(rec.deps, { runId: "run_1" });

    expect(result.status).toBe("failed");
    expect(rec.failed?.reason).toBe("The model stopped responding partway through.");
    expect(rec.failed?.reason, "provider text must not reach a user").not.toContain("exploded");
  });

  it("keeps the partial output a failed turn already showed the user", async () => {
    const rec = harness({
      turns: [
        [
          text("I'll draw it. "),
          toolCall("gpt_image_2"),
          { type: "error", error: new Error("provider died") },
        ],
      ],
    });

    await runAgentTurn(rec.deps, { runId: "run_1" });

    const kinds = rec.failed?.blocks.map((b) => b.type);
    expect(kinds, "a failed turn that renders empty loses everything the user watched").toEqual([
      "text",
      "tool_use",
    ]);
  });

  it("never lets an error escape, because Trigger.dev reports it with no message", async () => {
    const rec = harness({ turns: [[text("hi")]] });
    rec.deps.bootstrap = () => Promise.reject(new Error("database unreachable"));

    const result = await runAgentTurn(rec.deps, { runId: "run_1" });

    expect(result.status).toBe("failed");
    expect(rec.failed?.reason).toBe("The assistant could not finish this turn.");
  });

  it("finalizes exactly once even when the model keeps asking to continue", async () => {
    const rec = harness({
      turns: Array.from({ length: env.MAX_TURNS + 3 }, () => [toolCall("submit_plan")]),
    });

    const registry = await import("@/tools/registry");
    const spy = vi.spyOn(registry, "getTool").mockImplementation((name) =>
      name === "submit_plan"
        ? ({
            name,
            description: "d",
            display: { label: "Waiting", icon: "check" },
            interaction: "plan_approval",
          } as never)
        : undefined,
    );

    const result = await runAgentTurn(rec.deps, { runId: "run_1" });
    spy.mockRestore();

    expect(rec.turnsStarted, "MAX_TURNS is the hard cap on OpenRouter requests").toBe(env.MAX_TURNS);
    expect(result).toMatchObject({ status: "failed", reason: "turn limit reached" });
    expect(rec.calls.filter((c) => c === "finalize")).toHaveLength(0);
    expect(rec.calls.filter((c) => c === "finalizeFailed")).toHaveLength(1);
  });
});
