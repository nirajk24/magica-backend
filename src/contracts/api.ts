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
 * Each kind names the payload schema a client renders it with: `plan_approval` carries a
 * `PlanApprovalPayload`, `questions` a `QuestionsPayload`.
 *
 * Adding a kind is one entry here plus one payload schema and one variant in `ResolveWaitpoint`.
 * The orchestrator is kind-agnostic.
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
/**
 * `openrouter/free` is the Free Models Router: it picks an available free model per request, which is
 * how a turn survives one provider rate-limiting us without any fallback logic of ours. It is first,
 * so it is the default. The explicit ids remain selectable for pinning a single model.
 *
 * INVARIANT: every entry must be free and must support tool calling. The agent loop cannot run on a
 * model without tools, and a paid model is out of scope.
 */
export const ALLOWED_MODELS = [
  "openrouter/free",
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

export const PlanApprovalResolution = z.object({
  kind: z.literal("plan_approval"),
  approved: z.boolean(),
  feedback: z.string().max(2000).optional(),
  executionMode: z.enum(["auto", "step_by_step"]).optional(),
});

export const QuestionsResolution = z.object({
  kind: z.literal("questions"),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  skipped: z.array(z.string()),
});

/** Written by the server when a token times out or its run is cancelled. */
export const WaitpointExpired = z.object({ expired: z.literal(true) });

/**
 * What a client may submit to `POST /waitpoints/:id/resolve`.
 *
 * INVARIANT: `{ expired: true }` is not in here. It is written by the server when a token times out
 * or a run is cancelled, and accepting it from a client would let one expire its own overlay
 * through a path that skips the timeout.
 */
export const ResolveWaitpoint = z.discriminatedUnion("kind", [
  PlanApprovalResolution,
  QuestionsResolution,
]);

/** Every way a waitpoint can end: the client's answer, or the server's expiry. */
export const WaitpointResolution = z.union([ResolveWaitpoint, WaitpointExpired]);

/**
 * One step of a plan, as the card renders it.
 *
 * INVARIANT: `estimatedCredits` is the registry's own estimate for this step's tool call, produced
 * by the same function that charges at execution. The model states no cost anywhere.
 */
export const PlanStepPayload = z.object({
  key: z.string(),
  title: z.string(),
  description: z.string(),
  tool: z.string(),
  subModelId: z.string().nullable(),
  estimatedCredits: z.string(),
});

/** The `plan_approval` waitpoint payload. Paired with `WaitpointKind.plan_approval`. */
export const PlanApprovalPayload = z.object({
  title: z.string(),
  overview: z.string(),
  steps: z.array(PlanStepPayload).min(1),
  estimatedTotal: z.string(),
});

/**
 * One question the agent needs answered before it can spend credits.
 *
 * `required` marks the asterisk on the card; it does not make an answer mandatory. Every question is
 * skippable and the skipped ids go back to the model, which decides what to do about them.
 */
export const Question = z.discriminatedUnion("type", [
  z.object({
    id: z.string().max(64),
    type: z.literal("text"),
    prompt: z.string().max(300),
    required: z.boolean().default(false),
  }),
  z.object({
    id: z.string().max(64),
    type: z.literal("image"),
    prompt: z.string().max(300),
    required: z.boolean().default(false),
    maxImages: z.number().int().min(1).max(10).default(1),
  }),
  z.object({
    id: z.string().max(64),
    type: z.literal("select"),
    prompt: z.string().max(300),
    required: z.boolean().default(false),
    options: z
      .array(
        z.object({
          value: z.string().max(64),
          label: z.string().max(120),
          recommended: z.boolean().default(false),
        }),
      )
      .min(2)
      .max(8),
    allowOther: z.boolean().default(true),
  }),
]);

/** The `questions` waitpoint payload. Paired with `WaitpointKind.questions`. */
export const QuestionsPayload = z.object({
  message: z.string().max(300),
  questions: z.array(Question).min(1).max(8),
});

export const UpdateChat = z.object({
  title: z.string().min(1).max(200).optional(),
  isFavorite: z.boolean().optional(),
});

/** What a mutation on one chat answers with: the row as it now stands. */
export const ChatResponse = z.object({ chat: ChatDTO });

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

/**
 * Availability of the shared LLM path, and nothing else.
 *
 * `rateLimitedUntil` is null once the cooldown has elapsed, so a client renders it without comparing
 * clocks. `limitedModel` names the model that hit the limit — it is NOT "the model serving this
 * chat", which is `ChatDTO.modelId`, nor "the model that produced this answer", which is
 * `MessageDTO.aiModel`.
 */
export const LlmStatus = z.object({
  limitedModel: z.string().nullable(),
  rateLimitedUntil: z.string().nullable(),
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
export type ResolveWaitpoint = z.infer<typeof ResolveWaitpoint>;
export type WaitpointResolution = z.infer<typeof WaitpointResolution>;
export type PlanStepPayload = z.infer<typeof PlanStepPayload>;
export type PlanApprovalPayload = z.infer<typeof PlanApprovalPayload>;
export type Question = z.infer<typeof Question>;
export type QuestionsPayload = z.infer<typeof QuestionsPayload>;
export type CreditsPage = z.infer<typeof CreditsPage>;
export type LlmStatus = z.infer<typeof LlmStatus>;
export type TopUp = z.infer<typeof TopUp>;
export type TopUpResult = z.infer<typeof TopUpResult>;
export type ModelId = z.infer<typeof ModelId>;
export type Health = z.infer<typeof Health>;
export type Ok = z.infer<typeof Ok>;
export type UpdateChat = z.infer<typeof UpdateChat>;
export type Feedback = z.infer<typeof Feedback>;
export type ChatResponse = z.infer<typeof ChatResponse>;
