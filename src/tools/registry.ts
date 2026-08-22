import type { AgentTool } from "@/tools/define";
import { cropImage } from "@/tools/crop-image";
import { gptImage2 } from "@/tools/gpt-image-2";
import { mergeVideos } from "@/tools/merge-videos";

/**
 * Every tool the agent can call. Adding one is an import and a key.
 *
 * INVARIANT: nothing in the loop, the charging path or the renderers may name a specific tool.
 * If adding a tool requires editing anything outside this file, the seam is in the wrong place.
 */
export const registry = {
  [gptImage2.name]: gptImage2,
  [cropImage.name]: cropImage,
  [mergeVideos.name]: mergeVideos,
} satisfies Record<string, AgentTool>;

export type ToolName = keyof typeof registry;

export function getTool(name: string): AgentTool | undefined {
  return Object.hasOwn(registry, name) ? registry[name] : undefined;
}
