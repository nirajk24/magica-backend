import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolError } from "@/lib/errors";
import { pollUntilTerminal, runMagicaNode } from "@/tools/magica-client";
import { resetFieldSpecs, validateNodeInput } from "@/tools/catalog-schema";
import {
  ensureCatalogPricing,
  estimateMicrocredits,
  resetPricing,
} from "@/tools/pricing";
import {
  catalogHandler,
  magicaHandlers,
  polled,
  resetMagica,
  submissions,
} from "../msw/magica";
import { server } from "../msw/setup";

const noSleep = () => Promise.resolve();

beforeEach(resetMagica);

describe("magica client", () => {
  it("submits, checkpoints the run id, then polls to completion", async () => {
    server.use(...magicaHandlers());
    const onRunId = vi.fn().mockResolvedValue(undefined);

    const result = await runMagicaNode({
      nodeType: "gpt_image_2",
      subModelId: "gpt-image-2-text",
      input: { prompt: "a mountain" },
      onRunId,
      sleep: noSleep,
    });

    expect(onRunId).toHaveBeenCalledExactlyOnceWith("run_fixture_1");
    expect(result.creditUsed).toBe(5880n);
    expect(result.output).toEqual({ images: ["https://cdn.magica.com/out/1.png"] });
  });

  it("checkpoints the run id BEFORE the first poll", async () => {
    server.use(...magicaHandlers());
    const order: string[] = [];

    await runMagicaNode({
      nodeType: "gpt_image_2",
      input: {},
      sleep: noSleep,
      onRunId: async () => {
        order.push(`checkpoint(polls so far: ${polled.length})`);
      },
    });

    expect(order).toEqual(["checkpoint(polls so far: 0)"]);
  });

  it("resumes an existing run without submitting again", async () => {
    server.use(...magicaHandlers({ runId: "run_already_submitted" }));

    const result = await pollUntilTerminal("run_already_submitted", noSleep);

    expect(submissions, "a resumed run must never re-submit").toEqual([]);
    expect(result.creditUsed).toBe(0n);
  });

  it("surfaces userMessage in preference to the raw error", async () => {
    server.use(
      ...magicaHandlers({
        polls: [
          {
            status: "FAILED",
            error: "Error: 400 rejected by the safety system",
            userMessage: "That prompt was blocked. Try describing it differently.",
          },
        ],
      }),
    );

    await expect(
      runMagicaNode({ nodeType: "gpt_image_2", input: {}, onRunId: noSleep, sleep: noSleep }),
    ).rejects.toThrow("That prompt was blocked. Try describing it differently.");
  });

  it("reports 403 as exhausted credits, not a permissions problem", async () => {
    server.use(...magicaHandlers({ runStatus: 403 }));

    await expect(
      runMagicaNode({ nodeType: "gpt_image_2", input: {}, onRunId: noSleep, sleep: noSleep }),
    ).rejects.toThrow(/out of credits/);
  });

  it("marks 429 retryable and carries Retry-After", async () => {
    server.use(...magicaHandlers({ runStatus: 429, retryAfter: "30" }));

    const error = await runMagicaNode({
      nodeType: "gpt_image_2",
      input: {},
      onRunId: noSleep,
      sleep: noSleep,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).retryable).toBe(true);
    expect((error as ToolError).message).toContain("30");
  });

  it("rejects a 200 because the contract says 202", async () => {
    server.use(...magicaHandlers({ runStatus: 200 }));

    await expect(
      runMagicaNode({ nodeType: "gpt_image_2", input: {}, onRunId: noSleep, sleep: noSleep }),
    ).rejects.toThrow(/did not accept the run \(200\)/);
  });

  it("treats CANCELED as a failure and never submits twice on it", async () => {
    server.use(...magicaHandlers({ polls: [{ status: "CANCELED" }] }));

    await expect(
      runMagicaNode({ nodeType: "gpt_image_2", input: {}, onRunId: noSleep, sleep: noSleep }),
    ).rejects.toThrow(/canceled/);
    expect(submissions).toHaveLength(1);
  });

  it("gives up after the default poll budget rather than looping forever", async () => {
    server.use(...magicaHandlers({ polls: [{ status: "RUNNING" }] }));

    await expect(pollUntilTerminal("run_stuck", noSleep)).rejects.toThrow(/did not finish in time/);
    expect(polled.filter((p) => p === "run_stuck")).toHaveLength(20);
  });

  it("honours a shorter budget, so a slow node type is not held to the image default", async () => {
    server.use(...magicaHandlers({ polls: [{ status: "RUNNING" }] }));

    await expect(pollUntilTerminal("run_brief", noSleep, 18_000)).rejects.toThrow(
      /did not finish in time/,
    );
    expect(polled.filter((p) => p === "run_brief")).toHaveLength(3);
  });

  it("polls at least once even for a budget below one interval", async () => {
    server.use(...magicaHandlers({ polls: [{ status: "COMPLETED", creditUsed: 10 }] }));

    const result = await pollUntilTerminal("run_tiny_budget", noSleep, 1);

    expect(result.creditUsed).toBe(10n);
  });
});

describe("catalog pricing", () => {
  it("hydrates prices AND field schemas from one fetch, keyed by nodeType", async () => {
    resetPricing();
    resetFieldSpecs();
    server.use(catalogHandler());

    const applied = await ensureCatalogPricing();

    expect(applied).toBe(1);
    expect(
      estimateMicrocredits("gpt_image_2", {}),
      "must be reachable under the nodeType, not under 'gpt-image-2'",
    ).toBe(500_000n);

    expect(() =>
      validateNodeInput({
        nodeType: "gpt_image_2",
        subModelId: "gpt-image-2-text",
        input: { prompt: "a mountain", size: "Auto" },
      }),
    ).not.toThrow();
    expect(
      () =>
        validateNodeInput({
          nodeType: "gpt_image_2",
          subModelId: "gpt-image-2-text",
          input: { image_url: "https://x.test/a.png" },
        }),
      "the fetched schema, not our Zod copy, is what rejects a stale field name",
    ).toThrow(/image_url is not a field/);

    resetFieldSpecs();
  });
});
