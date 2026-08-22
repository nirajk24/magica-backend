import { describe, expect, it } from "vitest";
import { gptImage2 } from "@/tools/gpt-image-2";
import { registry } from "@/tools/registry";
import { assetsFromInvocation } from "@/tools/assets";

const invocation = (output: unknown) => ({
  toolName: "gpt_image_2",
  toolUseId: "call_1",
  creditUsed: 5_880n,
  output,
});

describe("turning a tool's output into assets", () => {
  it("prices and attributes what the tool declared", () => {
    expect(assetsFromInvocation(invocation({ images: ["https://cdn/a.png"] }))).toEqual([
      {
        url: "https://cdn/a.png",
        type: "image",
        model: "gpt_image_2",
        creditUsed: "5880",
        toolCallId: "call_1",
      },
    ]);
  });

  it("carries every file from one invocation", () => {
    const assets = assetsFromInvocation(
      invocation({ images: ["https://cdn/a.png", "https://cdn/b.png"] }),
    );

    expect(assets.map((asset) => asset.url)).toEqual(["https://cdn/a.png", "https://cdn/b.png"]);
    expect(
      assets.every((asset) => asset.creditUsed === "5880"),
      "the message's own creditUsed is the authoritative total, not the sum of these",
    ).toBe(true);
  });

  it("produces nothing for a tool that declares no assets", () => {
    expect(assetsFromInvocation({ ...invocation({ images: ["https://cdn/a.png"] }), toolName: "crop_image" }))
      .toEqual([]);
  });

  it("produces nothing for an unregistered tool rather than throwing", () => {
    expect(assetsFromInvocation({ ...invocation({}), toolName: "not_a_tool" })).toEqual([]);
  });

  it("ignores an output that does not match the tool's own schema", () => {
    expect(assetsFromInvocation(invocation({ wrong: "shape" }))).toEqual([]);
    expect(assetsFromInvocation(invocation(null))).toEqual([]);
  });

  it("keeps the declaration on the tool, so the orchestrator never reads output itself", () => {
    expect(gptImage2.assets).toBeTypeOf("function");
    for (const tool of Object.values(registry)) {
      if (!tool.assets) continue;
      expect(tool.output, `${tool.name} must validate what its assets are read from`).toBeDefined();
    }
  });
});
