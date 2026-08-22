import { z } from "zod";

const base = { segment: z.number().int().default(0) };

export const ContentBlock = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("text"), text: z.string() }),
  z.object({
    ...base,
    type: z.literal("thinking"),
    thinking: z.string(),
    durationMs: z.number().optional(),
  }),
  z.object({ ...base, type: z.literal("reasoning"), reasoning: z.string() }),
  z.object({
    ...base,
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    ...base,
    type: z.literal("tool_result"),
    toolUseId: z.string(),
    summary: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal("citations"),
    items: z.array(z.object({ title: z.string(), url: z.string().url() })),
  }),
  z.object({
    ...base,
    type: z.literal("usage"),
    inputTokens: z.number(),
    outputTokens: z.number(),
  }),
  z.object({
    ...base,
    type: z.literal("step_update"),
    stepKey: z.string(),
    status: z.string(),
    note: z.string().optional(),
  }),
]);
export type ContentBlock = z.infer<typeof ContentBlock>;
export type BlockType = ContentBlock["type"];

/**
 * Realtime projection of ContentBlock: structure without prose.
 *
 * `chars` is an exact character count and is written only when a block closes, so a closed
 * block's slice of the text stream never moves. At most one block carries `streaming: true`
 * and it takes the remainder of the stream. Live text offset for block n is the sum of
 * `chars` over all preceding text and thinking blocks.
 */
export const BlockProjection = z.object({
  segment: z.number().int(),
  type: z.string(),
  toolUseId: z.string().optional(),
  name: z.string().optional(),
  chars: z.number().optional(),
  streaming: z.boolean().optional(),
});
export type BlockProjection = z.infer<typeof BlockProjection>;
