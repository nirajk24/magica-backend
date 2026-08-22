import type { LlmStatus } from "@/contracts";
import { defineRoute, preflight } from "@/lib/api";
import { readLlmStatus } from "@/lib/llm-status";

/**
 * Whether the shared free-tier LLM path is currently rate limited, so the composer can say when to
 * come back rather than letting the user send into a turn that will fail.
 */
export const GET = defineRoute({
  handler: (): Promise<LlmStatus> => readLlmStatus(),
});

export const OPTIONS = preflight;
