import { metadata, task } from "@trigger.dev/sdk";
import { RunMetadata } from "@/contracts";

/**
 * Spike, not shipped behaviour. Writes worst-case `RunMetadata` snapshots and reports the byte
 * size each one accepted, because the run-metadata size limit is server-enforced and the SDK
 * exposes no constant for it.
 */
function worstCaseMetadata(blockCount: number, reasoningChars: number): RunMetadata {
  return {
    phase: "working",
    phaseStartedAt: 1_756_000_000_000,
    currentStep: "Generating image",
    stepsCompleted: blockCount,
    blocks: Array.from({ length: blockCount }, (_, i) => ({
      segment: Math.floor(i / 3),
      type: i % 3 === 0 ? "text" : i % 3 === 1 ? "thinking" : "tool_use",
      toolUseId: `call_${"c".repeat(24)}${i}`,
      name: "gpt_image_2",
      chars: 4000,
      streaming: i === blockCount - 1,
    })),
    reasoningText: "r".repeat(reasoningChars),
    invocations: Array.from({ length: 12 }, (_, i) => ({
      id: `01999f${"a".repeat(20)}${i}`,
      toolUseId: `call_${"c".repeat(24)}${i}`,
      toolName: "gpt_image_2",
      display: { label: "Generating image", icon: "image" },
      state: "completed" as const,
      durationMs: 12_345,
      credits: "210720",
      resultUrls: [`https://cdn.magica.com/${"u".repeat(80)}/${i}.png`],
    })),
    assistantMessageId: `01999f${"b".repeat(20)}`,
    servedModel: "google/gemma-4-31b-it:free",
    tokenUsage: { inputTokens: 12_345, outputTokens: 6_789 },
  };
}

export const metadataCapSpike = task({
  id: "metadata-cap-spike",
  run: async (payload: { blockCount?: number; reasoningChars?: number }) => {
    const attempts = [
      { blocks: payload.blockCount ?? 60, reasoning: payload.reasoningChars ?? 8_000 },
      { blocks: 40, reasoning: 4_000 },
      { blocks: 20, reasoning: 2_000 },
      { blocks: 12, reasoning: 1_000 },
    ];

    const results: { blocks: number; bytes: number; ok: boolean; error?: string }[] = [];

    for (const attempt of attempts) {
      const snapshot = worstCaseMetadata(attempt.blocks, attempt.reasoning);
      const bytes = JSON.stringify(snapshot).length;

      try {
        metadata.set("run", snapshot);
        await metadata.flush();
        results.push({ blocks: attempt.blocks, bytes, ok: true });
      } catch (e) {
        results.push({
          blocks: attempt.blocks,
          bytes,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return { results, largestAccepted: results.filter((r) => r.ok).at(0) ?? null };
  },
});
