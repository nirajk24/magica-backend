import { describe, expect, it } from "vitest";
import { mergeVideos } from "@/tools/merge-videos";
import { registry } from "@/tools/registry";

const video = (n: number) => `https://cdn.magica.com/fixtures/clip-${n}.mp4`;
const clips = (count: number) => Array.from({ length: count }, (_, i) => video(i));

describe("merge_videos input", () => {
  it("accepts two videos", () => {
    expect(mergeVideos.input.safeParse({ video_urls: clips(2) }).success).toBe(true);
  });

  /** The catalog sets no minimum, so a one-video merge would be dispatched and billed for nothing. */
  it("rejects fewer than two videos", () => {
    expect(mergeVideos.input.safeParse({ video_urls: clips(1) }).success).toBe(false);
    expect(mergeVideos.input.safeParse({ video_urls: [] }).success).toBe(false);
  });

  it("rejects more than a hundred", () => {
    expect(mergeVideos.input.safeParse({ video_urls: clips(100) }).success).toBe(true);
    expect(mergeVideos.input.safeParse({ video_urls: clips(101) }).success).toBe(false);
  });

  it("preserves the order given, because reordering silently rewrites the edit", () => {
    const given = [video(3), video(1), video(2)];
    const parsed = mergeVideos.input.parse({ video_urls: given });

    expect(parsed.video_urls).toEqual(given);
  });

  it("keeps a repeated clip rather than de-duplicating it", () => {
    const given = [video(1), video(1)];

    expect(mergeVideos.input.parse({ video_urls: given }).video_urls).toEqual(given);
  });

  it("defaults the transition to none", () => {
    expect(mergeVideos.input.parse({ video_urls: clips(2) }).transition).toBe("none");
  });

  it("accepts only the transitions the provider offers", () => {
    for (const transition of ["none", "fade", "dissolve"]) {
      expect(mergeVideos.input.safeParse({ video_urls: clips(2), transition }).success).toBe(true);
    }

    expect(
      mergeVideos.input.safeParse({ video_urls: clips(2), transition: "wipe" }).success,
    ).toBe(false);
  });

  it("rejects anything that is not a url", () => {
    expect(mergeVideos.input.safeParse({ video_urls: ["clip-1.mp4", video(2)] }).success).toBe(false);
  });
});

describe("merge_videos cost", () => {
  it("scales the estimate with the number of clips", () => {
    const two = mergeVideos.credits(mergeVideos.input.parse({ video_urls: clips(2) }));
    const four = mergeVideos.credits(mergeVideos.input.parse({ video_urls: clips(4) }));

    expect(two).toBeGreaterThan(0n);
    expect(four, "output length is unknown before the merge, so inputs are the only signal").toBe(
      two * 2n,
    );
  });
});

describe("merge_videos output", () => {
  it("declares its video as an asset", () => {
    const output = mergeVideos.output.parse({ video: video(0) });

    expect(mergeVideos.assets?.(output)).toEqual([{ url: video(0), type: "video" }]);
  });
});

describe("the registry after adding both tools", () => {
  /** Partitioned by tag, not by count: a later phase adding a tool must not fail this. */
  const byTag = (tag: string) =>
    Object.values(registry)
      .filter((tool) => tool.tags?.includes(tag))
      .sort((a, b) => a.name.localeCompare(b.name));

  it("holds all three required Magica tools, keyed by the nodeType the API expects", () => {
    expect(Object.keys(registry)).toEqual(
      expect.arrayContaining(["crop_image", "gpt_image_2", "merge_videos"]),
    );
  });

  it("gives every tool what the model and the card both need", () => {
    for (const [name, tool] of Object.entries(registry)) {
      expect(tool.name, name).toBe(name);
      expect(tool.description.length, name).toBeGreaterThan(20);
      expect(tool.display.label, name).toBeTruthy();
      expect(tool.display.icon, name).toBeTruthy();
      expect(typeof tool.credits, name).toBe("function");
    }
  });

  it("prices every media tool without reaching the network, so a catalog outage cannot break admission", () => {
    // Exercises the committed fallback table: `merge_videos` had no entry and would have thrown.
    const samples: Record<string, unknown> = {
      crop_image: {
        image_url: "https://x.test/a.png",
        x_percent: 0,
        y_percent: 0,
        width_percent: 10,
        height_percent: 10,
      },
      merge_videos: { video_urls: clips(2) },
      gpt_image_2: { prompt: "a mountain" },
    };

    for (const tool of byTag("media")) {
      const input = tool.input.parse(samples[tool.name]) as never;

      expect(tool.credits(input), tool.name).toBeGreaterThan(0n);
    }
  });
});
