import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createToolRuntime } from "@/agent/tool-runtime";
import { db } from "@/lib/db";
import { uuidv7 } from "@/lib/ids";
import { logger } from "@/lib/logger";
import { loadSkillRegistry } from "@/lib/skills/load";
import { skillsRoot } from "@/lib/skills/scan";
import type { ToolCtx } from "@/tools/define";
import { loadSkill } from "@/tools/load-skill";
import { readSkillAssetTool } from "@/tools/read-skill-asset";

const created: string[] = [];

async function seedRun() {
  const userId = `test_${uuidv7()}`;
  created.push(userId);

  const chatId = uuidv7();
  const runId = uuidv7();
  const userMessageId = uuidv7();

  await db.user.create({ data: { id: userId, email: `${userId}@test.local` } });
  await db.chat.create({ data: { id: chatId, userId, title: "t" } });
  await db.message.create({ data: { id: userMessageId, chatId, role: "user", content: "hi" } });
  await db.agentRun.create({
    data: { id: runId, chatId, userId, userMessageId, idempotencyKey: uuidv7() },
  });

  return { userId, chatId, runId };
}

/**
 * The real runtime against real Postgres, so the dedup being tested is the unique index rather than
 * a fake that agrees with the test.
 */
function realCtx(a: { userId: string; chatId: string; runId: string }): ToolCtx {
  const runtime = createToolRuntime({
    turn: a,
    publish: () => Promise.resolve(),
    log: logger,
  });

  return {
    ...a,
    invocationId: "inv_unused",
    runNode: () => Promise.reject(new Error("not used")),
    reportCost: () => undefined,
    loadedSkillNames: runtime.loadedSkillNames,
    recordSkillLoad: runtime.recordSkillLoad,
    log: logger,
  };
}

const load = (name: string, ctx: ToolCtx) =>
  loadSkill.execute!(loadSkill.input.parse({ name }) as never, ctx);

beforeEach(() => {
  loadSkillRegistry(skillsRoot());
});

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
});

describe("6. deduplication", () => {
  it("records one row for a skill loaded twice in the same run", async () => {
    const run = await seedRun();
    const ctx = realCtx(run);

    const first = await load("image-editing", ctx);
    const second = await load("image-editing", ctx);

    expect(second.guidance, "the guidance is served both times").toBe(first.guidance);

    const rows = await db.runSkill.findMany({ where: { runId: run.runId } });
    expect(rows, "the unique (runId, skillName, assetPath) is what makes this a dedup").toHaveLength(
      1,
    );
    expect(rows[0]?.assetPath, "the whole document, not a file inside it").toBe("");
  });

  it("keeps a skill and one of its assets as separate rows", async () => {
    const run = await seedRun();
    const ctx = realCtx(run);

    await load("image-editing", ctx);
    await readSkillAssetTool.execute!(
      readSkillAssetTool.input.parse({ name: "image-editing", path: "sizes.md" }) as never,
      ctx,
    );

    const rows = await db.runSkill.findMany({
      where: { runId: run.runId },
      orderBy: { assetPath: "asc" },
    });

    expect(rows.map((row) => row.assetPath)).toEqual(["", "sizes.md"]);
    expect(
      new Set(rows.map((row) => row.skillName)),
      "both belong to the same skill",
    ).toEqual(new Set(["image-editing"]));
  });

  it("counts a repeat as one skill against the budget, not two", async () => {
    const run = await seedRun();
    const ctx = realCtx(run);

    await load("image-editing", ctx);
    await load("image-editing", ctx);

    // Budget is 2 distinct skills; a third would be refused only if the repeat had counted.
    await expect(load("video-production", ctx)).resolves.toMatchObject({
      name: "video-production",
    });
  });

  it("refuses a third distinct skill once the budget is spent", async () => {
    const run = await seedRun();
    const ctx = realCtx(run);

    await load("image-editing", ctx);
    await load("video-production", ctx);

    await expect(load("media-planning", ctx)).rejects.toThrow(/is the limit/);

    const rows = await db.runSkill.findMany({ where: { runId: run.runId } });
    expect(rows, "a refused load records nothing").toHaveLength(2);
  });
});

describe("7. durable resume", () => {
  it("restores the same skills and the same hashes after a resume", async () => {
    const run = await seedRun();
    const ctx = realCtx(run);

    await load("image-editing", ctx);
    await load("video-production", ctx);

    const before = await db.runSkill.findMany({
      where: { runId: run.runId },
      orderBy: { skillName: "asc" },
      select: { skillName: true, assetPath: true, contentHash: true },
    });

    // A resumed attempt is a fresh process: the registry is re-scanned from disk and the run's
    // recorded loads are read back rather than remembered.
    loadSkillRegistry(skillsRoot());
    const resumed = realCtx(run);

    expect(await resumed.loadedSkillNames()).toEqual(
      expect.arrayContaining(["image-editing", "video-production"]),
    );

    // Re-loading on the resumed attempt must land on the same hashes, or the guidance has drifted.
    await load("image-editing", resumed);
    await load("video-production", resumed);

    const after = await db.runSkill.findMany({
      where: { runId: run.runId },
      orderBy: { skillName: "asc" },
      select: { skillName: true, assetPath: true, contentHash: true },
    });

    expect(after, "same guidance, same hashes, no new rows").toEqual(before);
  });

  it("keeps one run's loads out of another's", async () => {
    const first = await seedRun();
    const second = await seedRun();

    await load("image-editing", realCtx(first));

    expect(await realCtx(second).loadedSkillNames()).toEqual([]);
  });
});
