import { describe, expect, it } from "vitest";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { NodeRunRequest, ToolCtx } from "@/tools/define";
import { gptImage2 } from "@/tools/gpt-image-2";

const IMAGE = "https://x.test/generated.png";
const SOURCE = "https://x.test/source.png";

/** A ToolCtx whose runNode records the request and answers with one image. */
function fakeCtx() {
  const requests: NodeRunRequest[] = [];

  const ctx: ToolCtx = {
    userId: "u1",
    chatId: "c1",
    runId: "r1",
    invocationId: "i1",
    runNode: (request) => {
      requests.push(request);
      return Promise.resolve({ output: { image_url: [IMAGE] }, creditUsed: 5880n });
    },
    reportCost: () => undefined,
    loadedSkillNames: () => Promise.resolve([]),
    recordSkillLoad: () => Promise.resolve(),
    log: logger,
  };

  return { ctx, requests };
}

describe("gpt_image_2 sub-model selection", () => {
  it("runs text-to-image when no source images are given", async () => {
    const { ctx, requests } = fakeCtx();
    const input = gptImage2.input.parse({ prompt: "a mountain at sunrise" });

    await gptImage2.execute!(input, ctx);

    expect(requests[0]?.subModelId).toBe("gpt-image-2-text");
    expect(requests[0]?.input).not.toHaveProperty("uploadedImages");
  });

  it("runs edit mode when source images are given — derived, never asked for", async () => {
    const { ctx, requests } = fakeCtx();
    const input = gptImage2.input.parse({
      prompt: "make it dark mode",
      uploadedImages: [SOURCE],
    });

    await gptImage2.execute!(input, ctx);

    expect(requests[0]?.subModelId).toBe("gpt-image-2-edit");
    expect(requests[0]?.input).toMatchObject({ uploadedImages: [SOURCE] });
  });

  it("rejects an empty image list, which would be text mode wearing the wrong field", () => {
    expect(() =>
      gptImage2.input.parse({ prompt: "make it dark mode", uploadedImages: [] }),
    ).toThrow();
  });

  it("caps the sources at the catalog's ten and requires real URLs", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `https://x.test/${i}.png`);

    expect(() => gptImage2.input.parse({ prompt: "p", uploadedImages: eleven })).toThrow();
    expect(() => gptImage2.input.parse({ prompt: "p", uploadedImages: ["not a url"] })).toThrow();
  });

  it("prices an edit exactly like a generation — the tiers are on quality and size", () => {
    const text = gptImage2.input.parse({ prompt: "p" });
    const edit = gptImage2.input.parse({ prompt: "p", uploadedImages: [SOURCE] });

    expect(gptImage2.credits(edit)).toBe(gptImage2.credits(text));
  });

  it("still clamps quality in edit mode, so the estimate and the request cannot disagree", () => {
    const edit = gptImage2.input.parse({
      prompt: "p",
      uploadedImages: [SOURCE],
      quality: "High",
    });

    expect(edit.quality).toBe(env.DEMO_MODE ? "High" : "Low");
  });
});
