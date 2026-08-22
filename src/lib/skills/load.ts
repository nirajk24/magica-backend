import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { MAX_SKILL_BYTES, scanSkills, type Skill } from "@/lib/skills/scan";

let cached: Map<string, Skill> | undefined;

/** Scanned once per process; the bodies are immutable for the life of a deployment. */
export function skills(): Map<string, Skill> {
  cached ??= scanSkills();
  return cached;
}

/** Test seam. Also used at boot to fail fast rather than on the first model request. */
export function loadSkillRegistry(root?: string): Map<string, Skill> {
  cached = scanSkills(root);
  return cached;
}

export function getSkill(name: string): Skill | undefined {
  return skills().get(name);
}

/** Names and descriptions only — the bodies are what the loader tools exist to fetch. */
export function skillIndex(): { name: string; description: string }[] {
  return [...skills().values()].map(({ name, description }) => ({ name, description }));
}

export class SkillAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillAccessError";
  }
}

/**
 * Reads a file from inside one skill's directory.
 *
 * INVARIANT: the containment check appends `path.sep`. Without it a prefix match lets
 * `agent-skills/image-editing-evil` satisfy a check meant for `agent-skills/image-editing`, so a
 * sibling directory becomes readable through a skill that does not own it.
 *
 * INVARIANT: the path is resolved before comparison, so `..` segments are collapsed rather than
 * matched as text. Rejecting on the literal string `..` would still let an encoded or absolute path
 * through.
 */
export function readSkillAsset(skill: Skill, relativePath: string): {
  content: string;
  contentHash: string;
} {
  const root = resolve(skill.dir);
  const target = resolve(root, relativePath);

  if (target !== root && !target.startsWith(root + sep)) {
    throw new SkillAccessError(`"${relativePath}" is outside the "${skill.name}" skill.`);
  }

  let stats;
  try {
    stats = statSync(target);
  } catch {
    throw new SkillAccessError(`"${relativePath}" does not exist in the "${skill.name}" skill.`);
  }

  if (!stats.isFile()) {
    throw new SkillAccessError(`"${relativePath}" is not a file.`);
  }

  if (stats.size > MAX_SKILL_BYTES) {
    throw new SkillAccessError(
      `"${relativePath}" is ${stats.size} bytes, over the ${MAX_SKILL_BYTES} limit.`,
    );
  }

  const content = readFileSync(target, "utf8");

  return { content, contentHash: createHash("sha256").update(content).digest("hex") };
}
