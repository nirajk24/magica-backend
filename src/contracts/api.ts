import { z } from "zod";
import { ChatDTO, MessageDTO } from "@/contracts/messages";

export const ErrorCode = z.enum([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_ERROR",
  "RUN_ALREADY_ACTIVE",
  "INSUFFICIENT_CREDITS",
  "LIMIT_EXCEEDED",
  "QUOTA_EXCEEDED",
  "WAITPOINT_EXPIRED",
  "RATE_LIMITED",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
    traceId: z.string(),
  }),
});

export const Ok = z.object({ ok: z.literal(true) });

/**
 * The kinds of interaction a turn can park on. Declared once and reused by run metadata, the
 * active-run response, `WaitpointResolution`, the registry's `interaction` field and the
 * `Waitpoint` table.
 *
 * Adding a kind is one entry here plus one variant in `WaitpointResolution`. The orchestrator is
 * kind-agnostic.
 */
export const WaitpointKind = z.enum(["plan_approval", "questions"]);
export type WaitpointKind = z.infer<typeof WaitpointKind>;

/** Infrastructure probe, not a product surface: unauthenticated, and absent from architecture §3.4. */
export const Health = z.object({
  ok: z.literal(true),
  env: z.enum(["development", "test", "production"]),
  dbLatencyMs: z.number(),
});

/**
 * Free-tier OpenRouter models with verified tool-calling support. The first is the default, and it
 * is the one observed actually answering — the other two were rate-limited upstream by their own
 * providers on every attempt.
 */
export const ALLOWED_MODELS = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemma-4-31b-it:free",
  "z-ai/glm-5.2:free",
] as const;
export const ModelId = z.enum(ALLOWED_MODELS);
export const DEFAULT_MODEL_ID = ALLOWED_MODELS[0];

export const SendMessage = z.object({
  content: z.string().min(1).max(10_000),
  modelId: ModelId.default(DEFAULT_MODEL_ID),
  planMode: z.boolean().default(false),
  attachmentIds: z.array(z.string()).max(5).default([]),
});

/**
 * Two run ids, never conflated. `runId` is our AgentRun.id and resolves cancel, retry and
 * every ledger key. `triggerRunId` is Trigger.dev's run_xxx and is the only id
 * `useRealtimeRun` accepts; it is null for the moment before dispatch lands.
 */
export const SendMessageResult = z.object({
  chatId: z.string(),
  userMessageId: z.string(),
  assistantMessageId: z.string().nullable(),
  runId: z.string(),
  triggerRunId: z.string().nullable(),
  publicAccessToken: z.string(),
});

export const ChatWithMessages = z.object({
  chat: ChatDTO,
  messages: z.array(MessageDTO),
  messagesNextCursor: z.string().nullable(),
});

export const ChatsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  search: z.string().max(200).optional(),
  filter: z.enum(["all", "pinned"]).default("all"),
});

export const ChatsPage = z.object({
  chats: z.array(ChatDTO),
  nextCursor: z.string().nullable(),
});

export const MessagesQuery = z.object({
  messagesCursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const ActiveRun = z.object({
  runId: z.string(),
  triggerRunId: z.string().nullable(),
  status: z.enum(["queued", "running", "waiting"]),
  assistantMessageId: z.string().nullable(),
  publicAccessToken: z.string(),
  pendingWaitpoint: z
    .object({ id: z.string(), kind: WaitpointKind, payload: z.json() })
    .nullable(),
});

export const WaitpointResolution = z.union([
  z.object({
    kind: z.literal("plan_approval"),
    approved: z.boolean(),
    feedback: z.string().max(2000).optional(),
    executionMode: z.enum(["auto", "step_by_step"]).optional(),
  }),
  z.object({
    kind: z.literal("questions"),
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
    skipped: z.array(z.string()),
  }),
  z.object({ expired: z.literal(true) }),
]);

export const UpdateChat = z.object({
  title: z.string().min(1).max(200).optional(),
  isFavorite: z.boolean().optional(),
});

export const CreditsPage = z.object({
  balance: z.string(),
  entries: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      amount: z.string(),
      runId: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

/** Microcredits as a decimal string, like every other credit value on the wire. */
export const TopUp = z.object({ amount: z.string().regex(/^[1-9]\d*$/) });

export const TopUpResult = z.object({ balance: z.string() });

export const Feedback = z.object({ type: z.enum(["like", "dislike"]).nullable() });

export type SendMessage = z.infer<typeof SendMessage>;
export type SendMessageResult = z.infer<typeof SendMessageResult>;
export type ChatWithMessages = z.infer<typeof ChatWithMessages>;
export type ChatsQuery = z.infer<typeof ChatsQuery>;
export type ChatsPage = z.infer<typeof ChatsPage>;
export type MessagesQuery = z.infer<typeof MessagesQuery>;
export type ActiveRun = z.infer<typeof ActiveRun>;
export type WaitpointResolution = z.infer<typeof WaitpointResolution>;
export type CreditsPage = z.infer<typeof CreditsPage>;
export type TopUp = z.infer<typeof TopUp>;
export type TopUpResult = z.infer<typeof TopUpResult>;
export type ModelId = z.infer<typeof ModelId>;
export type Health = z.infer<typeof Health>;
