import { beforeEach, describe, expect, it } from "vitest";
import { estimateMicrocredits, hydratePricing, resetPricing } from "@/tools/pricing";
import { registry } from "@/tools/registry";
import { gptImage2 } from "@/tools/gpt-image-2";
import { env } from "@/lib/env";

beforeEach(resetPricing);

describe("pricing", () => {

  it("prices the catalog's default tier when quality and size are absent", () => {
    expect(estimateMicrocredits("gpt_image_2", {})).toBe(210_720n);
  });

  it("prices Low 36x cheaper than High, which is why Low is the dev default", () => {
    const high = estimateMicrocredits("gpt_image_2", { quality: "High", size: "1024x1024" });
    const low = estimateMicrocredits("gpt_image_2", { quality: "Low", size: "1024x1024" });

    expect(high).toBe(210_720n);
    expect(low).toBe(5_880n);
    expect(Number(high) / Number(low)).toBeCloseTo(35.8, 1);
  });

  it("resolves a tier from both key fields, not just the first", () => {
    expect(estimateMicrocredits("gpt_image_2", { quality: "Medium", size: "2048x2048" })).toBe(
      107_040n,
    );
  });

  it("multiplies by the requested image count", () => {
    const one = estimateMicrocredits("gpt_image_2", { quality: "Low" }, 1);
    expect(estimateMicrocredits("gpt_image_2", { quality: "Low" }, 4)).toBe(one * 4n);
  });

  it("falls back to the default tier when a value is not in the map", () => {
    expect(estimateMicrocredits("gpt_image_2", { quality: "Ultra", size: "9x9" })).toBe(210_720n);
  });

  it("prices a flat per_image node", () => {
    expect(estimateMicrocredits("crop_image", {})).toBe(5_000n);
  });

  it("throws for an unpriced node rather than estimating it free", () => {
    expect(() => estimateMicrocredits("does_not_exist", {})).toThrow(/No price for node type/);
  });

  it("rounds up, because the charge happens before the work", () => {
    hydratePricing([{ nodeType: "odd_node", cost: { type: "per_image", value: 0.0000005 } }]);
    expect(estimateMicrocredits("odd_node", {})).toBe(1n);
  });

  it("hydrates from a catalog and ignores entries it cannot parse", () => {
    const applied = hydratePricing([
      { nodeType: "gpt_image_2", cost: { type: "per_image", value: 1 } },
      { nodeType: "junk", cost: { type: "unknown_shape" } },
      { nodeType: "no_cost_field" },
    ]);

    expect(applied).toBe(1);
    expect(estimateMicrocredits("gpt_image_2", {})).toBe(1_000_000n);
    expect(() => estimateMicrocredits("junk", {})).toThrow();
  });
});

describe("registry", () => {

  it("keys every tool by its own name so a rename cannot desync the map", () => {
    for (const [key, tool] of Object.entries(registry)) {
      expect(key).toBe(tool.name);
    }
  });

  it("gives every tool the four things the system derives behaviour from", () => {
    for (const tool of Object.values(registry)) {
      expect(tool.description.length, `${tool.name} needs a description the model can act on`)
        .toBeGreaterThan(20);
      expect(tool.display.label).toBeTruthy();
      expect(tool.input).toBeDefined();
      expect(tool.output).toBeDefined();
      const isInteraction = Boolean(tool.interaction);
      expect(
        isInteraction ? tool.execute === undefined : typeof tool.execute === "function",
        `${tool.name}: an interaction tool must have no execute, a working tool must have one`,
      ).toBe(true);
    }
  });

  it("prices a tool through its own schema defaults", () => {
    const input = gptImage2.input.parse({ prompt: "a mountain" });
    expect(gptImage2.credits(input)).toBeGreaterThan(0n);
  });

  it("defaults quality to the cheap tier outside demo mode", () => {
    const input = gptImage2.input.parse({ prompt: "a mountain" });

    expect(typeof input.quality, "a function default must be CALLED, not stored").toBe("string");
    expect(input.quality).toBe(env.DEMO_MODE ? "High" : "Low");
    expect(gptImage2.credits(input)).toBe(env.DEMO_MODE ? 210_720n : 5_880n);
  });
});
