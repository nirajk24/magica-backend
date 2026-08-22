import { z } from "zod";
import { env } from "@/lib/env";
import { ToolError } from "@/lib/errors";
import { getSkill, skillIndex } from "@/lib/skills/load";
import { defineTool } from "@/tools/define";

/** A skill body is guidance, not a file: the whole document counts as the skill's own content. */
const WHOLE_SKILL = "";

const Input = z.object({
  name: z
    .string()
    .max(64)
    .regex(/^[a-z0-9-]+$/, "a skill name holds only lowercase letters, digits and hyphens"),
});

const Output = z.object({ name: z.string(), guidance: z.string() });

const known = () =>
  skillIndex()
    .map((skill) => skill.name)
    .join(", ") || "none";

/**
 * Fetches one skill's guidance.
 *
 * Costs nothing in credits and one model request, because the guidance is only useful on the request
 * after it is returned. That is why the per-turn budget exists rather than trusting the prompt alone.
 */
export const loadSkill = defineTool({
  name: "load_skill",
  description:
    "Read the full guidance for one skill, by name, from the skill list in your instructions. " +
    "Do this only when the current request is the class of work that skill describes. Never load a " +
    "skill you have already loaded in this conversation — its guidance is already above.",
  display: { label: "Skill", icon: "bolt" },
  tags: ["skills"],
  input: Input,
  output: Output,

  credits: () => 0n,

  execute: async (input, ctx) => {
    const skill = getSkill(input.name);

    if (!skill) {
      throw new ToolError(
        `There is no skill called "${input.name}". Available skills: ${known()}.`,
        false,
      );
    }

    const loaded = await ctx.loadedSkillNames();
    const repeat = loaded.includes(skill.name);

    // A repeat is a dedup and never counts, so re-reading costs the model nothing it has not
    // already spent. Only a genuinely new skill can exhaust the budget.
    if (!repeat && loaded.length >= env.MAX_SKILL_LOADS_PER_TURN) {
      throw new ToolError(
        `This turn has already loaded ${loaded.length} skills (${loaded.join(", ")}), which is the ` +
          "limit. Continue with the guidance you have.",
        false,
      );
    }

    await ctx.recordSkillLoad({
      skillName: skill.name,
      assetPath: WHOLE_SKILL,
      contentHash: skill.contentHash,
    });

    ctx.log.info({ skill: skill.name, repeat }, "skill loaded");

    return { name: skill.name, guidance: skill.body };
  },
});
