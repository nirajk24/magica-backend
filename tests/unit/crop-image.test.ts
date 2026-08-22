import { describe, expect, it } from "vitest";
import { cropImage } from "@/tools/crop-image";

const IMAGE = "https://cdn.magica.com/fixtures/photo.png";

const parse = (input: Record<string, unknown>) =>
  cropImage.input.safeParse({ image_url: IMAGE, ...input });

const errorFrom = (input: Record<string, unknown>) => {
  const result = parse(input);
  expect(result.success, `expected ${JSON.stringify(input)} to be rejected`).toBe(false);
  return result.error!.issues.map((issue) => issue.message).join(" | ");
};

const PERCENT_RECT = { x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 50 };
const PIXEL_RECT = { x_px: 10, y_px: 20, width_px: 300, height_px: 400 };

describe("crop_image input", () => {
  it("accepts a complete percent rectangle", () => {
    expect(parse(PERCENT_RECT).success).toBe(true);
  });

  it("accepts a complete pixel rectangle", () => {
    expect(parse(PIXEL_RECT).success).toBe(true);
  });

  /**
   * The one that matters: the catalog defaults the percent fields to a full frame, so applying those
   * defaults in Zod would turn a coordinate-less call into a valid full-image crop. The model would
   * get the whole picture back and no error to correct.
   */
  it("rejects a call with no rectangle rather than cropping the whole image", () => {
    expect(errorFrom({})).toMatch(/a crop needs a rectangle/i);
  });

  it("rejects a partial percent rectangle and names what is missing", () => {
    const message = errorFrom({ x_percent: 0, width_percent: 50 });

    expect(message).toMatch(/incomplete/i);
    expect(message).toContain("y_percent");
    expect(message).toContain("height_percent");
  });

  it("rejects a partial pixel rectangle and names what is missing", () => {
    const message = errorFrom({ width_px: 300, height_px: 400 });

    expect(message).toMatch(/incomplete/i);
    expect(message).toContain("x_px");
    expect(message).toContain("y_px");
  });

  it("rejects mixed units, even when each set would be complete on its own", () => {
    const message = errorFrom({ ...PERCENT_RECT, ...PIXEL_RECT });

    expect(message).toMatch(/not both/i);
    expect(message, "the model needs to know which fields to drop").toContain("x_percent");
    expect(message).toContain("x_px");
  });

  it("rejects a single stray field of the other unit", () => {
    expect(errorFrom({ ...PERCENT_RECT, x_px: 5 })).toMatch(/not both/i);
  });

  it("rejects a rectangle that runs past the edge of the image", () => {
    const message = errorFrom({ x_percent: 60, y_percent: 0, width_percent: 50, height_percent: 10 });

    expect(message).toMatch(/past the edge/i);
    expect(message, "the arithmetic is in the message so the model can correct it").toContain("110");
  });

  it("allows a rectangle that ends exactly at the edge", () => {
    expect(
      parse({ x_percent: 50, y_percent: 50, width_percent: 50, height_percent: 50 }).success,
    ).toBe(true);
  });

  it("rejects a zero-sized crop", () => {
    expect(parse({ x_percent: 0, y_percent: 0, width_percent: 0, height_percent: 50 }).success).toBe(
      false,
    );
    expect(parse({ ...PIXEL_RECT, width_px: 0 }).success).toBe(false);
  });

  it("does not bounds-check pixels, because the image's dimensions are not known yet", () => {
    expect(parse({ x_px: 0, y_px: 0, width_px: 99_999, height_px: 99_999 }).success).toBe(true);
  });

  it("requires an image to crop", () => {
    expect(cropImage.input.safeParse(PERCENT_RECT).success).toBe(false);
    expect(cropImage.input.safeParse({ image_url: "not-a-url", ...PERCENT_RECT }).success).toBe(
      false,
    );
  });

  it("sends only the unit it was given, so the provider applies no defaults of its own", () => {
    const parsed = cropImage.input.parse({ image_url: IMAGE, ...PERCENT_RECT }) as Record<
      string,
      unknown
    >;

    expect(Object.keys(parsed).sort()).toEqual(
      ["height_percent", "image_url", "width_percent", "x_percent", "y_percent"].sort(),
    );
  });
});

describe("crop_image output", () => {
  it("declares its image as an asset", () => {
    const output = cropImage.output.parse({ images: [IMAGE] });

    expect(cropImage.assets?.(output)).toEqual([{ url: IMAGE, type: "image" }]);
  });

  it("rejects an empty result rather than reporting success with no image", () => {
    expect(cropImage.output.safeParse({ images: [] }).success).toBe(false);
  });
});
