import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import { INPUT_VALUE_CHARS } from "@/contracts";
import { getBalance, sumLedger, topUp } from "@/lib/credits";
import { db } from "@/lib/db";
import { uuidv7 } from "@/lib/ids";
import { logger } from "@/lib/logger";
import { gptImage2 } from "@/tools/gpt-image-2";
import { toAiSdkTools, type ToolOutcome } from "@/tools/to-ai-sdk";
import { executeMagicaNode } from "@/trigger/magica-node-run";
import { createToolRuntime } from "@/agent/tool-runtime";
import { magicaHandlers, resetMagica, submissions } from "../msw/magica";
import { server } from "../msw/setup";

const START = 10_000_000n;
const ESTIMATE = 5_880n;

const created: string[] = [];
const noSleep = () => Promise.resolve();

async function seedRun(a?: { funds?: bigint; status?: "queued" | "cancelled" }) {
  const userId = `test_${uuidv7()}`;
  created.push(userId);

  const chatId = uuidv7();
  const runId = uuidv7();
  const userMessageId = uuidv7();

  await db.user.create({ data: { id: userId, email: `${userId}@test.local` } });
  await db.$transaction((tx) => topUp(tx, { userId, amount: a?.funds ?? START, key: userId }));
  await db.chat.create({ data: { id: chatId, userId, title: "t" } });
  await db.message.create({ data: { id: userMessageId, chatId, role: "user", content: "draw" } });
  await db.agentRun.create({
    data: {
      id: runId,
      chatId,
      userId,
      userMessageId,
      idempotencyKey: uuidv7(),
      status: a?.status ?? "queued",
    },
  });

  return { userId, chatId, runId };
}

/**
 * The real runtime, with only the Trigger.dev dispatch replaced: `triggerAndWait` needs a live run
 * context, and the child task's own behaviour is covered in `magica-node-run.test.ts`. Everything
 * below this line — the ordering, the ledger, the rows — is the shipping code.
 */
function toolsFor(turn: { userId: string; chatId: string; runId: string }) {
  const published: unknown[][] = [];
  const publishedPlans: unknown[] = [];
  const runtime = createToolRuntime({
    turn,
    publish: (invocations) => {
      published.push(invocations);
      return Promise.resolve();
    },
    publishPlan: (plan) => {
      publishedPlans.push(plan);
      return Promise.resolve();
    },
    log: logger,
  });

  const set = toAiSdkTools({ [gptImage2.name]: gptImage2 }, turn, {
    ...runtime,
    runNode: ({ invocationId, request }) =>
      executeMagicaNode(
        { invocationId, nodeType: request.nodeType, input: request.input },
        noSleep,
      ).then((r) => ({ output: r.output, creditUsed: BigInt(r.creditUsed) })),
  });

  return { set, published };
}

function invoke(set: ToolSet, input: unknown, toolCallId = "call_1"): Promise<ToolOutcome> {
  const entry = set[gptImage2.name] as unknown as {
    execute: (i: unknown, o: { toolCallId: string; messages: [] }) => Promise<ToolOutcome>;
  };
  return entry.execute(input, { toolCallId, messages: [] });
}

async function expectInvariant(userId: string) {
  const [balance, ledger] = await Promise.all([getBalance(userId), sumLedger(userId)]);
  expect(balance, "balance must equal SUM(ledger)").toBe(ledger);
  return balance;
}

beforeEach(resetMagica);

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
});

describe("a tool that succeeds", () => {
  it("charges the estimate, then settles to what the provider actually billed", async () => {
    server.use(
      ...magicaHandlers({
        polls: [{ status: "COMPLETED", output: { images: ["https://cdn/1.png"] }, creditUsed: 6_000 }],
      }),
    );
    const turn = await seedRun();
    const { set } = toolsFor(turn);

    const outcome = await invoke(set, { prompt: "a mountain" });

    expect(outcome).toMatchObject({ ok: true });

    const invocation = await db.toolInvocation.findFirstOrThrow({ where: { runId: turn.runId } });
    expect(invocation.status).toBe("completed");
    expect(invocation.magicaRunId, "checkpointed before polling").toBe("run_fixture_1");
    expect(invocation.creditUsed, "the card shows real spend, not the estimate").toBe(6_000n);

    const entries = await db.creditLedgerEntry.findMany({
      where: { userId: turn.userId, invocationId: invocation.id },
      orderBy: { createdAt: "asc" },
    });
    expect(entries.map((e) => e.amount)).toEqual([-ESTIMATE, -(6_000n - ESTIMATE)]);
    expect(await expectInvariant(turn.userId)).toBe(START - 6_000n);
  });

  it("publishes the live card with the label the registry owns", async () => {
    server.use(...magicaHandlers());
    const turn = await seedRun();
    const { set, published } = toolsFor(turn);

    await invoke(set, { prompt: "a mountain" });

    const last = published.at(-1) as { toolName: string; display: { label: string }; state: string }[];
    expect(last[0]).toMatchObject({
      toolName: "gpt_image_2",
      display: { label: "Generating image" },
      state: "completed",
    });
  });
});

describe("a tool that fails", () => {
  it("refunds the charge in full and leaves the balance where it started", async () => {
    server.use(
      ...magicaHandlers({
        polls: [
          {
            status: "FAILED",
            error: "400 blocked by the safety system",
            userMessage: "That prompt was blocked. Try describing it differently.",
          },
        ],
      }),
    );
    const turn = await seedRun();
    const { set } = toolsFor(turn);

    const outcome = await invoke(set, { prompt: "something blocked" });

    expect(outcome).toMatchObject({ ok: false });

    const invocation = await db.toolInvocation.findFirstOrThrow({ where: { runId: turn.runId } });
    expect(invocation.status).toBe("failed");
    expect(invocation.creditUsed, "a failed step is free").toBe(0n);
    expect(await expectInvariant(turn.userId)).toBe(START);
  });
});

describe("exhaustion is caught before any external cost", () => {
  it("never reaches Magica when the estimate cannot be charged", async () => {
    server.use(...magicaHandlers());
    const turn = await seedRun({ funds: ESTIMATE - 1n });
    const { set } = toolsFor(turn);

    const outcome = await invoke(set, { prompt: "a mountain" });

    expect(outcome).toMatchObject({ ok: false, error: "Not enough credits to continue." });
    expect(submissions, "the whole point of charging first").toEqual([]);

    const invocation = await db.toolInvocation.findFirstOrThrow({ where: { runId: turn.runId } });
    expect(invocation.status).toBe("failed");
    expect(await expectInvariant(turn.userId)).toBe(ESTIMATE - 1n);
  });
});

describe("a run that is no longer active", () => {
  it("opens no invocation and spends nothing", async () => {
    server.use(...magicaHandlers());
    const turn = await seedRun({ status: "cancelled" });
    const { set } = toolsFor(turn);

    const outcome = await invoke(set, { prompt: "a mountain" });

    expect(outcome).toMatchObject({ ok: false });
    expect(submissions).toEqual([]);
    await expect(db.toolInvocation.count({ where: { runId: turn.runId } })).resolves.toBe(0);
    expect(await expectInvariant(turn.userId)).toBe(START);
  });
});

describe("a replayed step", () => {
  it("reuses its invocation, charges once, and never pays Magica twice", async () => {
    server.use(...magicaHandlers());
    const turn = await seedRun();
    const { set } = toolsFor(turn);

    await invoke(set, { prompt: "a mountain" }, "call_same");
    await invoke(set, { prompt: "a mountain" }, "call_same");

    await expect(db.toolInvocation.count({ where: { runId: turn.runId } })).resolves.toBe(1);
    expect(submissions, "the second attempt resumes the first run").toHaveLength(1);

    const charges = await db.creditLedgerEntry.count({
      where: { userId: turn.userId, type: "settle" },
    });
    expect(charges, "one charge across both attempts").toBe(1);
    await expectInvariant(turn.userId);
  });
});

describe("the shortfall a reconcile cannot collect", () => {
  it("keeps the completed step and does not drive the balance negative", async () => {
    server.use(
      ...magicaHandlers({
        polls: [
          { status: "COMPLETED", output: { images: ["https://cdn/1.png"] }, creditUsed: 9_000_000 },
        ],
      }),
    );
    const turn = await seedRun({ funds: ESTIMATE + 100n });
    const warn = vi.spyOn(logger, "warn");
    const { set } = toolsFor(turn);

    const outcome = await invoke(set, { prompt: "a mountain" });

    expect(outcome, "the work is done; a rounding delta must not fail it").toMatchObject({
      ok: true,
    });

    const invocation = await db.toolInvocation.findFirstOrThrow({ where: { runId: turn.runId } });
    expect(invocation.status).toBe("completed");
    expect(await getBalance(turn.userId), "stops at what was collectable").toBe(100n);
    await expectInvariant(turn.userId);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("what a running tool card can show", () => {
  it("projects the tool's input, so a card is not blank while the tool works", async () => {
    const turn = await seedRun({ funds: 10_000_000n });
    const { set, published } = toolsFor(turn);

    await invoke(set, { prompt: "a mountain at sunrise", size: "1024x1536" });

    const first = published[0] as { input?: Record<string, unknown> }[];
    expect(first[0]?.input, "the reference shows these fields while the tool is still running")
      .toMatchObject({ prompt: "a mountain at sunrise", size: "1024x1536" });
  });

  /**
   * The snapshot is re-sent on every metadata change, so one long prompt is multiplied by the number
   * of updates in a turn. The persisted row keeps the full value for the finished card.
   */
  it("truncates a long value rather than amplifying it on every update", async () => {
    const turn = await seedRun({ funds: 10_000_000n });
    const { set, published } = toolsFor(turn);
    const long = "m".repeat(3_000);

    await invoke(set, { prompt: long });

    const projected = (published[0] as { input?: { prompt?: string } }[])[0]?.input?.prompt ?? "";
    expect(projected.length).toBeLessThanOrEqual(INPUT_VALUE_CHARS + 1);
    expect(projected.endsWith("…"), "truncation is visible, not silent").toBe(true);

    const row = await db.toolInvocation.findFirstOrThrow({ where: { runId: turn.runId } });
    expect(
      (row.input as { prompt: string }).prompt.length,
      "the persisted input is untouched — only the projection is lossy",
    ).toBe(3_000);
  });
});
