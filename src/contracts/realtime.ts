import { z } from "zod";
import { BlockProjection } from "@/contracts/blocks";
import { InvocationStatus, ToolDisplay } from "@/contracts/messages";
import { WaitpointKind } from "@/contracts/api";

export const STREAM_AGENT_TEXT = "agent-text";

export const RunPhase = z.enum(["thinking", "working", "waiting", "finalizing"]);

/** Tail window the orchestrator slices `RunMetadata.reasoningText` to. */
export const REASONING_TAIL_CHARS = 4_000;

/**
 * Per-string ceiling on a projected tool input. The snapshot is re-sent on every metadata update, so
 * an unbounded prompt is amplified by the number of updates in a turn. A running card only has to be
 * readable; the completed card reads the full input from `MessageDTO.toolInvocations`.
 */
export const INPUT_VALUE_CHARS = 400;

/**
 * Live view of a run, re-sent in full on every update — so every field must stay bounded.
 * `blocks` carries structure only and `reasoningText` is a tail window; prose travels on the
 * append-only text stream and the complete transcript is persisted as a `thinking` block.
 *
 * Open fields must be `z.json()`, not `z.unknown()` — `metadata.set()` requires
 * JSON-serializable types.
 */
export const RunMetadata = z.object({
  phase: RunPhase,
  phaseStartedAt: z.number(),
  currentStep: z.string().optional(),
  stepsCompleted: z.number(),
  blocks: z.array(BlockProjection).max(60),
  reasoningText: z.string().max(REASONING_TAIL_CHARS).optional(),
  activePlan: z.json().optional(),
  invocations: z.array(
    z.object({
      id: z.string(),
      toolUseId: z.string(),
      toolName: z.string(),
      subModelId: z.string().optional(),
      display: ToolDisplay,
      state: InvocationStatus,
      durationMs: z.number().optional(),
      credits: z.string().optional(),
      /** Truncated for display, so a card can show what a tool was asked to do while it runs. */
      input: z.json().optional(),
      resultUrls: z.array(z.string()).optional(),
    }),
  ),
  assistantMessageId: z.string().optional(),
  waitpoint: z
    .object({ id: z.string(), kind: WaitpointKind, payload: z.json() })
    .optional(),
  servedModel: z.string().optional(),
  tokenUsage: z
    .object({ inputTokens: z.number(), outputTokens: z.number() })
    .optional(),
});
export type RunMetadata = z.infer<typeof RunMetadata>;
export type RunPhase = z.infer<typeof RunPhase>;
