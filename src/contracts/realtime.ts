import { z } from "zod";
import { BlockProjection } from "@/contracts/blocks";
import { InvocationStatus, ToolDisplay } from "@/contracts/messages";

export const STREAM_AGENT_TEXT = "agent-text";

export const RunPhase = z.enum(["thinking", "working", "waiting", "finalizing"]);

/**
 * Re-sent whole on every update, so nothing here may grow unbounded with turn length:
 * `blocks` is a structure-only projection and prose travels on the append-only text
 * stream. Trigger.dev caps payloads at 3 MB.
 *
 * Open fields are `z.json()`, never `z.unknown()`: this object is written through
 * `metadata.set()`, whose parameter type is JSON-serializable, so `unknown` fails to compile
 * at the one call site that matters.
 */
export const RunMetadata = z.object({
  phase: RunPhase,
  phaseStartedAt: z.number(),
  currentStep: z.string().optional(),
  stepsCompleted: z.number(),
  blocks: z.array(BlockProjection).max(60),
  reasoningText: z.string().optional(),
  activePlan: z.json().optional(),
  invocations: z.array(
    z.object({
      id: z.string(),
      toolUseId: z.string(),
      toolName: z.string(),
      display: ToolDisplay,
      state: InvocationStatus,
      durationMs: z.number().optional(),
      credits: z.string().optional(),
      resultUrls: z.array(z.string()).optional(),
    }),
  ),
  assistantMessageId: z.string().optional(),
  waitpoint: z
    .object({ id: z.string(), kind: z.string(), payload: z.json() })
    .optional(),
  servedModel: z.string().optional(),
  tokenUsage: z
    .object({ inputTokens: z.number(), outputTokens: z.number() })
    .optional(),
});
export type RunMetadata = z.infer<typeof RunMetadata>;
export type RunPhase = z.infer<typeof RunPhase>;
