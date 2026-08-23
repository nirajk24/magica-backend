import { z } from "zod";
import { ContentBlock } from "@/contracts/blocks";

export const MessageRole = z.enum(["user", "assistant", "system", "tool"]);
export const MessageStatus = z.enum(["streaming", "success", "failed", "cancelled"]);
export const InvocationStatus = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export const MediaType = z.enum(["image", "video", "audio"]);

export const ToolDisplay = z.object({ label: z.string(), icon: z.string() });

export const AssetDTO = z.object({
  url: z.string().url(),
  type: MediaType,
  model: z.string().optional(),
  creditUsed: z.string(),
  toolCallId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const AttachmentSource = z.enum(["uploaded", "generated"]);

export const AttachmentDTO = z.object({
  id: z.string(),
  type: MediaType,
  source: AttachmentSource,
  url: z.string().url().nullable(),
  name: z.string(),
  contentType: z.string(),
  size: z.number(),
  status: z.enum(["uploading", "ready", "failed", "cancelled"]),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  /** Transloadit temporary results purge after 24h on the Community plan; the UI renders expiry. */
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});

export const ToolInvocationDTO = z.object({
  id: z.string(),
  toolUseId: z.string(),
  toolName: z.string(),
  /** The provider sub-model that produced the output, when the tool used one. */
  subModelId: z.string().nullable(),
  display: ToolDisplay,
  status: InvocationStatus,
  input: z.unknown(),
  output: z.unknown().nullable(),
  errorMessage: z.string().nullable(),
  creditUsed: z.string(),
  durationMs: z.number().nullable(),
});

export const MessageDTO = z.object({
  id: z.string(),
  role: MessageRole,
  status: MessageStatus,
  content: z.string(),
  contentBlocks: z.array(ContentBlock).nullable(),
  attachments: z.array(AttachmentDTO).nullable(),
  assets: z.array(AssetDTO).nullable(),
  toolInvocations: z.array(ToolInvocationDTO),
  aiModel: z
    .object({ id: z.string(), name: z.string(), provider: z.string() })
    .nullable(),
  tokenUsage: z
    .object({ inputTokens: z.number(), outputTokens: z.number() })
    .nullable(),
  creditUsed: z.string(),
  feedback: z.enum(["like", "dislike"]).nullable(),
  errorMessage: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  runId: z.string().nullable(),
  createdAt: z.string(),
});

export const ChatDTO = z.object({
  id: z.string(),
  title: z.string(),
  isFavorite: z.boolean(),
  modelId: z.string(),
  activePlan: z.unknown().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type AssetDTO = z.infer<typeof AssetDTO>;
export type AttachmentSource = z.infer<typeof AttachmentSource>;
export type AttachmentDTO = z.infer<typeof AttachmentDTO>;
export type ToolInvocationDTO = z.infer<typeof ToolInvocationDTO>;
export type MessageDTO = z.infer<typeof MessageDTO>;
export type ChatDTO = z.infer<typeof ChatDTO>;
