import { z } from "zod";
import { ToolError } from "@/lib/errors";
import { getSkill, readSkillAsset, SkillAccessError } from "@/lib/skills/load";
import { defineTool } from "@/tools/define";

const Input = z.object({
  name: z.string().max(64).regex(/^[a-z0-9-]+$/),
  path: z.string().min(1).max(256),
});

const Output = z.object({ name: z.string(), path: z.string(), content: z.string() });

/**
 * Reads one file from inside a skill's own directory.
 *
 * A rejected path is a `ToolError`, not a thrown exception: an out-of-bounds read is something the
 * model can correct, and the message never echoes a resolved filesystem path back to it.
 */
export const readSkillAssetTool = defineTool({
  name: "read_skill_asset",
  description:
    "Read a supporting file that a skill's guidance refers to, by skill name and the relative path " +
    "the guidance gives. Only for files a loaded skill has actually named.",
  display: { label: "Skill", icon: "bolt" },
  tags: ["skills"],
  input: Input,
  output: Output,

  credits: () => 0n,

  execute: async (input, ctx) => {
    const skill = getSkill(input.name);
    if (!skill) throw new ToolError(`There is no skill called "${input.name}".`, "invalid_input");

    // An asset only makes sense once its guidance has named it, and requiring the load first also
    // closes the budget: reaching a new skill through this tool would otherwise skip the limit.
    const loaded = await ctx.loadedSkillNames();
    if (!loaded.includes(skill.name)) {
      throw new ToolError(`Load the "${skill.name}" skill before reading its files.`, "invalid_input");
    }

    try {
      const { content, contentHash } = readSkillAsset(skill, input.path);

      await ctx.recordSkillLoad({
        skillName: skill.name,
        assetPath: input.path,
        contentHash,
      });

      return { name: skill.name, path: input.path, content };
    } catch (error) {
      if (error instanceof SkillAccessError) throw new ToolError(error.message, "invalid_input");
      throw error;
    }
  },
});
