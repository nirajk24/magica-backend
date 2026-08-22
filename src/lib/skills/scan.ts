import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import matter from "gray-matter";
import { z } from "zod";

/** Must equal the directory name, so a skill cannot advertise itself as something it is not. */
const SkillMeta = z.object({
  name: z
    .string()
    .max(64)
    .regex(/^[a-z0-9-]+$/, "a skill name may hold only lowercase letters, digits and hyphens"),
  description: z.string().min(1).max(1024),
});

type SkillMeta = z.infer<typeof SkillMeta>;

export type Skill = SkillMeta & {
  /** Absolute, and the root every asset read is contained within. */
  dir: string;
  body: string;
  contentHash: string;
};

/** Bounded so a large file in the skills directory cannot be pulled into a prompt. */
export const MAX_SKILL_BYTES = 64 * 1024;

const SKILL_FILE = "SKILL.md";

const SKILLS_DIR = "agent-skills";

/** Bounded so a missing directory ends the search rather than walking to the filesystem root. */
const MAX_HOPS = 8;

/**
 * Finds `agent-skills/` by walking up from this module, never from `cwd`.
 *
 * A fixed number of `..` hops would be wrong: this file sits at `src/lib/skills/` in the repo but a
 * bundler flattens compiled chunks into one directory, so its depth below the package root is not a
 * constant. A `cwd`-relative path is worse again — a task runs from a bundle directory, so it yields
 * an empty registry in production while working perfectly in local dev, and the model is simply
 * never told the skills exist.
 *
 * INVARIANT: throws when the directory is absent. An empty registry is the silent failure this whole
 * function exists to avoid, so it must never be the fallback.
 */
export function findSkillsDir(startDir: string): string {
  let dir = startDir;

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const candidate = join(dir, SKILLS_DIR);

    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Not at this level; keep climbing.
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    `could not find a "${SKILLS_DIR}" directory above ${startDir}. ` +
      "A deployed bundle must ship it explicitly — nothing imports those files, so a bundler " +
      "cannot see them.",
  );
}

export function skillsRoot(): string {
  return findSkillsDir(import.meta.dirname);
}

const sha256 = (raw: string) => createHash("sha256").update(raw).digest("hex");

/** Thrown at startup so a broken skill is a boot failure that names it, not a silent omission. */
export class SkillScanError extends Error {
  constructor(directory: string, reason: string) {
    super(`skill "${directory}": ${reason}`);
    this.name = "SkillScanError";
  }
}

function readSkill(root: string, directory: string): Skill {
  const dir = join(root, directory);
  const file = join(dir, SKILL_FILE);

  let stats;
  try {
    stats = statSync(file);
  } catch {
    throw new SkillScanError(directory, `has no ${SKILL_FILE}`);
  }

  if (stats.size > MAX_SKILL_BYTES) {
    throw new SkillScanError(
      directory,
      `${SKILL_FILE} is ${stats.size} bytes, over the ${MAX_SKILL_BYTES} limit`,
    );
  }

  const raw = readFileSync(file, "utf8");

  let parsed;
  try {
    parsed = matter(raw);
  } catch {
    throw new SkillScanError(directory, "frontmatter is not valid YAML");
  }

  const meta = SkillMeta.safeParse(parsed.data);
  if (!meta.success) {
    throw new SkillScanError(
      directory,
      `invalid frontmatter — ${meta.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ")}`,
    );
  }

  if (meta.data.name !== directory) {
    throw new SkillScanError(directory, `declares the name "${meta.data.name}"`);
  }

  if (parsed.content.trim() === "") {
    throw new SkillScanError(directory, "has no guidance below the frontmatter");
  }

  return {
    ...meta.data,
    dir,
    body: parsed.content.trim(),
    contentHash: sha256(raw),
  };
}

/**
 * Every valid skill under `root`, keyed by name.
 *
 * INVARIANT: throws rather than skipping. A malformed or duplicated skill is a deployment mistake,
 * and a registry that quietly drops one produces an agent that has silently forgotten how to do
 * something — far harder to notice than a failed boot.
 */
export function scanSkills(root = skillsRoot()): Map<string, Skill> {
  let entries: string[];

  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return new Map();
  }

  const skills = new Map<string, Skill>();

  for (const directory of entries) {
    const skill = readSkill(root, directory);

    // Unreachable while the name must equal its unique directory, and asserted anyway: the check is
    // named in the scope authority, and a future relaxation of that rule would silently remove it.
    if (skills.has(skill.name)) {
      throw new SkillScanError(directory, `duplicate skill name "${skill.name}"`);
    }

    skills.set(skill.name, skill);
  }

  return skills;
}
