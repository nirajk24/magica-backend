import { z } from "zod";
import { ToolError } from "@/lib/errors";
import { defineTool } from "@/tools/define";
import { extractUrls } from "@/tools/node-output";
import { estimateMicrocredits } from "@/tools/pricing";

const NODE_TYPE = "crop_image";
const SUB_MODEL = "crop_image";

const PERCENT_FIELDS = ["x_percent", "y_percent", "width_percent", "height_percent"] as const;
const PIXEL_FIELDS = ["x_px", "y_px", "width_px", "height_px"] as const;

/**
 * Every coordinate is optional here and none carries a default, which is deliberate.
 *
 * The catalog defaults the percent fields to a full-frame rectangle. Applying those defaults in Zod
 * would turn a half-specified crop into a complete one before it could be rejected, and the model
 * would silently get back the whole image instead of an error it can correct.
 */
const Coordinates = z.object({
  image_url: z.string().url(),
  x_percent: z.number().min(0).max(100).optional(),
  y_percent: z.number().min(0).max(100).optional(),
  width_percent: z.number().gt(0).max(100).optional(),
  height_percent: z.number().gt(0).max(100).optional(),
  x_px: z.number().int().min(0).optional(),
  y_px: z.number().int().min(0).optional(),
  width_px: z.number().int().min(1).optional(),
  height_px: z.number().int().min(1).optional(),
});

const present = (input: Record<string, unknown>, fields: readonly string[]) =>
  fields.filter((field) => input[field] !== undefined);

/**
 * The complete-rectangle rule is entirely ours: the catalog marks no coordinate field required, so
 * the API would accept a half-specified crop and quietly fall back to its own defaults.
 */
const Input = Coordinates.superRefine((input, ctx) => {
  const percent = present(input, PERCENT_FIELDS);
  const pixel = present(input, PIXEL_FIELDS);

  if (percent.length > 0 && pixel.length > 0) {
    ctx.addIssue({
      code: "custom",
      message:
        "Use either percentages or pixels for the crop, not both. " +
        `Given: ${[...percent, ...pixel].join(", ")}.`,
    });
    return;
  }

  if (percent.length === 0 && pixel.length === 0) {
    ctx.addIssue({
      code: "custom",
      message:
        "A crop needs a rectangle: either x_percent, y_percent, width_percent and height_percent, " +
        "or x_px, y_px, width_px and height_px.",
    });
    return;
  }

  const [chosen, all] =
    percent.length > 0
      ? [percent, PERCENT_FIELDS as readonly string[]]
      : [pixel, PIXEL_FIELDS as readonly string[]];

  if (chosen.length < all.length) {
    ctx.addIssue({
      code: "custom",
      message: `An incomplete crop rectangle. Missing: ${all
        .filter((field) => !chosen.includes(field))
        .join(", ")}.`,
    });
    return;
  }

  // Only checkable in percentages: the image's pixel dimensions are not known until it is fetched.
  if (percent.length > 0) {
    const x = input.x_percent ?? 0;
    const y = input.y_percent ?? 0;
    const width = input.width_percent ?? 0;
    const height = input.height_percent ?? 0;

    if (x + width > 100 || y + height > 100) {
      ctx.addIssue({
        code: "custom",
        message:
          "The crop rectangle runs past the edge of the image: " +
          `x_percent + width_percent is ${x + width} and y_percent + height_percent is ${y + height}, ` +
          "and neither may exceed 100.",
      });
    }
  }
});

const Output = z.object({ images: z.array(z.string().url()).min(1) });

/**
 * Crops an image to a rectangle, in percentages or pixels.
 *
 * Validation is the interesting part: a rectangle must be complete and in one unit, because the
 * provider accepts partial input and substitutes a full-frame default rather than complaining.
 */
export const cropImage = defineTool({
  name: NODE_TYPE,
  description:
    "Crop an image to a rectangle. Give either percentages (x_percent, y_percent, width_percent, " +
    "height_percent) or pixels (x_px, y_px, width_px, height_px) — all four of whichever you " +
    "choose, and never a mix of the two. Percentages are measured from the top-left corner.",
  display: { label: "Cropping image", icon: "crop" },
  tags: ["media", "image"],
  input: Input,
  output: Output,

  credits: () => estimateMicrocredits(NODE_TYPE, {}),

  assets: (output) => output.images.map((url) => ({ url, type: "image" as const })),

  execute: async (input, ctx) => {
    const { output, creditUsed } = await ctx.runNode({
      nodeType: NODE_TYPE,
      subModelId: SUB_MODEL,
      input,
    });

    ctx.reportCost(creditUsed);

    const images = extractUrls(output);
    if (images.length === 0) throw new ToolError("The cropper returned no image.");

    return { images };
  },
});
