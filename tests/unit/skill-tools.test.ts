import { beforeEach, describe, expect, it } from "vitest";
import { ToolError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { loadSkillRegistry } from "@/lib/skills/load";
import { skillsRoot } from "@/lib/skills/scan";
import type { ToolCtx } from "@/tools/define";
import { loadSkill } from "@/tools/load-skill";
import { readSkillAssetTool } from "@/tools/read-skill-asset";

type Recorded = { skillName: string; assetPath: string; contentHash: string };

function fakeCtx(loaded: string[] = []) {
  const recorded: Recorded[] = [];

  const ctx: ToolCtx = {
    userId: "user_1",
    chatId: "chat_1",
    runId: "run_1",
    invocationId: "inv_1",
    runNode: () => Promise.reject(new Error("a skill loader must never reach a provider")),
    reportCost: () => {
      throw new Error("a skill load is free and must not report a cost");
    },
    updatePlanStep: () => Promise.reject(new Error("no plan in this fake")),
    loadedSkillNames: () => Promise.resolve(loaded),
    recordSkillLoad: (a) => {
      recorded.push(a);
      return Promise.resolve();
    },
    log: logger,
  };

  return { ctx, recorded };
}

const run = (input: unknown, ctx: ToolCtx) =>
  loadSkill.execute!(loadSkill.input.parse(input) as never, ctx);

beforeEach(() => {
  loadSkillRegistry(skillsRoot());
});

describe("4. unknown skill", () => {
  it("returns a tool-error the model can recover from, and names what does exist", async () => {
    const { ctx, recorded } = fakeCtx();

    await expect(run({ name: "no-such-skill" }, ctx)).rejects.toThrow(ToolError);
    await expect(run({ name: "no-such-skill" }, ctx)).rejects.toThrow(/image-editing/);
    expect(recorded, "nothing is recorded for a skill that does not exist").toHaveLength(0);
  });

  it("is not retryable, so the model rephrases instead of hammering the same name", async () => {
    const { ctx } = fakeCtx();

    await expect(run({ name: "no-such-skill" }, ctx)).rejects.toMatchObject({ retryable: false });
  });

  it("rejects a name that could not be a directory before looking anything up", () => {
    for (const name of ["../etc", "Image-Editing", "a b", ""]) {
      expect(loadSkill.input.safeParse({ name }).success, name).toBe(false);
    }
  });
});

describe("the load budget", () => {
  it("loads a skill and records it with its content hash", async () => {
    const { ctx, recorded } = fakeCtx();
    const result = await run({ name: "image-editing" }, ctx);

    expect(result.guidance).toContain("Crop before you generate");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ skillName: "image-editing", assetPath: "" });
    expect(recorded[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a third distinct skill, and says to carry on rather than failing the turn", async () => {
    const { ctx, recorded } = fakeCtx(["image-editing", "video-production"]);

    await expect(run({ name: "media-planning" }, ctx)).rejects.toThrow(/is the limit/);
    await expect(run({ name: "media-planning" }, ctx)).rejects.toThrow(
      /continue with the guidance you have/i,
    );
    expect(recorded).toHaveLength(0);
  });

  /** A repeat is a dedup, so re-reading costs nothing the model has not already spent. */
  it("still serves a skill already loaded, even at the budget", async () => {
    const { ctx, recorded } = fakeCtx(["image-editing", "video-production"]);

    await expect(run({ name: "image-editing" }, ctx)).resolves.toMatchObject({
      name: "image-editing",
    });
    expect(recorded).toHaveLength(1);
  });

  it("costs no credits", () => {
    expect(loadSkill.credits(loadSkill.input.parse({ name: "image-editing" }))).toBe(0n);
    expect(readSkillAssetTool.credits(undefined as never)).toBe(0n);
  });
});

describe("read_skill_asset", () => {
  const readAsset = (input: unknown, ctx: ToolCtx) =>
    readSkillAssetTool.execute!(readSkillAssetTool.input.parse(input) as never, ctx);

  it("reads a file the guidance names", async () => {
    const { ctx, recorded } = fakeCtx(["image-editing"]);
    const result = await readAsset({ name: "image-editing", path: "sizes.md" }, ctx);

    expect(result.content).toContain("1024x1536");
    expect(recorded[0]).toMatchObject({ skillName: "image-editing", assetPath: "sizes.md" });
  });

  it("requires the skill to be loaded first, which also closes the budget", async () => {
    const { ctx, recorded } = fakeCtx([]);

    await expect(readAsset({ name: "image-editing", path: "sizes.md" }, ctx)).rejects.toThrow(
      /load the "image-editing" skill before reading its files/i,
    );
    expect(recorded, "reaching a new skill this way would skip the limit").toHaveLength(0);
  });

  it("turns an out-of-bounds path into a tool-error, not a crash", async () => {
    const { ctx } = fakeCtx(["image-editing"]);

    await expect(
      readAsset({ name: "image-editing", path: "../../package.json" }, ctx),
    ).rejects.toThrow(ToolError);
  });

  it("never echoes a filesystem path back to the model", async () => {
    const { ctx } = fakeCtx(["image-editing"]);

    await expect(
      readAsset({ name: "image-editing", path: "../../package.json" }, ctx),
    ).rejects.toThrow(/is outside the "image-editing" skill/);
  });
});
