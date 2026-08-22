import { z } from "zod";
import { ToolError } from "@/lib/errors";
import { defineTool } from "@/tools/define";
import { extractUrls } from "@/tools/node-output";
import { estimateMicrocredits } from "@/tools/pricing";

const NODE_TYPE = "merge_videos";
const SUB_MODEL = "merge_videos";

const MIN_VIDEOS = 2;
const MAX_VIDEOS = 100;

/**
 * The bounds are ours: the catalog sets no minimum or maximum on `video_urls`, so a one-video merge
 * would be dispatched and billed for doing nothing.
 *
 * INVARIANT: the array is passed through in the order given. Sorting or de-duplicating it would
 * silently reorder the user's edit.
 */
const Input = z.object({
  video_urls: z.array(z.string().url()).min(MIN_VIDEOS).max(MAX_VIDEOS),
  transition: z.enum(["none", "fade", "dissolve"]).default("none"),
});

const Output = z.object({ video: z.string().url() });

/**
 * Joins videos end to end, in the order given.
 *
 * Priced per minute of output, which is not knowable before the merge runs, so the estimate scales
 * with the number of inputs and is reconciled against what the provider reports.
 */
export const mergeVideos = defineTool({
  name: NODE_TYPE,
  description:
    "Join two or more videos into one, in the order given. Optionally set a transition between " +
    "clips: none, fade, or dissolve.",
  display: { label: "Merging videos", icon: "video" },
  tags: ["media", "video"],
  input: Input,
  output: Output,

  credits: (input) => estimateMicrocredits(NODE_TYPE, {}, input.video_urls.length),

  assets: (output) => [{ url: output.video, type: "video" as const }],

  execute: async (input, ctx) => {
    // Merging is slower than a still image, and the poll ceiling is per-call for this reason.
    const { output, creditUsed } = await ctx.runNode({
      nodeType: NODE_TYPE,
      subModelId: SUB_MODEL,
      input,
      timeoutMs: 600_000,
    });

    ctx.reportCost(creditUsed);

    const [video] = extractUrls(output);
    if (!video) throw new ToolError("The merger returned no video.");

    return { video };
  },
});
