import { afterEach, describe, expect, it } from "vitest";
import {
  hydrateFieldSpecs,
  resetFieldSpecs,
  validateNodeInput,
} from "@/tools/catalog-schema";
import { ToolError } from "@/lib/errors";

/** Mirrors the live catalog's shapes: map key ≠ nodeType, number option values, per-sub-model fields. */
const CATALOG = [
  {
    nodeType: "gpt_image_2",
    subModels: [
      {
        subModelId: "gpt-image-2-text",
        inputFieldOptions: [
          { zodExpectedName: "prompt", dataType: "string", required: true, max: 4000 },
          {
            zodExpectedName: "size",
            dataType: "string",
            options: [{ value: "Custom" }, { value: "Auto" }, { value: "1024x1024" }],
          },
          {
            zodExpectedName: "quality",
            dataType: "string",
            options: [{ value: "High" }, { value: "Medium" }, { value: "Low" }],
          },
          {
            zodExpectedName: "n",
            dataType: "number",
            options: [{ value: 1 }, { value: 2 }, { value: 3 }, { value: 4 }],
          },
          { zodExpectedName: "output_compression", dataType: "number", min: 0, max: 100 },
        ],
      },
      {
        subModelId: "gpt-image-2-edit",
        inputFieldOptions: [
          { zodExpectedName: "prompt", dataType: "string", required: true, max: 4000 },
          {
            zodExpectedName: "uploadedImages",
            dataType: "string[]",
            required: true,
            maxImages: 10,
          },
        ],
      },
    ],
  },
  {
    nodeType: "merge_videos",
    subModels: [
      {
        subModelId: "merge_videos",
        inputFieldOptions: [
          { zodExpectedName: "video_urls", dataType: "string[]", required: true, maxItems: 100 },
          {
            zodExpectedName: "transition",
            dataType: "string",
            options: [{ value: "none" }, { value: "fade" }, { value: "dissolve" }],
          },
        ],
      },
    ],
  },
];

const seed = () => hydrateFieldSpecs(CATALOG);

afterEach(() => resetFieldSpecs());

describe("hydrateFieldSpecs", () => {
  it("stores one spec set per sub-model", () => {
    expect(seed()).toBe(3);
  });

  it("skips a malformed field without discarding the sub-model around it", () => {
    const applied = hydrateFieldSpecs([
      {
        nodeType: "gpt_image_2",
        subModels: [
          {
            subModelId: "gpt-image-2-text",
            inputFieldOptions: [
              { nonsense: true },
              { zodExpectedName: "prompt", required: true },
            ],
          },
        ],
      },
    ]);

    expect(applied).toBe(1);
    expect(() =>
      validateNodeInput({ nodeType: "gpt_image_2", subModelId: "gpt-image-2-text", input: {} }),
    ).toThrow(/prompt is required/);
  });

  it("survives a payload with no subModels at all", () => {
    expect(hydrateFieldSpecs([{ nodeType: "crop_image" }])).toBe(0);
  });
});

describe("validateNodeInput", () => {
  it("passes a request the provider's schema accepts", () => {
    seed();

    expect(() =>
      validateNodeInput({
        nodeType: "gpt_image_2",
        subModelId: "gpt-image-2-text",
        input: { prompt: "a mountain", size: "Auto", quality: "Low", n: 1 },
      }),
    ).not.toThrow();
  });

  it("does nothing before the catalog has loaded, because Zod is still the transport guard", () => {
    expect(() =>
      validateNodeInput({
        nodeType: "gpt_image_2",
        subModelId: "gpt-image-2-text",
        input: { anything: "at all" },
      }),
    ).not.toThrow();
  });

  it("rejects a field the current schema does not have, naming it", () => {
    seed();

    expect(() =>
      validateNodeInput({
        nodeType: "gpt_image_2",
        subModelId: "gpt-image-2-text",
        // The exact trap the requirement warns about: edit mode takes `uploadedImages`, not this.
        input: { prompt: "restyle it", image_url: "https://x.test/a.png" },
      }),
    ).toThrow(/image_url is not a field of gpt-image-2-text/);
  });

  it("rejects a missing required field", () => {
    seed();

    expect(() =>
      validateNodeInput({
        nodeType: "gpt_image_2",
        subModelId: "gpt-image-2-edit",
        input: { prompt: "restyle it" },
      }),
    ).toThrow(/uploadedImages is required/);
  });

  it("rejects a value outside the current option set, listing what is allowed", () => {
    seed();

    expect(() =>
      validateNodeInput({
        nodeType: "merge_videos",
        subModelId: "merge_videos",
        input: { video_urls: ["https://x.test/a.mp4"], transition: "wipe" },
      }),
    ).toThrow(/transition must be one of "none", "fade", "dissolve"/);
  });

  it("matches numeric option values as numbers", () => {
    seed();
    const call = (n: number) => () =>
      validateNodeInput({
        nodeType: "gpt_image_2",
        subModelId: "gpt-image-2-text",
        input: { prompt: "a mountain", n },
      });

    expect(call(4)).not.toThrow();
    expect(call(5)).toThrow(/n must be one of/);
  });

  it("enforces string length, numeric range and array bounds from the catalog", () => {
    seed();

    expect(() =>
      validateNodeInput({
        nodeType: "gpt_image_2",
        subModelId: "gpt-image-2-text",
        input: { prompt: "x".repeat(4001) },
      }),
    ).toThrow(/prompt is longer than 4000/);

    expect(() =>
      validateNodeInput({
        nodeType: "gpt_image_2",
        subModelId: "gpt-image-2-text",
        input: { prompt: "ok", output_compression: 101 },
      }),
    ).toThrow(/output_compression must be at most 100/);

    expect(() =>
      validateNodeInput({
        nodeType: "gpt_image_2",
        subModelId: "gpt-image-2-edit",
        input: {
          prompt: "restyle",
          uploadedImages: Array.from({ length: 11 }, (_, i) => `https://x.test/${i}.png`),
        },
      }),
    ).toThrow(/uploadedImages takes at most 10 items/);
  });

  it("reports several problems in one error, so the model fixes the call once", () => {
    seed();

    try {
      validateNodeInput({
        nodeType: "gpt_image_2",
        subModelId: "gpt-image-2-text",
        input: { quality: "Ultra", bogus: 1 },
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      const message = (error as ToolError).message;
      expect(message).toMatch(/bogus is not a field/);
      expect(message).toMatch(/prompt is required/);
      expect(message).toMatch(/quality must be one of/);
    }
  });

  it("skips an unknown sub-model rather than guessing", () => {
    seed();

    expect(() =>
      validateNodeInput({
        nodeType: "gpt_image_2",
        subModelId: "gpt-image-2-video",
        input: { whatever: true },
      }),
    ).not.toThrow();
  });
});
