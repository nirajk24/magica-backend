import { describe, expect, it } from "vitest";
import { ALLOWED_MODELS } from "@/contracts";
import { describeModel } from "@/lib/models";

describe("describing a model for display", () => {
  it("splits provider from name and drops the tier suffix", () => {
    expect(describeModel("nvidia/nemotron-3-super-120b-a12b:free")).toEqual({
      id: "nvidia/nemotron-3-super-120b-a12b:free",
      name: "nemotron-3-super-120b-a12b",
      provider: "nvidia",
    });
  });

  it("keeps the full id, which is what identifies the model to the provider", () => {
    for (const modelId of ALLOWED_MODELS) {
      expect(describeModel(modelId).id, modelId).toBe(modelId);
      expect(describeModel(modelId).name, modelId).not.toContain(":");
      expect(describeModel(modelId).provider, modelId).not.toBe("");
    }
  });

  it("handles a nested provider path", () => {
    expect(describeModel("openrouter/auto/v2:free")).toMatchObject({
      name: "auto/v2",
      provider: "openrouter",
    });
  });

  /** A malformed id must not be what fails a turn that otherwise succeeded. */
  it("still yields something renderable for an id in an unexpected shape", () => {
    expect(describeModel("bare-model")).toEqual({
      id: "bare-model",
      name: "bare-model",
      provider: "",
    });
    expect(describeModel(":free")).toMatchObject({ name: ":free", provider: "" });
  });
});
