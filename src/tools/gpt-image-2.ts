import { z } from "zod";
import { env } from "@/lib/env";
import { ToolError } from "@/lib/errors";
import { defineTool } from "@/tools/define";
import { extractUrls } from "@/tools/node-output";
import { estimateMicrocredits } from "@/tools/pricing";

const NODE_TYPE = "gpt_image_2";
const SUB_MODEL_TEXT = "gpt-image-2-text";
const SUB_MODEL_EDIT = "gpt-image-2-edit";

const Size = z.enum([
  "Auto",
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
]);

const Quality = z.enum(["High", "Medium", "Low"]);

/**
 * Quality is clamped to Low outside demo mode, not merely defaulted to it. The tiers span 36x, and a
 * default is only a default — the model asks for Medium unprompted, which costs 9x Low. Clamping at
 * parse time means the estimate and the request cannot disagree.
 */
const clampQuality = (quality: z.infer<typeof Quality>) =>
  env.DEMO_MODE ? quality : ("Low" as const);

const Input = z
  .object({
    prompt: z.string().min(1).max(4000),
    /**
     * Present means edit the given images rather than invent one, which is the whole difference
     * between the node's two sub-models. The field name and its plurality come from the catalog;
     * the edit sub-model does not take `image_url`.
     */
    uploadedImages: z.array(z.string().url()).min(1).max(10).optional(),
    size: Size.default("Auto"),
    quality: Quality.default(() => (env.DEMO_MODE ? "High" : "Low")),
    background: z.enum(["Auto", "Opaque"]).default("Auto"),
    n: z.number().int().min(1).max(4).default(1),
    output_format: z.enum(["PNG", "JPEG", "WebP"]).default("PNG"),
  })
  .transform((input) => ({ ...input, quality: clampQuality(input.quality) }));

const Output = z.object({ images: z.array(z.string().url()).min(1) });

/**
 * Text-to-image, and image-to-image when the caller supplies source images.
 *
 * INVARIANT: the sub-model is derived from the input, never asked for. `uploadedImages` is the only
 * field that differs between the node's two sub-models, so a caller that supplies it has already
 * said which one it wants, and the two can never disagree.
 *
 * Safety rejection is a normal path, not an edge case: the `ToolError` carries Magica's own
 * `userMessage` so the model can rephrase and retry.
 */
export const gptImage2 = defineTool({
  name: NODE_TYPE,
  description:
    "Generate an image from a text prompt, or edit existing images. Use for any request to " +
    "create, draw, illustrate or design a picture. To change a picture that already exists — " +
    "restyle it, add or remove something, recolour it — pass its URL in `uploadedImages` and " +
    "describe the change in the prompt; the URL must come from an earlier tool result. Prefer " +
    "the default size unless the user asks for specific dimensions.",
  display: { label: "Generating image", icon: "image" },
  tags: ["media", "image"],
  input: Input,
  output: Output,

  credits: (input) =>
    estimateMicrocredits(NODE_TYPE, { quality: input.quality, size: input.size }, input.n),

  assets: (output) => output.images.map((url) => ({ url, type: "image" as const })),

  execute: async (input, ctx) => {
    const { output, creditUsed } = await ctx.runNode({
      nodeType: NODE_TYPE,
      subModelId: input.uploadedImages ? SUB_MODEL_EDIT : SUB_MODEL_TEXT,
      input,
      timeoutMs: input.quality === "High" ? 300_000 : 120_000,
    });

    ctx.reportCost(creditUsed);

    const images = extractUrls(output);
    if (images.length === 0) {
      throw new ToolError("The image generator returned no image.");
    }

    return { images };
  },
});
