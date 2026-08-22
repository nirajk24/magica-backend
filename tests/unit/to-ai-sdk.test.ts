import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ToolSet } from "ai";
import { AppError, ToolError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { defineTool, type ToolCtx } from "@/tools/define";
import { gptImage2 } from "@/tools/gpt-image-2";
import { registry } from "@/tools/registry";
import { toAiSdkTools, type ToolOutcome, type ToolRuntime } from "@/tools/to-ai-sdk";

const TURN = { userId: "user_1", chatId: "chat_1", runId: "run_1" };

type Fakes = {
  runtime: ToolRuntime;
  calls: string[];
  charged: bigint | null;
  completed: { output: unknown; actualCost: bigint | null } | null;
  failed: { message: string } | null;
  nodeRuns: string[];
};

function fakes(opts?: { active?: boolean; chargeError?: unknown }): Fakes {
  const f: Fakes = {
    calls: [],
    charged: null,
    completed: null,
    failed: null,
    nodeRuns: [],
    runtime: {} as ToolRuntime,
  };

  let clock = 1_000;

  f.runtime = {
    isRunActive: () => {
      f.calls.push("isRunActive");
      return Promise.resolve(opts?.active ?? true);
    },
    beginInvocation: () => {
      f.calls.push("beginInvocation");
      return Promise.resolve("inv_1");
    },
    chargeEstimate: ({ amount }) => {
      f.calls.push("chargeEstimate");
      if (opts?.chargeError) return Promise.reject(opts.chargeError);
      f.charged = amount;
      return Promise.resolve();
    },
    runNode: ({ request }) => {
      f.calls.push("runNode");
      f.nodeRuns.push(request.nodeType);
      return Promise.resolve({ output: { images: ["https://cdn/1.png"] }, creditUsed: 7n });
    },
    completeInvocation: ({ output, actualCost }) => {
      f.calls.push("completeInvocation");
      f.completed = { output, actualCost };
      return Promise.resolve();
    },
    failInvocation: ({ message }) => {
      f.calls.push("failInvocation");
      f.failed = { message };
      return Promise.resolve();
    },
    now: () => (clock += 250),
    log: logger,
  };

  return f;
}

/** A registry of one, so a test states exactly the tool behaviour it is about. */
function oneTool(a: {
  execute?: (input: { value: string }, ctx: ToolCtx) => Promise<{ echo: string }>;
  credits?: bigint;
  interaction?: "plan_approval";
  output?: z.ZodType;
}) {
  return {
    demo_tool: defineTool({
      name: "demo_tool",
      description: "A tool that exists only to exercise the wrapper's ordering.",
      display: { label: "Demoing", icon: "beaker" },
      ...(a.interaction ? { interaction: a.interaction } : {}),
      input: z.object({ value: z.string().min(1) }),
      output: (a.output ?? z.object({ echo: z.string() })) as z.ZodType<{ echo: string }>,
      credits: () => a.credits ?? 1_000n,
      ...(a.execute ? { execute: a.execute } : {}),
    }),
  };
}

function invoke(set: ToolSet, name: string, input: unknown): Promise<ToolOutcome> {
  const entry = set[name] as
    | { execute?: (i: unknown, o: { toolCallId: string; messages: [] }) => Promise<ToolOutcome> }
    | undefined;

  if (!entry?.execute) throw new Error(`${name} has no execute`);
  return entry.execute(input, { toolCallId: "call_abc", messages: [] });
}

let f: Fakes;
beforeEach(() => {
  f = fakes();
});

describe("the happy path", () => {
  it("charges BEFORE executing, which is the whole ordering", async () => {
    const tools = oneTool({
      execute: () => {
        f.calls.push("execute");
        return Promise.resolve({ echo: "done" });
      },
    });

    const outcome = await invoke(toAiSdkTools(tools, TURN, f.runtime), "demo_tool", {
      value: "x",
    });

    expect(f.calls).toEqual([
      "isRunActive",
      "beginInvocation",
      "chargeEstimate",
      "execute",
      "completeInvocation",
    ]);
    expect(outcome).toEqual({ ok: true, data: { echo: "done" } });
  });

  it("settles the charge against what the provider actually billed", async () => {
    const tools = oneTool({
      credits: 5_000n,
      execute: (_input, ctx) => {
        ctx.reportCost(4_321n);
        return Promise.resolve({ echo: "ok" });
      },
    });

    await invoke(toAiSdkTools(tools, TURN, f.runtime), "demo_tool", { value: "x" });

    expect(f.charged, "the estimate is charged up front").toBe(5_000n);
    expect(f.completed?.actualCost, "the real figure is what gets reconciled").toBe(4_321n);
  });

  it("leaves the estimate standing when a provider reports nothing", async () => {
    const tools = oneTool({ execute: () => Promise.resolve({ echo: "ok" }) });

    await invoke(toAiSdkTools(tools, TURN, f.runtime), "demo_tool", { value: "x" });

    expect(f.completed?.actualCost, "nothing to reconcile is not the same as zero cost").toBeNull();
  });

  it("routes remote work through the durable child run, keyed on the invocation", async () => {
    const tools = oneTool({
      execute: async (_input, ctx) => {
        const { creditUsed } = await ctx.runNode({ nodeType: "gpt_image_2", input: {} });
        ctx.reportCost(creditUsed);
        return { echo: "ok" };
      },
    });

    await invoke(toAiSdkTools(tools, TURN, f.runtime), "demo_tool", { value: "x" });

    expect(f.nodeRuns, "a direct provider call would double-submit on replay").toEqual([
      "gpt_image_2",
    ]);
    expect(f.completed?.actualCost).toBe(7n);
  });
});

describe("nothing is charged for work that never starts", () => {
  it("aborts a stopped run before creating an invocation", async () => {
    f = fakes({ active: false });
    const tools = oneTool({
      execute: () => {
        f.calls.push("execute");
        return Promise.resolve({ echo: "ok" });
      },
    });

    const outcome = await invoke(toAiSdkTools(tools, TURN, f.runtime), "demo_tool", {
      value: "x",
    });

    expect(f.calls).toEqual(["isRunActive"]);
    expect(outcome).toMatchObject({ ok: false });
    expect(f.charged).toBeNull();
  });

  it("rejects bad arguments with something the model can act on", async () => {
    const tools = oneTool({ execute: () => Promise.resolve({ echo: "ok" }) });

    const outcome = await invoke(toAiSdkTools(tools, TURN, f.runtime), "demo_tool", {
      value: "",
    });

    expect(outcome).toMatchObject({ ok: false, retryable: false });
    expect(outcome.ok === false && outcome.error).toMatch(/value:.*call the tool again/s);
    expect(
      f.calls,
      "no invocation row: the model self-corrects, and a failed card for that is noise",
    ).toEqual(["isRunActive"]);
  });
});

describe("exhaustion is caught before the external cost", () => {
  it("never executes when the charge fails, and surfaces the reason", async () => {
    f = fakes({
      chargeError: new AppError("INSUFFICIENT_CREDITS", "Not enough credits to continue."),
    });
    const tools = oneTool({
      execute: () => {
        f.calls.push("execute");
        return Promise.resolve({ echo: "ok" });
      },
    });

    const outcome = await invoke(toAiSdkTools(tools, TURN, f.runtime), "demo_tool", {
      value: "x",
    });

    expect(f.calls, "execute must not appear").toEqual([
      "isRunActive",
      "beginInvocation",
      "chargeEstimate",
      "failInvocation",
    ]);
    expect(outcome).toEqual({
      ok: false,
      error: "Not enough credits to continue.",
      retryable: false,
    });
  });
});

describe("failures come back as data, not as exceptions", () => {
  it("passes a safety rejection through verbatim, because the model can rephrase", async () => {
    const tools = oneTool({
      execute: () =>
        Promise.reject(new ToolError("That prompt was blocked. Try describing it differently.")),
    });

    const outcome = await invoke(toAiSdkTools(tools, TURN, f.runtime), "demo_tool", {
      value: "x",
    });

    expect(outcome).toEqual({
      ok: false,
      error: "That prompt was blocked. Try describing it differently.",
      retryable: false,
    });
    expect(f.failed?.message).toBe("That prompt was blocked. Try describing it differently.");
  });

  it("carries the retryable flag so a rate limit reads differently from a rejection", async () => {
    const tools = oneTool({
      execute: () => Promise.reject(new ToolError("Magica is rate limiting us.", true)),
    });

    const outcome = await invoke(toAiSdkTools(tools, TURN, f.runtime), "demo_tool", {
      value: "x",
    });

    expect(outcome).toMatchObject({ ok: false, retryable: true });
  });

  it("never lets a raw provider error reach the model", async () => {
    const tools = oneTool({
      execute: () => Promise.reject(new Error("500 from upstream: token PRIVATE-DETAIL")),
    });

    const outcome = await invoke(toAiSdkTools(tools, TURN, f.runtime), "demo_tool", {
      value: "x",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).not.toContain("PRIVATE-DETAIL");
    expect(f.failed?.message).not.toContain("PRIVATE-DETAIL");
  });

  it("treats an output that breaks its own schema as a failure, not a success", async () => {
    const tools = oneTool({
      output: z.object({ echo: z.string() }),
      execute: () => Promise.resolve({ wrong: "shape" } as unknown as { echo: string }),
    });

    const outcome = await invoke(toAiSdkTools(tools, TURN, f.runtime), "demo_tool", {
      value: "x",
    });

    expect(outcome).toMatchObject({ ok: false });
    expect(f.completed, "an unvalidated result must never be recorded as complete").toBeNull();
    expect(f.failed).not.toBeNull();
  });
});

describe("interaction tools", () => {
  it("is registered with NO execute, which is what parks the turn", async () => {
    const set = toAiSdkTools(oneTool({ interaction: "plan_approval" }), TURN, f.runtime);
    const entry = set.demo_tool as { execute?: unknown };

    expect(
      entry.execute,
      "an execute here would silently turn an approval gate into a normal tool call",
    ).toBeUndefined();
    await expect(Promise.resolve(f.calls)).resolves.toEqual([]);
  });
});

describe("the real registry", () => {
  it("exposes every registered tool under its own name", () => {
    const set = toAiSdkTools(registry, TURN, f.runtime);

    expect(Object.keys(set)).toEqual(Object.keys(registry));
  });

  it("prices gpt_image_2 through its own schema defaults before executing", async () => {
    const set = toAiSdkTools({ [gptImage2.name]: gptImage2 }, TURN, {
      ...f.runtime,
      // Stop before the network: the charge is the only thing under test here.
      chargeEstimate: (a) => {
        f.charged = a.amount;
        return Promise.reject(new ToolError("stop here"));
      },
    });

    await invoke(set, gptImage2.name, { prompt: "a mountain" });

    expect(f.charged, "the cheap tier, since DEMO_MODE is off in tests").toBe(5_880n);
  });
});
