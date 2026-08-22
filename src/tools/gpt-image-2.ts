import { z } from "zod";
import { env } from "@/lib/env";
import { ToolError } from "@/lib/errors";
import { defineTool } from "@/tools/define";
import { estimateMicrocredits } from "@/tools/pricing";

const NODE_TYPE = "gpt_image_2";
const SUB_MODEL_TEXT = "gpt-image-2-text";

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
    size: Size.default("Auto"),
    quality: Quality.default(() => (env.DEMO_MODE ? "High" : "Low")),
    background: z.enum(["Auto", "Opaque"]).default("Auto"),
    n: z.number().int().min(1).max(4).default(1),
    output_format: z.enum(["PNG", "JPEG", "WebP"]).default("PNG"),
  })
  .transform((input) => ({ ...input, quality: clampQuality(input.quality) }));

const Output = z.object({ images: z.array(z.string().url()).min(1) });

/**
 * Collects http urls from anywhere in a node's output. The catalog documents `output` as an
 * arbitrary per-node shape, so it is searched rather than destructured.
 */
function extractImageUrls(output: unknown): string[] {
  const urls: string[] = [];

  const visit = (value: unknown): void => {
    if (typeof value === "string" && /^https?:\/\//.test(value)) urls.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };

  visit(output);
  return urls;
}

/**
 * Text-to-image. Safety rejection is a normal path, not an edge case: the `ToolError` carries
 * Magica's own `userMessage` so the model can rephrase and retry.
 *
 * The node's `gpt-image-2-edit` sub-model takes `uploadedImages`; it ships with uploads as a
 * second variant of this input schema, not a second tool.
 */
export const gptImage2 = defineTool({
  name: NODE_TYPE,
  description:
    "Generate an image from a text prompt. Use for any request to create, draw, illustrate, or " +
    "design a picture. Prefer the default size unless the user asks for specific dimensions.",
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
      subModelId: SUB_MODEL_TEXT,
      input,
    });

    ctx.reportCost(creditUsed);

    const images = extractImageUrls(output);
    if (images.length === 0) {
      throw new ToolError("The image generator returned no image.");
    }

    return { images };
  },
});
