import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkillRegistry, readSkillAsset, SkillAccessError, skillIndex } from "@/lib/skills/load";
import { findSkillsDir, scanSkills, SkillScanError, skillsRoot } from "@/lib/skills/scan";
import { buildSystemPrompt } from "@/prompts/system";
import { registry } from "@/tools/registry";

const fixture = (name: string) => resolve(import.meta.dirname, "..", "fixtures", name);

/** The three shipped skills, scanned from the real directory rather than a fixture. */
const shipped = () => scanSkills(skillsRoot());

/**
 * The layout a deployed bundle actually has, taken from `trigger.dev deploy --dry-run`:
 * `additionalFiles` puts `agent-skills/` at the bundle root, while the compiled task — which the
 * scanner is inlined into — lands at `src/trigger/`. Two directories apart, and neither depth is a
 * constant a bundler promises to keep.
 */
describe("finding the skills directory", () => {
  const bundle = () => {
    const root = mkdtempSync(join(tmpdir(), "magica-bundle-"));
    mkdirSync(join(root, "agent-skills", "some-skill"), { recursive: true });
    mkdirSync(join(root, "src", "trigger"), { recursive: true });
    return root;
  };

  it("finds a skills directory two levels above the compiled task", () => {
    const root = bundle();

    expect(findSkillsDir(join(root, "src", "trigger"))).toBe(join(root, "agent-skills"));
  });

  it("finds one sitting right beside the caller", () => {
    const root = bundle();

    expect(findSkillsDir(root)).toBe(join(root, "agent-skills"));
  });

  it("throws rather than returning nothing when the bundle forgot to ship them", () => {
    const empty = mkdtempSync(join(tmpdir(), "magica-nobundle-"));

    expect(
      () => findSkillsDir(empty),
      "an empty registry is the silent failure this search exists to prevent",
    ).toThrow(/could not find a "agent-skills" directory/);
  });

  it("locates the real directory from this module", () => {
    expect(skillsRoot().endsWith("agent-skills")).toBe(true);
  });
});

describe("the skill loaders in the registry", () => {
  const skillTools = () =>
    Object.values(registry)
      .filter((tool) => tool.tags?.includes("skills"))
      .sort((a, b) => a.name.localeCompare(b.name));

  it("registers both loaders the scope authority names", () => {
    expect(skillTools().map((tool) => tool.name)).toEqual(["load_skill", "read_skill_asset"]);
  });

  it("charges nothing for guidance, only for work", () => {
    for (const tool of skillTools()) {
      expect(tool.credits(undefined as never), tool.name).toBe(0n);
    }
  });

  it("renders as the reference does — a bolt and the word Skill", () => {
    for (const tool of skillTools()) {
      expect(tool.display, tool.name).toEqual({ label: "Skill", icon: "bolt" });
    }
  });
});

describe("the shipped skills", () => {
  it("scans cleanly and ships at least the three the scope requires", () => {
    const skills = shipped();

    expect(skills.size).toBeGreaterThanOrEqual(3);
    expect([...skills.keys()]).toEqual(
      expect.arrayContaining(["image-editing", "video-production", "media-planning"]),
    );
  });

  it("does not ship a capabilities skill, which belongs in the base prompt", () => {
    expect(
      shipped().has("capabilities"),
      "a capability question arrives on the cheapest kind of turn and must not cost a request",
    ).toBe(false);
  });

  it("gives every skill a description a model can choose from", () => {
    for (const [name, skill] of shipped()) {
      expect(skill.name, name).toBe(name);
      expect(skill.description.length, name).toBeGreaterThan(40);
      expect(skill.body.length, name).toBeGreaterThan(100);
      expect(skill.contentHash, name).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  /**
   * The description is the only thing the model sees before choosing, so it has to name the trigger
   * rather than merely describe the subject. A purely descriptive line reads as optional reading.
   */
  it("names when to load it, not just what it is about", () => {
    for (const [name, skill] of shipped()) {
      expect(skill.description, name).toMatch(/\bload\b/i);
    }
  });
});

describe("the base prompt carries the index and nothing more", () => {
  it("lists every skill's name and description", () => {
    const prompt = buildSystemPrompt({
      index: [{ name: "image-editing", description: "How to size and crop images." }],
    });

    expect(prompt).toContain("image-editing");
    expect(prompt).toContain("How to size and crop images.");
  });

  /** L1 is names and descriptions. A body here would defeat the design and re-send on every request. */
  it("never contains a skill body", () => {
    loadSkillRegistry(skillsRoot());
    const prompt = buildSystemPrompt({ index: skillIndex() });

    for (const skill of shipped().values()) {
      expect(prompt, `${skill.name}'s body must be fetched, not inlined`).not.toContain(skill.body);
    }
  });

  /**
   * The wording here is load-bearing and was got wrong once. Saying "most turns need no skill at
   * all" and "do not load one to answer something you can already answer" made a capable model
   * decline on a turn squarely inside a skill's stated territory — it concluded it could already
   * answer. The rules are positive now, and the exclusions are a closed list.
   */
  it("tells the model to load when a request is a skill's class of work", () => {
    const prompt = buildSystemPrompt({ index: [{ name: "x", description: "y" }] });

    expect(prompt, "guidance has to outrank the model's own defaults or it gets skipped").toMatch(
      /authoritative/i,
    );
    expect(prompt).toMatch(/before\s+you\s+act/i);
  });

  it("keeps the exclusions a closed list, not an open invitation to skip", () => {
    const prompt = buildSystemPrompt({ index: [{ name: "x", description: "y" }] });

    expect(prompt).toMatch(/greetings, small talk, and questions about what you can do/i);
    expect(prompt, "an open-ended excuse is what suppressed loading entirely").not.toMatch(
      /already answer/i,
    );
    expect(prompt).not.toMatch(/most turns need no skill/i);
  });

  it("still forbids reloading, which costs a request for guidance already in hand", () => {
    expect(buildSystemPrompt({ index: [{ name: "x", description: "y" }] })).toMatch(
      /never load the same skill twice/i,
    );
  });

  it("keeps capability questions answerable without a load", () => {
    expect(buildSystemPrompt({ index: [] })).toMatch(/do not load a skill to find out/i);
  });

  it("omits the skill section entirely when there are no skills", () => {
    expect(buildSystemPrompt({ index: [] })).not.toMatch(/skills available to you/i);
  });
});

// ─── The seven tests the scope authority names ────────────────────────────────

describe("1. selective loading", () => {
  it("exposes only names and descriptions, so a turn that needs no skill loads nothing", () => {
    loadSkillRegistry(fixture("skills-good"));
    const index = skillIndex();

    expect(index).toEqual([
      {
        name: "good-skill",
        description: "A skill that scans cleanly, used as the control in these tests.",
      },
    ]);
    expect(
      Object.keys(index[0]!),
      "a body reachable from the index would be loaded whether needed or not",
    ).toEqual(["name", "description"]);
  });
});

describe("2. malformed frontmatter", () => {
  it("is rejected, and the error names the offending directory", () => {
    expect(() => scanSkills(fixture("skills-malformed"))).toThrow(SkillScanError);
    expect(() => scanSkills(fixture("skills-malformed"))).toThrow(/broken-skill/);
  });

  it("rejects a file over the byte cap rather than pulling it into a prompt", () => {
    expect(() => scanSkills(fixture("skills-oversized"))).toThrow(/over the 65536 limit/);
  });
});

describe("3. duplicate skill names", () => {
  /**
   * Duplicates are made unrepresentable rather than detected after the fact: a skill's `name` must
   * equal its directory, and directory names are unique. So two folders claiming one name fails on
   * the mismatch, which is the check that actually protects the registry.
   */
  it("refuses two directories that both claim the same name", () => {
    expect(() => scanSkills(fixture("skills-duplicate"))).toThrow(SkillScanError);
    expect(() => scanSkills(fixture("skills-duplicate"))).toThrow(/declares the name "shared-name"/);
  });
});

describe("5. path traversal", () => {
  const skill = () => {
    loadSkillRegistry(fixture("skills-good"));
    return scanSkills(fixture("skills-good")).get("good-skill")!;
  };

  it("reads a file the skill owns", () => {
    expect(readSkillAsset(skill(), "notes.md").content).toContain("reference material");
  });

  it("refuses to climb out of the skill directory", () => {
    for (const path of [
      "../../etc/passwd",
      "../broken-skill/SKILL.md",
      "./../../package.json",
      "/etc/passwd",
    ]) {
      expect(() => readSkillAsset(skill(), path), path).toThrow(SkillAccessError);
    }
  });

  /**
   * The `+ path.sep` in the containment check. Without it a plain `startsWith` lets a sibling whose
   * name merely begins with the skill's name satisfy a check meant for the skill itself.
   */
  it("refuses a sibling directory that shares the skill's name as a prefix", () => {
    const evil = { ...skill(), dir: `${skill().dir}` };

    expect(() => readSkillAsset(evil, "../good-skill-evil/SKILL.md")).toThrow(SkillAccessError);
  });

  it("refuses a directory, and a file that does not exist", () => {
    expect(() => readSkillAsset(skill(), ".")).toThrow(/not a file/);
    expect(() => readSkillAsset(skill(), "absent.md")).toThrow(/does not exist/);
  });

  /** The reader returns `utf8`, so without the allowlist a binary file succeeds and yields mojibake. */
  it("refuses a format it cannot return as text, even when the file is there", () => {
    expect(() => readSkillAsset(skill(), "logo.png")).toThrow(/not a readable format/);
  });

  it("matches the extension case-insensitively", () => {
    expect(readSkillAsset(skill(), "guide.MD").content).toContain("still markdown");
  });
});
