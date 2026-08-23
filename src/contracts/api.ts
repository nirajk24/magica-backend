import { z } from "zod";
import { AttachmentDTO, AttachmentSource, ChatDTO, MessageDTO } from "@/contracts/messages";

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
  attachmentIds: z
    .array(z.string())
    .max(5)
    .default([])
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Attachment ids must be unique.",
    }),
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

export const PlanStepStatus = z.enum(["pending", "in_progress", "completed", "failed"]);

/**
 * The plan a chat is executing step by step: what `Chat.activePlan` holds and the plan-progress
 * card renders. Written when a plan is approved with `executionMode: "step_by_step"`, advanced by
 * the `update_step` tool, replaced by the next approved plan.
 *
 * `estimatedCredits` carries over from the approved `PlanStepPayload` — server-priced, in
 * microcredits as a string.
 */
export const ActivePlan = z.object({
  title: z.string(),
  executionMode: z.enum(["auto", "step_by_step"]),
  steps: z
    .array(
      z.object({
        key: z.string(),
        title: z.string(),
        estimatedCredits: z.string(),
        status: PlanStepStatus,
        note: z.string().optional(),
      }),
    )
    .min(1),
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

export const UsageQuery = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  category: z.string().max(64).optional(),
});

/**
 * Credit spend aggregated for the usage overview, all figures microcredits as strings.
 *
 * One category per tool that actually cost something (figures are settled and reconciled actuals,
 * not estimates), plus one per credit source. `records` is present only for the category the query
 * named, newest first and bounded — `truncated` says whether the bound bit.
 */
export const UsageCategory = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.enum(["tool", "adjustment"]),
  debited: z.string(),
  credited: z.string(),
  count: z.number().int(),
  latestAt: z.string().nullable(),
  records: z
    .array(
      z.object({
        id: z.string(),
        chatId: z.string().nullable(),
        runId: z.string().nullable(),
        amount: z.string(),
        estimated: z.string().nullable().optional(),
        adjustment: z.string().nullable().optional(),
        at: z.string(),
      }),
    )
    .optional(),
  truncated: z.boolean().optional(),
});

export const UsagePage = z.object({
  from: z.string(),
  to: z.string(),
  totalDebited: z.string(),
  totalCredited: z.string(),
  records: z.number().int(),
  categories: z.array(UsageCategory),
});

/** Media MIME types only — the PDF scopes uploads to image, video and audio attachments. */
export const UploadContentType = z
  .string()
  .max(120)
  .regex(/^(image|video|audio)\/[\w.+-]+$/);

export const UploadFileSpec = z.object({
  name: z.string().min(1).max(200),
  contentType: UploadContentType,
  size: z.number().int().min(1),
});

export const SignUploads = z.object({
  files: z.array(UploadFileSpec).min(1).max(5),
});

/**
 * One signed Transloadit assembly per requested file, in request order. `params` is the exact JSON
 * string that was signed — the client must send it verbatim or the signature no longer matches.
 */
export const SignUploadsResult = z.object({
  assemblies: z.array(z.object({ params: z.string(), signature: z.string() })),
  expiresAt: z.string(),
});

/**
 * Assembly completion, reported by the client that ran the upload. Upserted on the unique
 * `assemblyId`, so a duplicate report (retry, reconnect) updates the same row instead of failing.
 */
export const CreateAttachment = z
  .object({
    assemblyId: z.string().min(1).max(191),
    status: z.enum(["uploading", "ready", "failed", "cancelled"]),
    file: z.object({
      name: z.string().min(1).max(200),
      contentType: UploadContentType,
      size: z.number().int().min(1),
      url: z.string().url().max(2000).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  })
  .refine((a) => a.status !== "ready" || a.file.url !== undefined, {
    message: "A ready attachment must carry its result URL.",
    path: ["file", "url"],
  });

export const AttachmentsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  source: AttachmentSource.optional(),
  chatId: z.string().optional(),
});

export const AttachmentsPage = z.object({
  attachments: z.array(AttachmentDTO),
  nextCursor: z.string().nullable(),
});

export const UpdateAttachment = z.object({ name: z.string().min(1).max(200) });

/** What a mutation on one attachment answers with: the row as it now stands. */
export const AttachmentResponse = z.object({ attachment: AttachmentDTO });

/**
 * The lifecycle events a webhook endpoint can subscribe to. Names mirror the Magica platform's
 * own `run.started` / `run.completed` style, so a receiver written against one reads the other.
 */
export const WebhookEvent = z.enum([
  "agent.started",
  "agent.completed",
  "agent.failed",
  "tool.completed",
]);

export const ApiKeyDTO = z.object({
  id: z.string(),
  name: z.string(),
  /**
   * A short fingerprint derived from the key's hash — NOT a substring of the key itself. The
   * plaintext is never stored, so there is no key tail to show; this exists to tell two rows
   * apart in a list and reveals nothing about the secret.
   */
  fingerprint: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});

export const CreateApiKey = z.object({ name: z.string().min(1).max(100) });

/**
 * The one and only response carrying the plaintext key. Only its SHA-256 hash is stored, so a
 * lost key is replaced rather than recovered.
 */
export const CreateApiKeyResult = z.object({ apiKey: ApiKeyDTO, key: z.string() });

export const ApiKeysPage = z.object({ apiKeys: z.array(ApiKeyDTO) });

export const WebhookEndpointDTO = z.object({
  id: z.string(),
  url: z.string().url(),
  events: z.array(WebhookEvent),
  createdAt: z.string(),
});

export const CreateWebhookEndpoint = z.object({
  url: z.string().url().max(2000).startsWith("https://"),
  events: z.array(WebhookEvent).min(1),
});

/** Carries the signing secret once, on creation, for the same reason an API key does. */
export const CreateWebhookEndpointResult = z.object({
  endpoint: WebhookEndpointDTO,
  secret: z.string(),
});

export const WebhookEndpointsPage = z.object({ endpoints: z.array(WebhookEndpointDTO) });

export const WebhookDeliveryDTO = z.object({
  id: z.string(),
  event: WebhookEvent,
  status: z.enum(["pending", "delivered", "failed"]),
  attempts: z.number().int(),
  lastAttemptAt: z.string().nullable(),
  createdAt: z.string(),
});

export const WebhookDeliveriesPage = z.object({ deliveries: z.array(WebhookDeliveryDTO) });

/**
 * The body of every outbound webhook. `data` is the event-specific object; the envelope is
 * identical across events so a receiver can route on `type` before parsing anything else.
 */
export const WebhookPayload = z.object({
  id: z.string(),
  type: WebhookEvent,
  createdAt: z.string(),
  data: z.record(z.string(), z.unknown()),
});

/** A public-API run status: what a caller polls while a turn is still working. */
export const PublicRunStatus = z.object({
  runId: z.string(),
  chatId: z.string(),
  status: z.enum(["queued", "running", "waiting", "completed", "failed", "cancelled"]),
  assistantMessageId: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** One direct Magica tool execution, outside any conversation. */
export const RunTool = z.object({
  input: z.record(z.string(), z.unknown()),
});

export const RunToolResult = z.object({
  tool: z.string(),
  subModelId: z.string().nullable(),
  output: z.unknown(),
  creditUsed: z.string(),
  durationMs: z.number(),
});

export const ToolSpecDTO = z.object({
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  /** JSON Schema for the tool's input, generated from the same Zod schema the runtime parses. */
  inputSchema: z.unknown(),
});

export const ToolsPage = z.object({ tools: z.array(ToolSpecDTO) });

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
export type PlanStepStatus = z.infer<typeof PlanStepStatus>;
export type ActivePlan = z.infer<typeof ActivePlan>;
export type UsageQuery = z.infer<typeof UsageQuery>;
export type UsageCategory = z.infer<typeof UsageCategory>;
export type UsagePage = z.infer<typeof UsagePage>;
export type CreditsPage = z.infer<typeof CreditsPage>;
export type LlmStatus = z.infer<typeof LlmStatus>;
export type TopUp = z.infer<typeof TopUp>;
export type TopUpResult = z.infer<typeof TopUpResult>;
export type WebhookEvent = z.infer<typeof WebhookEvent>;
export type ApiKeyDTO = z.infer<typeof ApiKeyDTO>;
export type CreateApiKey = z.infer<typeof CreateApiKey>;
export type CreateApiKeyResult = z.infer<typeof CreateApiKeyResult>;
export type ApiKeysPage = z.infer<typeof ApiKeysPage>;
export type WebhookEndpointDTO = z.infer<typeof WebhookEndpointDTO>;
export type CreateWebhookEndpoint = z.infer<typeof CreateWebhookEndpoint>;
export type CreateWebhookEndpointResult = z.infer<typeof CreateWebhookEndpointResult>;
export type WebhookEndpointsPage = z.infer<typeof WebhookEndpointsPage>;
export type WebhookDeliveryDTO = z.infer<typeof WebhookDeliveryDTO>;
export type WebhookDeliveriesPage = z.infer<typeof WebhookDeliveriesPage>;
export type WebhookPayload = z.infer<typeof WebhookPayload>;
export type PublicRunStatus = z.infer<typeof PublicRunStatus>;
export type RunTool = z.infer<typeof RunTool>;
export type RunToolResult = z.infer<typeof RunToolResult>;
export type ToolSpecDTO = z.infer<typeof ToolSpecDTO>;
export type ToolsPage = z.infer<typeof ToolsPage>;
export type UploadFileSpec = z.infer<typeof UploadFileSpec>;
export type SignUploads = z.infer<typeof SignUploads>;
export type SignUploadsResult = z.infer<typeof SignUploadsResult>;
export type CreateAttachment = z.infer<typeof CreateAttachment>;
export type AttachmentsQuery = z.infer<typeof AttachmentsQuery>;
export type AttachmentsPage = z.infer<typeof AttachmentsPage>;
export type UpdateAttachment = z.infer<typeof UpdateAttachment>;
export type AttachmentResponse = z.infer<typeof AttachmentResponse>;
export type ModelId = z.infer<typeof ModelId>;
export type Health = z.infer<typeof Health>;
export type Ok = z.infer<typeof Ok>;
export type UpdateChat = z.infer<typeof UpdateChat>;
export type Feedback = z.infer<typeof Feedback>;
export type ChatResponse = z.infer<typeof ChatResponse>;
