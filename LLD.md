# Magica Backend — Low-Level Design & Phased Build Plan

Companion to `ARCHITECTURE.md` (the HLD). That document says *what* and *why*; this one says
*in what order*, *in which file*, and *with exactly which types*.

**Read this top to bottom once.** Then work phase by phase — each phase has a Definition of Done
you can check without running the next phase's code.

---

## 0. The build strategy in one page

### Vertical slice first

We do **not** build layer by layer (all routes, then all services, then all tools). We build one
complete path through every layer, make it excellent, then widen.

```
Phase 1 slice:   auth → send → durable dispatch → agent loop → ONE tool → stream → persist → reload-recover
                 ▲                                                                                        ▲
                 └──────────────── every layer touched, nothing stubbed ───────────────────────────────────┘
```

Why: a narrow path with real idempotency, real failure handling and real recovery is worth more than
a wide surface of half-features. Breadth is the easiest thing to add later and the hardest thing to
retrofit correctness into.

### What makes later phases safe

The HLD already put extension seams in the right places. **These are the reason Phases 4–7 cannot
break Phase 1–3 code.** Every deferred item below plugs into a seam that ships in Phase 1:

| Seam | Shipped in | Later phases add | Orchestration edits needed |
|---|---|---|---|
| `registry` object (`tools/registry.ts`) | 1 | tools 2–7 | **zero** — one entry each |
| `interaction?: WaitpointKind` + `WaitpointResolution` union | 4 | `questions` kind | **zero, verified** — `ask_questions` is a registry entry and a payload schema, and `run-agent-turn.ts` was not touched to add it |
| `SendMessage.attachmentIds: string[]` | 1 (accepts `[]`) | Transloadit uploads | none — route already validates ownership |
| `?cursor` / `?search` / `?filter` query params | 1 (cursor only) | search, pin filter | additive params on one route |
| `Chat.activePlan Json?` | 1 (column exists, always null) | step-by-step mode | none — `update_step` writes, `/chats/:id` reads |
| `agent-skills/` directory scan | 3 | skill #5, #6… | none — it's a file on disk |
| `ApiKey` / `WebhookEndpoint` / `WebhookDelivery` tables | 0 (migration #1) | bonus tier | **no migration churn on Day 3** |
| `blockRenderers` map (FE) | 1 | new block types | one map entry |

**The rule this buys us:** if a phase requires editing `run-agent-turn.ts` to add a *feature*, the
seam was missing. Stop and add the seam instead.

### Deferrable without impact — the explicit list

Reviewed against the whole HLD. Each of these can ship in a later phase with **no change** to
earlier code:

| Deferrable | Why it's safe | Phase |
|---|---|---|
| `crop_image`, `merge_videos`, `get_model_schema` | registry entries; the loop never names a tool | 5 |
| `questions` waitpoint (`ask_questions`) | the interaction wrapper is kind-agnostic from Phase 4 | ~~6~~ — pulled into 4, because a claim about a second kind is only worth what the second kind proves |
| Step-by-step mode + `update_step` | `activePlan` column + a system-prompt branch; auto mode unaffected | 6 |
| Uploads (Transloadit + `/uploads/sign` + `/attachments`) | `attachmentIds: []` is valid; nothing reads attachments until they exist | 6 |
| Search, pin, filter, bulk delete | additive query params + `PATCH`/`DELETE` on an existing route | 5 |
| Media library, files-in-task modal, attachment rename/delete | new routes over an existing table | 6 |
| `/messages/:id/feedback`, `/llm/status` | leaf routes, one column / one row each | 6 |
| Public API, signed webhooks, Mintlify | tables exist from migration #1 | 7 |
| `credit_approval`, `media_selector` kinds | **declined** — not required by the scope | — |

### Non-deferrable — do not be tempted

| Must be in Phase 1–2 | Why |
|---|---|
| Credits ledger (`lib/credits`) | the send route reserves admission in the same transaction as run creation. Retrofitting money into a live write path is how double-charges are born |
| Idempotency keys | `AgentRun.idempotencyKey`, `charge:{invocationId}` etc. are unique **constraints**. Adding them later means backfilling and a migration against real rows |
| Progressive persistence | partial output must survive a crash; bolting it on means rewriting the loop |
| `defineRoute` wrapper | auth + Zod + error envelope + traceId in one place. Written after 10 routes = 10 inconsistent routes |
| Structured logging | the six required keys must be bound at bootstrap. Retro-fitting loses the correlation |

---

## 1. Repo layout with responsibilities

```
magica-backend/
├── prisma/
│   ├── schema.prisma                  Phase 0 — full schema, all tables, migration #1
│   ├── migrations/                    + 2 raw-SQL migrations (partial unique indexes, pg_trgm)
│   └── seed.ts                        Phase 0 — demo user + chats. Moved from Phase 2:
│                                       single Neon branch + Phase-1 schema churn means every
│                                       `migrate reset` wipes the data Phase 1 tests against
├── prisma.config.ts                   Phase 0
├── trigger.config.ts                  Phase 1 — project ref, prismaExtension, agent-skills as external files
├── agent-skills/                       Phase 3
│   ├── image-editing/SKILL.md + assets/aspect-ratios.md
│   ├── video-production/SKILL.md
│   ├── media-planning/SKILL.md
│   └── capabilities/SKILL.md
├── src/
│   ├── middleware.ts                  Phase 0 — clerkMiddleware + CORS (OPTIONS short-circuit)
│   ├── contracts/                     ★ THE shared language. Pure Zod, zero imports from src/
│   │   ├── blocks.ts                  ContentBlock union, BlockProjection
│   │   ├── messages.ts                MessageDTO, ToolInvocationDTO, AssetDTO, AttachmentDTO
│   │   ├── api.ts                     every request + response + ErrorCode
│   │   ├── realtime.ts                RunMetadata, stream ids
│   │   └── index.ts                   barrel — the only thing FE imports
│   ├── app/api/
│   │   ├── v1/…/route.ts              thin handlers: parse → service → respond. No logic.
│   │   └── webhooks/clerk/route.ts    Phase 6 (bonus fidelity)
│   ├── services/
│   │   ├── chat.service.ts            list/get/create/rename/pin/soft-delete, ownership scoping
│   │   ├── message.service.ts         serialization (message + toolInvocations + assets), pagination
│   │   ├── run.service.ts             ★ the state machine — assertTransition, stale-lock, cancel
│   │   ├── waitpoint.service.ts       Phase 4 — open/close/resolve, conditional UPDATE
│   │   └── attachment.service.ts      Phase 6
│   ├── lib/
│   │   ├── env.ts                     Phase 0 — Zod over process.env, throws at boot
│   │   ├── db.ts                      Phase 0 — PrismaClient + adapter-pg singleton, max:5
│   │   ├── api.ts                     Phase 0 — defineRoute(), definePublicRoute()
│   │   ├── users.ts                   Phase 0 — ensureUserWithGrant(), the account bootstrap
│   │   ├── logger.ts                  Phase 0 — pino wrapper, six-key child logger
│   │   ├── credits/index.ts           Phase 1 — the ONLY writer of ledger + balance
│   │   └── skills/                    Phase 3 — scan, parse, containment check, cache
│   ├── tools/
│   │   ├── define.ts                  Phase 1 — defineTool(), AgentTool type
│   │   ├── registry.ts                Phase 1 — the one object
│   │   ├── to-ai-sdk.ts               Phase 1 — registry → AI SDK tool(), wraps execute
│   │   ├── magica-client.ts           Phase 1 — run + poll adapter
│   │   ├── gpt-image-2.ts             Phase 1
│   │   ├── crop-image.ts              Phase 5
│   │   ├── merge-videos.ts            Phase 5
│   │   ├── get-model-schema.ts        Phase 5
│   │   ├── load-skill.ts              Phase 3
│   │   ├── read-skill-asset.ts        Phase 3
│   │   ├── submit-plan.ts             Phase 4
│   │   ├── ask-questions.ts           Phase 4 — shipped with it, or "kind-agnostic" is untested
│   │   └── update-step.ts             Phase 6
│   ├── agent/                        NOT under trigger/: see the note below
│   │   ├── run-agent-turn.ts          Phase 1 — ★ the loop, plain fn with injected deps
│   │   ├── turn-state.ts              Phase 1 — block accumulator: segments + stream offsets
│   │   ├── llm.ts                     Phase 1 — OpenRouter + streamText + part mapping
│   │   └── tool-runtime.ts            Phase 1 — the wrapper's Postgres + credits half
│   ├── trigger/                       task definitions ONLY — this dir is what Trigger scans
│   │   ├── agent-turn.ts              Phase 1 — the task shell, binds every seam
│   │   ├── magica-node-run.ts         Phase 1 — typed child task (poll loop)
│   │   └── streams.ts                 Phase 1 — streams.define
│   └── prompts/system.ts              Phase 1 (base) → Phase 3 (+ skill index)
├── tests/{unit,integration,acceptance,msw,fixtures}/
└── scripts/{sync-contracts,gen-openapi}.ts
```

**Layering rule, enforced by review:** `route → service → lib/db`. A route never touches Prisma.
A service never imports another service (shared logic moves to `lib/`). `contracts/` imports nothing
from `src/` — that is what makes it safe to copy to the frontend.

---

## 2. Contracts in full

These are the deliverable of Phase 0 and the reason implementation gets easy: once these compile,
every route body and every response is already typed on both sides.

### 2.1 `contracts/blocks.ts`

```ts
import { z } from "zod";

const base = { segment: z.number().int().default(0) };

export const ContentBlock = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("text"),      text: z.string() }),
  z.object({ ...base, type: z.literal("thinking"),  thinking: z.string(),
                                                    durationMs: z.number().optional() }),
  z.object({ ...base, type: z.literal("tool_use"),  id: z.string(), name: z.string(),
                                                    input: z.unknown() }),
  z.object({ ...base, type: z.literal("tool_result"), toolUseId: z.string(),
                                                    summary: z.string().optional() }),
  z.object({ ...base, type: z.literal("citations"), items: z.array(
                z.object({ title: z.string(), url: z.string().url() })) }),
  // Numbers are REQUIRED here on purpose: v7 reports usage as `number | undefined`, and the
  // orchestrator emits this block only when both counts are present. Absence is modelled by the
  // block not existing, never by a zero.
  z.object({ ...base, type: z.literal("usage"),     inputTokens: z.number(),
                                                    outputTokens: z.number() }),
  // Phase 6 — step-by-step mode
  z.object({ ...base, type: z.literal("step_update"), stepKey: z.string(),
                                                    status: z.string(), note: z.string().optional() }),
]);
export type ContentBlock = z.infer<typeof ContentBlock>;

/** Realtime projection: structure without prose. See ARCHITECTURE §3.1/§3.5. */
export const BlockProjection = z.object({
  segment:   z.number().int(),
  type:      z.string(),
  toolUseId: z.string().optional(),
  name:      z.string().optional(),
  chars:     z.number().optional(),   // stream characters consumed by a CLOSED text block.
                                       // This is how the FE slices one flat text stream across
                                       // several text blocks — see the rule below.
  streaming: z.boolean().optional(),   // set on the ONE block currently being written
});
export type BlockProjection = z.infer<typeof BlockProjection>;
```

**How one flat stream feeds many text blocks.** `agentText` is a single append-only
stream, but a `text → tool → text` turn produces two separate text blocks. Without a rule the
frontend cannot tell which characters belong to which block.

The rule: **`chars` is an exact character count, and text blocks consume the stream in order.**

```
blocks: [ {type:'text', chars:180}, {type:'tool_use', …}, {type:'text', streaming:true} ]
stream: "Sure, I'll generate that…<180 chars>…Here is the result so far"
                                   ▲
        block[0] takes [0, 180)     └─ block[2] takes [180, end) because it is `streaming`

offset(n) = Σ chars of all preceding blocks  (only text blocks consume the stream)
```

Two invariants make it safe:
- The backend writes `chars` **only when a block closes**, so a closed block's slice never moves.
- At most one block carries `streaming: true`, and it always takes the remainder of the stream.

A closed text block's prose is therefore reconstructable from the stream *and* is already persisted
in `contentBlocks`. On reload the FE reads the persisted text and never touches offsets at all — the
slicing only exists for the live path.
```ts
```

### 2.2 `contracts/messages.ts`

```ts
export const MessageRole   = z.enum(["user", "assistant", "system", "tool"]);
export const MessageStatus = z.enum(["streaming", "success", "failed", "cancelled"]);
export const InvocationStatus = z.enum(["pending","running","completed","failed","cancelled"]);

export const AssetDTO = z.object({
  url: z.string().url(),
  type: z.enum(["image", "video", "audio"]),
  model: z.string().optional(),
  creditUsed: z.string(),               // BigInt over the wire is ALWAYS a string
  toolCallId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const AttachmentDTO = z.object({
  id: z.string(), type: z.enum(["image","video","audio"]),
  url: z.string().url().nullable(), name: z.string(),
  contentType: z.string(), size: z.number(),
  status: z.enum(["uploading","ready","failed","cancelled"]),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});

export const ToolInvocationDTO = z.object({
  id: z.string(),
  toolUseId: z.string(),
  toolName: z.string(),
  display: z.object({ label: z.string(), icon: z.string() }),  // from the registry
  status: InvocationStatus,
  input: z.unknown(),                   // sanitized
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
  toolInvocations: z.array(ToolInvocationDTO),      // joined — tool cards render from this alone
  aiModel: z.object({ id: z.string(), name: z.string(),
                      provider: z.string() }).nullable(),
  tokenUsage: z.object({ inputTokens: z.number(),
                         outputTokens: z.number() }).nullable(),
  creditUsed: z.string(),
  feedback: z.enum(["like","dislike"]).nullable(),
  errorMessage: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  runId: z.string().nullable(),
  createdAt: z.string(),                // ISO
});

/** Response of `GET /chats/:id`. Named because the FE api-client imports it by name. */
export const ChatWithMessages = z.object({
  chat: ChatDTO,
  messages: z.array(MessageDTO),          // ASCENDING (oldest→newest) = render order.
                                          // The INDEX is (chatId, createdAt DESC, id) because a page
                                          // fetches the NEWEST rows; the service reverses before
                                          // returning. Query newest-first, render oldest-first.
  messagesNextCursor: z.string().nullable(),   // opaque; encodes (createdAt, id) of the oldest row
});

export const Ok = z.object({ ok: z.literal(true) });

export const ChatDTO = z.object({
  id: z.string(), title: z.string(), isFavorite: z.boolean(),
  modelId: z.string(), activePlan: z.unknown().nullable(),
  createdAt: z.string(), updatedAt: z.string(),
});
```

> **BigInt rule, stated once:** credits are `BigInt` in Prisma and **`string` on the wire**.
> `JSON.stringify(1n)` throws, and `Number(bigint)` silently loses precision. The serializer in
> `message.service.ts` is the single conversion point. Never `Number()` a credit value.

### 2.3 `contracts/api.ts` — every route

```ts
export const ErrorCode = z.enum([
  "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "VALIDATION_ERROR",
  "RUN_ALREADY_ACTIVE", "INSUFFICIENT_CREDITS", "LIMIT_EXCEEDED",
  "QUOTA_EXCEEDED", "WAITPOINT_EXPIRED", "RATE_LIMITED", "INTERNAL",
]);

export const ApiError = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),                       // user-safe, always renderable
    details: z.unknown().optional(),           // Zod field errors
    traceId: z.string(),
  }),
});
// Success envelope is always { data: T }.

export const ALLOWED_MODELS = [
  "google/gemma-4-31b-it:free",
  "z-ai/glm-5.2:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
] as const;
```

| # | Route | Method | Phase | Request | Response `data` |
|---|---|---|---|---|---|
| 1 | `/api/v1/chats/:id/messages` | POST | **1** | `SendMessage` | `SendMessageResult` |
| 2 | `/api/v1/chats/:id` | GET | **1** | `?messagesCursor&limit` | `{ chat, messages, messagesNextCursor }` |
| 3 | `/api/v1/chats/:id/active-run` | GET | **1** | — | `ActiveRun \| null` |
| 4 | `/api/v1/runs/:id/cancel` | POST | **2** | — | `{ ok: true }` |
| 5 | `/api/v1/messages/:id/retry` | POST | **2** | — | `SendMessageResult` |
| 6 | `/api/v1/chats` | GET | **1** (list) · **5** (`search`/`filter`) | `?cursor&limit&search&filter` | `{ chats, nextCursor }` |
| 7 | `/api/v1/chats/:id` | PATCH | **5** | `{ title?, isFavorite? }` | `{ chat }` |
| 8 | `/api/v1/chats/:id` | DELETE | **5** | — | `{ ok: true }` |
| 9 | `/api/v1/waitpoints/:id/resolve` | POST | **4** | `ResolveWaitpoint` | `{ ok: true }` |
| 10 | `/api/v1/credits` | GET | **2** | `?cursor` | `{ balance, entries, nextCursor }` |
| 11 | `/api/v1/credits/top-up` | POST | **2** | `{ amount }` + `Idempotency-Key` hdr | `{ balance }` |
| 12 | `/api/v1/uploads/sign` | POST | **6** | `{ files[] }` | `{ params, signature }` |
| 13 | `/api/v1/attachments` | POST | **6** | assembly payload | `{ attachment }` |
| 14 | `/api/v1/attachments` | GET | **6** | `?cursor&source&chatId` | `{ attachments, nextCursor }` |
| 15 | `/api/v1/attachments/:id` | PATCH/DELETE | **6** | `{ name }` / — | `{ attachment }` / `{ ok }` |
| 16 | `/api/v1/messages/:id/feedback` | PATCH | **6** | `{ type }` | `{ ok: true }` |
| 17 | `/api/v1/llm/status` | GET | **2** | — | `LlmStatus` — availability only |

```ts
// ─── 1. SEND — the most important contract in the system ───────────────────────
export const SendMessage = z.object({
  content: z.string().min(1).max(10_000),
  modelId: z.enum(ALLOWED_MODELS),              // paid/unknown rejected AT THE BOUNDARY
  planMode: z.boolean().default(false),
  attachmentIds: z.array(z.string()).max(5).default([]),   // [] until Phase 6
});
export const SendMessageResult = z.object({
  chatId: z.string(),
  userMessageId: z.string(),
  assistantMessageId: z.string().nullable(),    // null until the task bootstraps
  runId: z.string(),                            // AgentRun.id — cancel, retry, ledger keys, our rows
  triggerRunId: z.string().nullable(),          // run_xxx — useRealtimeRun ONLY. null if dispatch pending
  publicAccessToken: z.string(),                // 15-min Trigger.dev read token
});
// TWO IDS, NEVER CONFLATED. ARCHITECTURE §4.1 returned `runId: handle.id`, which
// collided with /runs/:id/cancel resolving :id as AgentRun.id. Both returned, named for their use.

// ─── 3. ACTIVE RUN — the reload workhorse ──────────────────────────────────────
export const ActiveRun = z.object({
  runId: z.string(),
  triggerRunId: z.string().nullable(),
  status: z.enum(["queued","running","waiting"]),
  assistantMessageId: z.string().nullable(),
  publicAccessToken: z.string(),                // freshly minted on EVERY call
  pendingWaitpoint: z.object({
    id: z.string(),
    kind: z.enum(["plan_approval","questions"]),
    payload: z.unknown(),
  }).nullable(),
});

// ─── 9. WAITPOINT RESOLUTION — kind-discriminated ──────────────────────────────
// Two schemas, not one: the route accepts ResolveWaitpoint, which cannot express an expiry.
// `{expired:true}` is written by the server on a timeout or a cancel, and a client that could
// send it would be able to clear its own overlay through a path that skips the timeout.
export const ResolveWaitpoint = z.discriminatedUnion("kind", [
  PlanApprovalResolution,   // { kind, approved, feedback?, executionMode? }
  QuestionsResolution,      // { kind, answers, skipped }
]);
export const WaitpointResolution = z.union([ResolveWaitpoint, WaitpointExpired]);

// ─── 9b. WAITPOINT PAYLOADS — what a parked client renders ─────────────────────
// Paired with the kind. NOT the tool's input: the model's `submit_plan` input carries raw
// toolCall arguments, and every figure below is the server's.
export const PlanStepPayload = z.object({
  key: z.string(), title: z.string(), description: z.string(),
  tool: z.string(), subModelId: z.string().nullable(),
  estimatedCredits: z.string(),                 // microcredits, from that tool's own credits()
});
export const PlanApprovalPayload = z.object({
  title: z.string(), overview: z.string(),
  steps: z.array(PlanStepPayload).min(1), estimatedTotal: z.string(),
});

export const Question = z.discriminatedUnion("type", [
  z.object({ id, type: z.literal("text"),   prompt, required }),
  z.object({ id, type: z.literal("image"),  prompt, required, maxImages }),
  z.object({ id, type: z.literal("select"), prompt, required, options[{value,label,recommended}],
             allowOther }),                     // `required` is the asterisk, not a gate: every
]);                                             // question is skippable and skips go to the model
export const QuestionsPayload = z.object({ message: z.string(), questions: z.array(Question).min(1).max(8) });

// ─── 10/11. CREDITS ────────────────────────────────────────────────────────────
export const CreditsPage = z.object({
  balance: z.string(),                          // microcredits as string
  entries: z.array(z.object({
    id: z.string(), type: z.string(), amount: z.string(),
    runId: z.string().nullable(), createdAt: z.string(),
  })),
  nextCursor: z.string().nullable(),
});
```

### 2.4 `contracts/realtime.ts`

```ts
export const RunPhase = z.enum(["thinking","working","waiting","finalizing"]);

export const RunMetadata = z.object({
  phase: RunPhase,
  phaseStartedAt: z.number(),                   // epoch ms → live duration counter
  currentStep: z.string().optional(),
  stepsCompleted: z.number(),
  blocks: z.array(BlockProjection).max(60),     // ORDERED live narrative. Bound confirmed by
                                                // measurement; the projection is sliced to the
                                                // newest 60 because a rejected snapshot kills the turn.
  reasoningText: z.string().max(4_000).optional(),  // streaming Thinking row, bounded TAIL —
                                                // metadata is re-sent whole on every delta
  activePlan: z.json().optional(),              // plan-progress card. z.json(), never
                                                // z.unknown(): metadata.set() needs DeserializedJson
  invocations: z.array(z.object({
    id: z.string(), toolUseId: z.string(), toolName: z.string(),
    display: z.object({ label: z.string(), icon: z.string() }),
    state: InvocationStatus, durationMs: z.number().optional(),
    credits: z.string().optional(), resultUrls: z.array(z.string()).optional(),
  })),
  assistantMessageId: z.string().optional(),
  waitpoint: z.object({ id: z.string(), kind: z.string(),
                        payload: z.unknown() }).optional(),
  servedModel: z.string().optional(),
  tokenUsage: z.object({ inputTokens: z.number(),
                         outputTokens: z.number() }).optional(),
});

export const STREAM_AGENT_TEXT = "agent-text";   // streams.define<string>
```

**Payload discipline:** `RunMetadata` is re-sent whole on every update. Trigger.dev caps payloads at
3 MB. `blocks` is a projection precisely so a 12-step turn cannot approach that. Prose lives on the
append-only text stream. If you ever add a field, ask "does this grow with turn length?"

---

## 3. Foundation code (Phase 0) — written once, used by everything

### 3.1 `lib/env.ts` — fail at boot, never at 2am

```ts
import { z } from "zod";

// z.coerce.boolean() is a TRAP: Boolean("false") === true, so DEMO_MODE=false
// would ENABLE demo mode. Parse the two literals explicitly.
const bool = z.enum(["true", "false"]).transform((v) => v === "true");

const Env = z.object({
  DATABASE_URL: z.string().url(),
  DATABASE_URL_UNPOOLED: z.string().url(),
  CLERK_SECRET_KEY: z.string().startsWith("sk_"),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().startsWith("pk_"),
  TRIGGER_SECRET_KEY: z.string().startsWith("tr_"),
  OPENROUTER_API_KEY: z.string().startsWith("sk-or-"),
  MAGICA_API_KEY: z.string().startsWith("gx_"),
  MAGICA_BASE_URL: z.string().url().default("https://inference.magica.com"),
  FRONTEND_URL: z.string().url(),
  ADMISSION_CREDITS: z.coerce.bigint().default(500_000n),
  MAX_TURNS: z.coerce.number().int().min(1).max(8).default(4),
  MAX_STEPS: z.coerce.number().int().min(1).max(24).default(6),
  DEMO_MODE: bool.default("false"),
  DISABLE_TITLE_GEN: bool.default("false"),
});

export const env = Env.parse(process.env);   // module load = boot check
```

A missing key becomes a named crash on startup, not `undefined` in the middle of a demo.

**`MAX_TURNS` × `MAX_STEPS` is the LLM request budget, and the product is what spends it.** They are
two different loops: `MAX_TURNS` bounds our outer `while` (one `streamText` call each), `MAX_STEPS`
bounds the SDK's inner tool-round loop inside a single call. Every inner step is one OpenRouter
request against a **50/day** ceiling, so a worst-case turn costs `MAX_TURNS × MAX_STEPS`.

The original "6, and 12 for the demo" assumed a single loop; that reasoning was always
about total requests, so it now applies to the product. At 4 × 6 the worst case is **24 requests —
half the daily budget in one turn**, which is the real bound and worth stating rather than hiding.
`MAX_TURNS` is only re-entered by an empty-stream retry (capped at 1) and a waitpoint resumption, so
4 is already generous for a two-waitpoint turn.

**For the demo, raise ONE of them, never both.** 4 × 12 = 48 is the entire daily allowance in a
single turn.

**`prisma/schema.prisma` datasource** — `prisma migrate` takes a Postgres advisory lock
that does not survive pgBouncer, so migrations must run on the direct URL:

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")            // pooled — app queries, routes AND tasks
  directUrl = env("DATABASE_URL_UNPOOLED")   // direct — migrations only
}
```

Prisma 7's CLI no longer auto-loads `.env`, so `prisma.config.ts` needs `import 'dotenv/config'`.

### 3.2 `lib/api.ts` — `defineRoute`

Every route is auth + validation + error mapping + tracing. Writing that 17 times produces 17
subtly different routes, so it exists exactly once.

```ts
type Handler<TBody, TQuery, TOut> = (ctx: {
  userId: string;
  body: TBody;
  query: TQuery;
  params: Record<string, string>;
  log: Logger;
  traceId: string;
}) => Promise<TOut>;

export function defineRoute<TBody = undefined, TQuery = undefined, TOut = unknown>(opts: {
  body?: z.ZodType<TBody>;
  query?: z.ZodType<TQuery>;
  handler: Handler<TBody, TQuery, TOut>;
}) {
  return async (req: Request, { params }: { params: Promise<Record<string,string>> }) => {
    const traceId = `req_${crypto.randomUUID()}`;
    const log = logger.child({ traceId });
    try {
      const { userId } = await auth();
      if (!userId) return fail("UNAUTHENTICATED", "Sign in to continue", 401, traceId);

      await ensureUserWithGrant(userId);        // idempotent — kills the webhook-ordering trap

      const body  = opts.body  ? await parseBody(req, opts.body) : undefined;
      const query = opts.query ? parseQuery(req, opts.query)        : undefined;

      const data = await opts.handler({ userId, body, query,
                                        params: await params, log, traceId });
      return respond({ data }, 200);          // CORS + BigInt→string, one place
    } catch (e) {
      return mapError(e, traceId, log);         // ZodError→400, AppError→its code, else 500
    }
  };
}
```

`parseBody` exists because a body that is not JSON at all throws a `SyntaxError`, which is neither
an `AppError` nor a `ZodError` — an unguarded `req.json()` reports a client typo as a 500. `respond`
serializes BigInt to a string for the same class of reason: `JSON.stringify` throws on one, so a
service that forgets to convert would take the route down instead of emitting the documented wire
value. `definePublicRoute` is the same pipeline without `auth()`, for the health probe — a route
that assembles its own `Response` gets no CORS headers, and the browser then drops a 200 it asked
for.

`ensureUserWithGrant` (`lib/users.ts`) is deliberately not one transaction: a transaction blocking
on the row's unique index holds a pool connection for the whole wait, and only the ledger write
needs atomicity. Its idempotency check is `hasSignupGrant`, not the presence of a `User` row — a row
created by any other path is still ungranted, and a crash between the two writes then repairs itself
instead of leaving an account stuck at zero.

`ensureUserWithGrant` is why the Clerk webhook is a *bonus* and not a blocker: the first
authenticated request creates the user row and grants signup credits, keyed `grant:{userId}`.

**`middleware.ts` — order is load-bearing.** Two repos means two origins, so there are
no cookies: the frontend sends `Authorization: Bearer <getToken()>` on every request.

```ts
export default clerkMiddleware({ authorizedParties: [env.FRONTEND_URL] });
// CORS lives in this same middleware, and the OPTIONS short-circuit MUST come BEFORE auth —
// a preflight carries no Authorization header, so auth-first answers 401 and the real request
// is never sent. No cookies, no Allow-Credentials.
```

**`P2002` is attributed per call site, never around the transaction.** Two different
unique violations can fire inside the send transaction and they mean opposite things:

| Violation | Meaning | Response |
|---|---|---|
| `AgentRun` partial index | a run is already active | **409 `RUN_ALREADY_ACTIVE`** |
| `CreditLedgerEntry.idempotencyKey` | this reserve already applied | **no-op, continue** |

One catch around the whole transaction would turn a duplicate send into a success, or a benign replay
into a 409. Also: the partial index is not in the Prisma schema, so `e.meta.target` may be undefined
on that error — match on `e.code === 'P2002'` at a known call site, never on `meta.target`.

A route then reads like a contract:

```ts
// app/api/v1/chats/[id]/messages/route.ts
export const POST = defineRoute({
  body: SendMessage,
  handler: ({ userId, body, params, log }) =>
    runService.send({ userId, chatId: params.id, input: body, log }),
});
```

### 3.3 `lib/db.ts`

```ts
import { PrismaPg } from "@prisma/adapter-pg";
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL, max: 5 });
export const db = globalThis.__db ?? new PrismaClient({ adapter });
if (process.env.NODE_ENV !== "production") globalThis.__db = db;
```

Module-level singleton. **The same file works in Vercel route handlers and Trigger.dev tasks** —
both are Node. `max: 5` per process because serverless multiplies processes, and the pooled Neon
URL is what stops Postgres running out of connections.

### 3.4 `lib/logger.ts`

```ts
export const logger = pino({ level: env.DEMO_MODE ? "info" : "debug" });
// The task binds all six required keys ONCE at bootstrap:
//   const log = logger.child({ chatId, runId, messageId, traceId, processId, waitpointTokenId })
// Every subsequent line carries them. This is the PDF's structured-logging row, satisfied by
// construction rather than by remembering to pass fields.
```

---

## 4. The phases

Each phase: **Goal → Files → Contract surface → Definition of Done → Tests.**
Do not start a phase until the previous DoD passes.

---

### Phase 0 — Foundation · ~2h · no user-visible feature

**Goal:** the repo boots, the schema is real, and every later phase has its plumbing.

**Files**
```
package.json, tsconfig.json (strict), .env.example, .gitignore, eslint/prettier
prisma/schema.prisma          ← ALL tables from ARCHITECTURE §2, including bonus stubs
prisma/migrations/001_init/
prisma/migrations/002_partial_unique_indexes/migration.sql
prisma/migrations/003_pg_trgm/migration.sql
src/lib/{env,db,api,logger}.ts
src/contracts/{blocks,messages,api,realtime,index}.ts
src/middleware.ts
src/app/api/v1/health/route.ts
```

`002_partial_unique_indexes/migration.sql` — Prisma cannot express these, and they are the
concurrency design:
```sql
CREATE UNIQUE INDEX one_active_run_per_chat ON "AgentRun"("chatId")
  WHERE status IN ('queued','running','waiting');
CREATE UNIQUE INDEX one_assistant_message_per_run ON "Message"("runId")
  WHERE role = 'assistant';
```

`003_pg_trgm` — needed by Phase 5 search, but shipped now so there is one migration story:
```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX chat_title_trgm   ON "Chat"    USING GIN (title gin_trgm_ops);
CREATE INDEX message_content_trgm ON "Message" USING GIN (content gin_trgm_ops);
```

**Migration sequence** — `migrate dev` generates SQL from the schema and cannot invent
our partial indexes, so 002 and 003 are created empty and hand-edited:
```bash
pnpm prisma migrate dev --name init
pnpm prisma migrate dev --create-only --name partial_unique_indexes   # then paste the SQL below
pnpm prisma migrate dev --create-only --name pg_trgm
pnpm prisma migrate dev                                              # apply 002 + 003
```

**DoD**
- `pnpm dev` boots; `GET /api/v1/health` returns `{data:{ok:true}}`
- `app/page.tsx` and `app/globals.css` from `create-next-app` are **deleted** — the backend
  serves only `app/api/**`, and a stray Next welcome page on the deployed API reads as carelessness
- `pnpm prisma migrate dev` applies clean against Neon; `psql` shows both partial indexes
- Deleting one env var crashes the boot with that variable's name in the message
- `tsc --noEmit` clean under `strict: true`

**Tests** — none yet, except a `contracts` unit test that every schema parses its own example.

---

### Phase 1 — THE VERTICAL SLICE · ~8h · the demo

**Goal:** *"generate an image of a mountain"* → durable run → live stream → tool card → asset
persisted → **reload mid-run and it keeps going.**

This is the phase everything else builds on. Everything after it is widening.

**Write in this order.** Steps 1–4 need no Trigger.dev, no Clerk and no frontend, and they hold the
highest-risk logic — the cheapest place to be wrong.

```
0  trigger.config.ts + the run-metadata size spike
1  lib/credits              + unit test asserting balance === SUM(ledger)
2  tools/{define,registry}, gpt_image_2, magica-client (against MSW)
3  trigger/magica-node-run  + the resume-not-resubmit test
4  agent/{turn-state,run-agent-turn}    with fake deps → block order + segment tests
5a tools/to-ai-sdk + agent/tool-runtime + trigger/streams    the money path, on real Postgres
5b trigger/agent-turn shell + prompts/system + turn.service + agent/llm adapter
6  services + POST send + GET chat + GET active-run + GET chats + GET credits
7  frontend (see its LLD Phase 1)
```

`trigger.config.ts` comes before step 1 because the run-metadata spike needs a worker before
anything depends on its answer. `lib/credits` also carries `reconcileToolCharge` and `tools/pricing.ts`
carries `ensureCatalogPricing`; both close simplifications §3.6 would otherwise defer.

**Files**
```
src/lib/credits/index.ts
src/app/api/v1/credits/route.ts                  (GET — moved from Phase 2: the DoD asserts the
                                                  ledger invariant, and that is far easier to eyeball
                                                  over REST than in psql. One thin route.)
src/tools/{define,registry,to-ai-sdk,magica-client,gpt-image-2}.ts
src/trigger/{streams,magica-node-run,turn-state,run-agent-turn,agent-turn}.ts
src/prompts/system.ts
src/services/{chat,message,run}.service.ts
src/app/api/v1/chats/[id]/messages/route.ts      (POST — send)
src/app/api/v1/chats/[id]/route.ts               (GET  — reload)
src/app/api/v1/chats/[id]/active-run/route.ts    (GET  — recovery)
src/app/api/v1/chats/route.ts                    (GET  — LIST ONLY, cursor, no search/filter.
                                                  Moved from Phase 5: FE Phase 3's
                                                  sidebar + Tasks page need it real, not mocked, and
                                                  it is the most-seen surface in the product.
                                                  ~20 lines over an index that already exists)
trigger.config.ts
tests/msw/magica.ts, tests/msw/openrouter.ts
```

`vitest.config.ts` ships in Phase 0 and already points its integration project at
`tests/msw/setup.ts`, which does not exist until this phase — so `pnpm test` does nothing useful
before now. Expected, not a break.

#### 4.1.1 `lib/credits` — build this before the send route

```ts
const ADMISSION = env.ADMISSION_CREDITS;

/** Every function is (a) inside a caller's transaction, (b) idempotent by key,
 *  (c) conditional so the balance can never go negative.
 *  This module is the ONLY writer of CreditLedgerEntry and User.creditBalance. */
export async function reserveAdmission(tx: Tx, a: { userId: string; runId: string }) {
  return entry(tx, { ...a, type: "reserve", amount: -ADMISSION,
                     key: `reserve:${a.runId}` });
}
export async function chargeTool(tx: Tx, a: { userId: string; invocationId: string; amount: bigint }) {
  return entry(tx, { ...a, type: "settle", amount: -a.amount,
                     key: `charge:${a.invocationId}` });
}
export async function refundToolCharge(tx: Tx, a: { userId: string; invocationId: string }) { … }
export async function refundAdmission(tx: Tx, a: { userId: string; runId: string }) { … }

async function entry(tx: Tx, { userId, type, amount, key, runId, invocationId }: EntryArgs) {
  const inserted = await tx.$executeRaw`
    INSERT INTO "CreditLedgerEntry" ("id","userId","type","amount","idempotencyKey",
                                     "runId","invocationId","createdAt")
    VALUES (${uuidv7()}, ${userId}, ${type}::"LedgerEntryType", ${amount},
            ${key}, ${runId}, ${invocationId}, now())
    ON CONFLICT ("idempotencyKey") DO NOTHING`;

  if (inserted === 0) return;                  // already applied — the ONLY exactly-once guard

  if (amount < 0n) {
    const n = await tx.$executeRaw`UPDATE "User" SET "creditBalance" = "creditBalance" + ${amount}
                                   WHERE id = ${userId} AND "creditBalance" >= ${-amount}`;
    if (n === 0) throw new AppError("INSUFFICIENT_CREDITS", "Not enough credits");
  } else {
    await tx.user.update({ where: { id: userId },
                           data: { creditBalance: { increment: amount } } });
  }
}
```

> **Ledger row FIRST, then the balance — and `ON CONFLICT DO NOTHING`, never a caught exception.**
> Updating the balance first and catching `P2002` from the insert is wrong twice over:
> 1. **It double-charged on retry.** The decrement ran again, *then* the insert collided, and the
>    catch returned success — so `balance` drifted from `SUM(ledger)` silently.
> 2. **It poisoned the transaction.** In Postgres, an error inside a transaction aborts it; every
>    later statement in that `tx` fails with "current transaction is aborted". Since
>    `reserveAdmission` runs inside the send route's transaction alongside the message and run
>    inserts, a caught `P2002` would have taken the whole send down.
>
> Insert-first inverts both: the unique index decides whether this is the first application, the row
> count tells us without raising, and the balance only moves when the ledger actually grew.

Four properties this relies on:
1. **The ledger is the source of truth**, the balance is a cache. Writing the truth first means a
   crash between the two statements can only *understate* the cache — recomputable from `SUM(ledger)`,
   never a phantom charge.
2. **Conditional decrement** — `WHERE creditBalance >= amount`. Never negative, no read-then-write race.
3. **`ON CONFLICT DO NOTHING` + row count** — exactly-once with no exception, so the caller's
   transaction stays healthy.
4. **Invariant** — `balance === SUM(ledger.amount)`, asserted in tests after every scenario.

#### 4.1.2 `tools/define.ts` + `registry.ts`

```ts
export interface ToolCtx {
  userId: string; chatId: string; runId: string; invocationId: string;
  recordExternalRef: (externalId: string) => Promise<void>;   // crash-safe checkpoint
  log: Logger;
}

export function defineTool<I extends z.ZodType, O extends z.ZodType>(t: {
  name: string;
  description: string;                            // the LLM reads this
  display: { label: string; icon: string };       // the HUMAN reads this
  interaction?: "plan_approval" | "questions";    // no execute if set
  tags?: string[];                                // §8 tool subsetting
  input: I;
  output: O;
  credits: (input: z.infer<I>) => bigint;
  execute?: (input: z.infer<I>, ctx: ToolCtx) => Promise<z.infer<O>>;
}) { return t; }

export const registry = { gpt_image_2 } as const;   // Phase 1 ships ONE
```

Adding tool #2 in Phase 5 is one import and one key. That is the entire extensibility claim, and it
must be literally true.

#### 4.1.3 `tools/magica-client.ts` — the adapter, one place

```ts
export async function runMagicaNode(a: {
  nodeType: string; subModelId?: string; input: unknown;
  onRunId: (id: string) => Promise<void>;          // ← checkpoint BEFORE the first poll
}) {
  const res = await fetch(`${env.MAGICA_BASE_URL}/v1/nodes/${a.nodeType}/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.MAGICA_API_KEY}`,
               "Content-Type": "application/json" },
    body: JSON.stringify({ input: a.input, subModelId: a.subModelId }),
  });
  if (res.status === 401) throw new ToolError("Magica rejected our API key");
  if (res.status === 403) throw new ToolError("Insufficient Magica credits");
  if (res.status === 429) throw new ToolError(`Rate limited, retry in ${res.headers.get("Retry-After")}s`);
  if (res.status !== 202) throw new ToolError(`Run was not accepted (${res.status})`);

  const { runId } = await res.json();
  await a.onRunId(runId);                          // ← survives a crash from here on
  return pollUntilTerminal(runId);
}
```

Contract facts that must be encoded, not assumed:
`202` not `200`; statuses `QUEUED|RUNNING|COMPLETED|FAILED|CANCELED` (one L); **403 = insufficient
credits**; prefer `userMessage` over `error` for display; `creditUsed` is microcredits.

#### 4.1.4 `trigger/magica-node-run.ts` — the typed child task

The resume rule lives in a plain exported function and the task is a one-line shell over it, so
tests exercise the real rule instead of a copy that can drift from it.

```ts
export async function executeMagicaNode(p: MagicaNodeRunPayload, sleep: Sleep) {
  // If a previous attempt already submitted, resume instead of re-submitting.
  const inv = await db.toolInvocation.findUniqueOrThrow({ where: { id: p.invocationId } });
  if (inv.magicaRunId) return { ...(await pollUntilTerminal(inv.magicaRunId, sleep)), resumed: true };
  return { ...(await runMagicaNode({ ...p, sleep, onRunId: (id) =>
    db.toolInvocation.update({ where: { id: p.invocationId }, data: { magicaRunId: id } }) })),
    resumed: false };
}

export const magicaNodeRun = task({
  id: "magica-node-run",
  retry: { maxAttempts: 1 },                       // manual retry only
  run: (p: MagicaNodeRunPayload) =>
    executeMagicaNode(p, (ms) => wait.for({ seconds: Math.ceil(ms / 1000) })),
});
```

**Three corrections against the real SDK:**
- **`retry: { maxAttempts: 1 }`, not top-level `maxAttempts`.** The latter is v3 syntax and does not
  compile against `@trigger.dev/sdk@4`.
- **`sleep` must be injected as `wait.for`**, not left to a timer — but that only suspends for waits
  **over 5 seconds**. `DURATION_WAIT_CHARGE_THRESHOLD_MS` in the SDK is 5000, and a shorter wait
  sleeps in process and is billed as compute. The poll interval is 6s for that reason; at 2s a
  two-minute node run cost two minutes of compute doing nothing, against a $5/month allowance.
- **`AgentRun.userMessageId` is required and unique**, so any fixture must create the user `Message`
  first. A run cannot exist without the message that caused it.

Verified against a live dev worker: triggering this task proves the `dirs` scan finds it, that
`lib/env.ts` parsed inside the Trigger.dev runtime, and that `prismaExtension({ mode: "modern" })`
reaches Neon — a nonexistent invocation returns Prisma `P2025`, which is a query response rather
than an init failure.

**Trigger.dev's own error surface is thin:** an uncaught throw surfaces to the API as
`TASK_RUN_UNCAUGHT_EXCEPTION` with no message and no stack. The loop must catch and convert its own
failures, or a production incident is undiagnosable from outside the dashboard.

Triggered with `idempotencyKey: invocationId`, so Trigger.dev dedups the dispatch **and** the
`magicaRunId` check dedups the external submission. Two independent guards on the one operation that
costs money.

#### 4.1.5 `trigger/run-agent-turn.ts` — the loop

A plain function with injected deps. The task shell and the tests both call it, which is why the
loop is testable without Trigger.dev.

```ts
export async function runAgentTurn(deps: Deps, { runId }: { runId: string }) {
  // 1. BOOTSTRAP (idempotent — also the retry reset path)
  const { run, chat, history } = await deps.bootstrap(runId);
  // `one_assistant_message_per_run` is a RAW partial index, so Prisma cannot `upsert` on it:
  //   try { create assistant Message } catch (P2002) { findFirst({ runId, role:'assistant' }) }
  // That is precisely why the index is partial-unique: idempotent bootstrap with no lock.

  let segment = 0, turns = 0;
  const blocks: ContentBlock[] = [];

  while (turns++ < env.MAX_TURNS) {
    const stream = streamText({
      // `.chat(id)`, never `openrouter(id)` or `.languageModel(id)`: the first declared overload
      // returns OpenRouterCompletionLanguageModel, so TS infers the wrong class even though the
      // runtime hands back a chat model.
      //
      // Reasoning MUST be requested here. v7 has a top-level `reasoning` call option, but this
      // provider's getArgs() never destructures it — pass it to streamText and you get no thinking
      // tokens and NO error. Model-level is typed; `providerOptions.openrouter` would also work and
      // wins over this if both are set.
      model: openrouter.chat(run.modelId, { reasoning: { enabled: true, effort: "medium" } }),
      messages: toModelMessages(history, blocks),
      tools: toAiSdkTools(registry, ctx),
      stopWhen: [stepCountIs(env.MAX_STEPS), hasToolCall("submit_plan"),
                 hasToolCall("ask_questions")],
    });

    let textOpen = false;
    for await (const part of stream.fullStream) {
      switch (part.type) {
        case "text-delta":                          // v7 carries `.text`
          await deps.agentText.append(part.text);
          textOpen = true; bufferText(part.text);
          break;
        case "reasoning-delta":
          reasoning += part.text;
          await deps.metadata.set({ reasoningText: reasoning });   // live Thinking row
          break;
        case "reasoning-end":
          blocks.push({ segment, type: "thinking", thinking: reasoning,
                        durationMs: Date.now() - reasoningStartedAt });
          await deps.persistBlocks(blocks);
          reasoning = "";
          break;
        case "tool-call":
          if (textOpen) { closeTextBlock(); segment++; textOpen = false; }
          blocks.push({ segment, type: "tool_use", id: part.toolCallId,
                        name: part.toolName, input: part.input });   // v7: `.input`, not `.args`
          await deps.persistBlocks(blocks);         // progressive persistence
          await deps.metadata.set({ phase: "working",
                                    currentStep: registry[part.toolName].display.label,
                                    blocks: project(blocks) });
          break;
        case "error":
          throw new StreamErrored(part.error);      // mid-stream SSE errors don't throw themselves
      }
    }

    // 2. USAGE — v7 types every field as `number | undefined`, so normalize HERE, once.
    // All-or-nothing: both counts present → record them; otherwise leave tokenUsage null and append
    // no usage block. `?? 0` would satisfy the schema by rendering "0 tokens" in the assistant
    // footer, which is a wrong number rather than a missing one. The contracts already model absence
    // (`MessageDTO.tokenUsage` is nullable, `RunMetadata.tokenUsage` optional, and the `usage` block
    // is simply not emitted), so nothing downstream needs a sentinel.
    const u = await stream.usage;
    const usage = u.inputTokens !== undefined && u.outputTokens !== undefined
      ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens }
      : null;

    // 3. EMPTY-STREAM GUARD — one cheap in-process retry, then fail safely
    if (!producedText && !producedToolCalls) { if (!retried) { retried = true; continue; }
                                               return deps.finalizeFailed("empty response"); }

    // 4. WAITPOINT — task level, never inside a live stream
    // An interaction tool has NO `execute`, so v7 emits the call and ends the step; `stopWhen` halts
    // the loop. The resolution MUST go back as a tool-result message or the model repeats the call.
    // suspendOn() MUST metadata.flush() BEFORE wait.forToken: Trigger.dev BATCHES
    // metadata writes, so a bare set() may not have left the machine when the run suspends. A client
    // reloading during the wait would then see phase:'working' with no waitpoint and render NO
    // approval card, against a run that sits for 15 minutes with no way to resolve it. Invisible in
    // local dev, where suspend is fast. Flush again after writing the resolution.
    if (pendingInteraction) { const resolution = await deps.suspendOn(pendingInteraction);
                              history.push(toolResultMessage(pendingInteraction, resolution));
                              segment++; continue; }
    break;
  }

  // 4. FINALIZE — one transaction
  await deps.finalize({ blocks, assets, tokenUsage });   // + refundAdmission ALWAYS
}
```

The `deps` seam is what makes this testable: `bootstrap`, `startStream`, `appendText`,
`setMetadata`, `flushMetadata`, `persistBlocks`, `suspendOn`, `recordResolution`, `finalize` and
`finalizeFailed` are all injected. Unit tests pass fakes and assert block order, segment increments
and which finalize ran **without Trigger.dev, without Postgres, without OpenRouter**.

**Three refinements over the sketch above.**

`startStream` is injected and yields a narrow `TurnStreamPart` union — the adapter that wraps
`streamText` maps the SDK's parts onto it and drops the rest, so provider and SDK naming churn lives
in one file instead of in the loop, and the loop needs no network to test.

**Nothing throws out of `runAgentTurn`.** It returns `{ status, turns, segments, reason? }` and
converts every failure through `finalizeFailed`, because Trigger.dev reports an uncaught throw as
`TASK_RUN_UNCAUGHT_EXCEPTION` with no message and no stack. `AppError`/`ToolError` messages are
user-safe and pass through; anything else becomes one generic sentence, so provider text cannot reach
a client. Exactly one of `finalize`/`finalizeFailed` runs on every path — both refund the admission
hold, so an escaping error would leave it charged forever.

`metadata.flush()` sits in the loop immediately before `suspendOn` rather than inside it, so the
ordering is visible where the decision is made and assertable at this layer.

#### 4.1.5a `trigger/turn-state.ts` — the two rules that are easy to get wrong

Extracted so the block accumulator is testable without the loop. It owns exactly two rules.

**Segments.** A closed `text` block ends a step group; reasoning rows and tool rows are counted
*inside* a group. Implemented as a queued break applied by the next block rather than an eager
`segment++`, which is what stops a turn ending on text from opening a group nothing will ever fill.
Two bugs fell out of testing it: `segments()` counted the queued break, so a plain text answer
reported two groups; and the `usage` footer took the break, rendering a step group whose only row was
a token count. `usage` now joins the current group and never consumes a break.

**Stream offsets.** Only `text` blocks consume the agent-text stream, so only they carry `chars`.
The earlier rule summed `chars` over "text and thinking" blocks — but reasoning travels as
`RunMetadata.reasoningText` and is persisted as a `thinking` block, never appended to the stream
, so counting it would offset every following text block by the length of the thinking
transcript and render garbled prose. Corrected in the contract and here.

`projection()` is bounded to the newest 60 rows because `RunMetadata.blocks` caps at 60 and a
rejected snapshot would take the whole turn down; the complete timeline is read back over REST.

#### 4.1.6 The orchestration wrapper (in `to-ai-sdk.ts`)

Every tool goes through the same wrapper. Tools stay pure; all persistence and money live here.

```
1. run still active?           → cancel guard: abort without charging
2. input.parse(args)           → on failure: descriptive tool-error back to the model (it self-corrects)
3. INSERT ToolInvocation(running)
4. chargeTool(estimate)         ← BEFORE execute. Insufficient → tool-error, model wraps up gracefully
5. execute(input, ctx)
6. output.parse(result)
7. UPDATE invocation(completed) + metadata.set(invocations)
   on throw → UPDATE invocation(failed) + refundToolCharge + tool-error to the model
```

Step 4 before step 5 is the whole mid-turn-exhaustion story, and it means there is never a
late-settle race.

**Four things the sketch above does not say.**

**Failures come back as data, not as exceptions.** `execute` returns
`{ ok: true, data } | { ok: false, error, retryable }`. A blocked prompt is a normal path, so the
model always has something readable to react to rather than depending on SDK error plumbing. Only
`ToolError` and `AppError` copy passes through; a raw provider error becomes one generic sentence.

**Bad arguments create no invocation row.** Parsing happens before the INSERT, so a call the model
immediately self-corrects leaves no failed card on the timeline — which is what the reference does.

**Remote work goes through the child task, and did not before.** `gpt_image_2` called
`runMagicaNode` inline, so `magicaNodeRun` — and its resume-not-resubmit guard, and its four passing
tests — had **zero callers**. A replayed step would have submitted to Magica a second time, paying
twice out of a ~28-credit budget, and the agent machine held a CPU for the whole 120-second poll
instead of suspending. Remote work is now `ctx.runNode`, implemented by `tool-runtime` as
`magicaNodeRun.triggerAndWait(payload, { idempotencyKey: invocationId })`. Trigger.dev dedups the
dispatch, the child's `magicaRunId` check dedups the submission — the two independent guards §4.1.4
claims are finally both live. `ToolCtx.recordExternalRef` is gone: `runNode` is the one checkpointed
path, and a second way to do it is a second way to get it wrong.

**`ctx.reportCost` is how the real price gets out of a tool.** `runMagicaNode` returns `creditUsed`
and the tool was discarding it, so `reconcileToolCharge` had no production caller either. The tool
now reports it and `completeInvocation` reconciles, in its own transaction, swallowing an
uncollectable shortfall.

#### 4.1.6a `trigger/tool-runtime.ts` — the effects half of that seam

`toAiSdkTools` holds the ordering; this holds every effect it orders. `isRunActive`,
`beginInvocation` (upsert on `(runId, toolUseId)`, so a replay reuses its row and
`charge:{invocationId}` stays a stable key), `chargeEstimate` (charge + write the estimate onto the
card in one transaction), `runNode`, `completeInvocation`, `failInvocation` (refund + zero the card).

`publish` is injected rather than calling `metadata.set` directly, so the module runs outside a
Trigger.dev run — which is what lets `tests/integration/tool-runtime.test.ts` drive the whole money
path against real Postgres and MSW, replacing only the dispatch. It proves: estimate charged then
settled to the provider's figure, a failed step refunded to the exact starting balance, **no Magica
submission at all when the estimate cannot be charged**, no invocation on a cancelled run, one
charge and one submission across a replay, and an uncollectable shortfall that stops at zero without
failing the completed step. `balance === SUM(ledger)` after every one.

**The window this leaves, stated plainly:** `chargeTool` commits in its own short
transaction; `execute` is a network call outside any transaction. Crash in between and the charge
stands with no work done. This is **recovered, not prevented** — the retry reset path cancels and
refunds non-terminal invocations, so it clears when the user retries. Worth knowing
because it reads like a hole, and because the obvious "fix" (charge after execute) reintroduces the
late-settle race the ordering exists to prevent. Charging first stays correct; the compensating
action closes the window.

**DoD (demo this to yourself before moving on)**
- Send a prompt → `202`-shaped `SendMessageResult` in <300ms
- Trigger.dev dashboard shows the run; tool card appears; asset URL persists
- **Reload the browser mid-run → messages come from REST, stream resubscribes from chunk 0, run completes**
- Kill the Trigger.dev dev CLI mid-poll, restart → it resumes the **same** Magica run (check `magicaRunId`)
- `balance === SUM(ledger)` after a completed turn; net cost = the tool charge only
- Double-click send → `409 RUN_ALREADY_ACTIVE`, one run in the DB

**Tests**
| Kind | Test |
|---|---|
| unit | `runAgentTurn` with fakes: block order, `segment` increments on text→tool, MAX_TURNS cap, empty-stream retry, usage all-or-nothing, flush-before-suspend, no throw escapes |
| unit | `turn-state`: segment breaks, stream offsets, reasoning never on the stream, 60-block cap |
| unit | `to-ai-sdk`: the call order IS the assertion — charge before execute, nothing charged for work that never starts, failures as data, interaction tools have no `execute` |
| integration | `tool-runtime` on real Postgres: charge→settle, refund on failure, no submission when unaffordable, replay charges once, shortfall stops at zero |
| unit | credits: reserve→charge→refund invariant; double-charge is a no-op; negative balance impossible |
| unit | `magica-client`: 202/401/403/429/timeout/FAILED mapping |
| integration | send route: happy path, 409 on active run, 400 on bad model, 402 on no credits |
| integration | resume: pre-set `magicaRunId` → child task polls, does not re-submit |

---

### Phase 2 — Reliability & the failure matrix · ~5h

**Goal:** every row of `ARCHITECTURE §5` demonstrably behaves as written, and every failed turn is
explainable from the UI alone.

**Files** — `run.service.ts` (cancel + state machine + stale-lock), `messages/[id]/retry/route.ts`,
`runs/[id]/cancel/route.ts`, `credits` routes, `prisma/seed.ts`.

**Build**
1. `assertTransition(from,to)` — one map. Illegal jumps throw, so a bug cannot resurrect a terminal run.
2. **Cancel**, in this order: status flip → `runs.cancel` → message cancelled keeping partials →
   **sweep pending waitpoints to `expired`** → `refundAdmission`.
3. **Retry** — only from `failed`/`cancelled`; `attempt+1`; resets the assistant row (clear blocks,
   cancel + refund non-terminal invocations).
4. **Stale-lock recovery** — never infer liveness from timestamps. `triggerRunId IS NULL` and >90s
   → dead, refund, admit. Otherwise `runs.retrieve()` and trust Trigger.dev.
5. Rate limit on send (Postgres UPSERT counter) → `429` + `Retry-After`.
6. `prisma/seed.ts` — makes `migrate reset` cost 10 seconds instead of your demo data.
7. `POST /credits/top-up`, keyed on an `Idempotency-Key` header, so a turn stopped by exhausted
   credits has a way forward and the ledger is exercised upwards as well as down.
8. `lib/llm-status.ts` + `GET /llm/status` — `ARCHITECTURE §5` row 1 promises
   `LlmStatus.rateLimitedUntil` on an OpenRouter 429. The cooldown comes from the provider's
   `Retry-After` where it sends one. Recorded through a callback injected into `createStreamStarter`,
   alongside `onRequest`: the classifier `describeStreamError` stays a pure function, and the write is
   telemetry that must never fail a turn.

**DoD** — every §5 row reproducible on demand; a failed turn shows error text + partial output +
tool outcomes + Retry; cancel leaves no `pending` waitpoint; logs carry all six keys.

Two §5 rows cannot be met in this phase and are not defects: waitpoint-unanswered needs Phase 4, and
attachment limits need the uploads of Phase 6.

`chatId` is bound inside the service rather than at the route for cancel and retry, because the route
is addressed by run id and message id respectively and only learns the chat once the row is loaded.

**Tests** — integration per §5 row; the acceptance list's 401/429/timeout/failed-run/duplicate-dispatch.

---

### Phase 3 — Skills · ~3h · explicitly tested

**Goal:** on-demand guidance the model fetches itself, with the seven tests the scope authority names.

A skill is versioned guidance for a class of work. It is not executable and it is never loaded into
every prompt. Skills guide the model; ordinary typed tools perform the side effects.

**Files** — `lib/skills/{scan,load}.ts`, `tools/{load-skill,read-skill-asset}.ts`,
`agent-skills/*/SKILL.md`, `prompts/system.ts` (+ L1 index), `tests/fixtures/bad-skills/`.

**Build**
- Startup scan of `agent-skills/`, **resolved from package root not `cwd`** — otherwise the registry
  is empty in the Trigger.dev bundle while working perfectly in dev. Ship the directory via
  `trigger.config.ts` external files.
- `gray-matter` → `SkillMeta.parse` → reject duplicate names → 64 KB cap → `sha256`.
- L1: `name: description` pairs in the system prompt. L2: `load_skill`. L3: `read_skill_asset` with
  the containment check `abs.startsWith(resolve(dir, name) + path.sep)` — **the `+ path.sep` matters**,
  without it `skills/foo-evil` passes a check meant for `skills/foo`.
- `RunSkill` upsert on `(runId, skillName, assetPath)` with `assetPath` defaulting to `""` **not null**.
- **Three skills**, which is the stated minimum and also the cheapest compliant number:
  `image-editing` (carrying an asset, so `read_skill_asset` has a real target), `video-production`,
  `media-planning`. `capabilities` is **not** among them — "what can you do" is every-turn context,
  not a class of work, and behind a loader it would spend a request on the cheapest kind of turn.

**Cost control — a load is one OpenRouter request against 50/day**
A tool result is only visible on the next request, so every load costs one. Caching the file read
changes the rendered duration, not the count. Three bounds, cheapest first:
1. Three skills, not more.
2. Base-prompt rules: load only for the named class of work; never for a greeting, a capability
   question, or anything answerable without it; never load the same skill twice.
3. `MAX_SKILL_LOADS_PER_TURN` (default 2), counted as distinct `RunSkill` rows for the run. A **new**
   skill past the budget returns a `ToolError` so the model proceeds with what it has; a **repeat**
   load is a dedup, never counts, never errors.

**DoD** — three skills load; the L1 index carries only names and descriptions; a turn needing no
skill loads none; the seven named tests pass.

**Tests — the seven the scope authority names, by name**
`selective loading` · `malformed frontmatter` · `duplicate skill names` · `unknown skill` ·
`path traversal` · `deduplication` · `durable resume`.
Numbers 3 and 6 are different mechanisms — a startup check across directories, and a per-run write.

---

### Phase 4 — The waitpoint machinery · COMPLETE

**Goal:** the interaction machinery — generic, so a second kind costs a registry entry. Both kinds
shipped together, which is the only way that claim gets tested rather than asserted.

**Files** — `tools/{submit-plan,ask-questions}.ts`, `agent/interaction.ts`,
`services/waitpoint.service.ts`, `app/api/v1/waitpoints/[waitpointId]/resolve/route.ts`, `suspendOn`
in the task shell. Named `waitpoint.service`, not `approval.service`: a mechanism that must not know
what a plan is should not be named after one kind.

**Built**
- `submit_plan` per **§3.2b**: `steps[].toolCall` is **required**; `prepare` parses each step's input
  with that tool's own schema and prices it via that tool's own `credits()`. **The model never states
  a cost** — a figure it supplies is stripped by the schema and never reaches the card.
- `defineTool.prepare(input, {price, balance})` is the seam that allows it: it returns either the
  payload to park on, or a resolution that makes parking pointless. An unpriceable step comes back as
  `{approved:false, feedback}` so the model re-plans in the same message; the alternative was killing
  a turn over a mistake the model can fix. A tool with no `prepare` parks on its input, which is all
  `ask_questions` needed.
- `LIMIT_EXCEEDED` is raised **before** any row or token exists, so a plan nobody could afford leaves
  no card behind — it ends the turn with both figures in the message.
- `suspendOn`: `prepare` → `beginInvocation` → `wait.createToken({timeout:'15m',
  idempotencyKey:`wp-${invocationId}`})` → INSERT `Waitpoint` → run `waiting` →
  `metadata.set({phase:'waiting', waitpoint})` → `flush()` → `wait.forToken` → close the row
  conditionally → run `running` → `completeInvocation(output=resolution)`.
- The interaction gets a `ToolInvocation` row like any other step. Without one the card had no
  duration, no `Result:` row and nothing at all after a reload, and `Waitpoint.invocationId` was a
  column written nowhere.
- Resolve route: `ResolveWaitpoint.parse` → ownership inside the lookup → **reject a `kind` mismatch**
  → conditional `UPDATE … WHERE status='pending'` → only on a won update,
  `wait.completeToken(id, resolution)`. 0 rows → already answered (`{ok}` no-op) or expired
  (`WAITPOINT_EXPIRED`, 410).
- Plan mode is a system-prompt section keyed off the new `AgentRun.planMode`. The send route had been
  writing `executionMode='step_by_step'` from it, which is a different thing: plan mode is how a turn
  **starts**, `executionMode` is how an approved plan **runs** and comes from the approval.

**DoD** — plan card renders with **server-priced** chips ✅ · approve resumes the same run ✅ (proven
against a real waitpoint token in dev, not in a deployed task) · reject with feedback re-plans in the
same message ✅ · a double-clicked resolve is a no-op ✅ · expiry clears the overlay and the model
wraps up ✅ · `LIMIT_EXCEEDED` fires at plan time ✅.

**Deferred on purpose:** `run.executionMode` is not written from the resolution. Nothing reads it
until step-by-step mode ships in Phase 6, and a column written before it is read is the dead-column
pattern this repo keeps finding. The model is told what to do with `step_by_step` by `submit_plan`'s
own description.

---

### Phase 5 — Tools 2–4 + chat management · ~4h · the widening

Pure additive. **If any of this requires touching `run-agent-turn.ts`, stop — a seam is missing.**

- `crop_image` — Zod `.superRefine`: a complete percent rect **or** a complete pixel rect; reject
  partial sets and mixed units. The catalog marks no coord field required, so this validation is
  entirely ours. **Every coordinate stays optional with no Zod default**: the catalog defaults the
  percent fields to a full frame, so applying those defaults would turn a coordinate-less call into a
  valid whole-image crop and the model would get a picture back instead of an error it can correct.
  Percent rectangles are also bounds-checked (`x + width <= 100`); pixel ones cannot be, because the
  image's dimensions are not known until it is fetched.
- `merge_videos` — `video_urls` 2–100 (our bound, not the catalog's), order preserved and never
  de-duplicated, `transition` enum. Priced `per_minute`, and output length is unknown before the
  merge runs, so the estimate scales with the number of inputs and is reconciled against what the
  provider reports. Its poll ceiling is raised per call, which is what `timeoutMs` on the child-task
  payload exists for.
- **A new node type needs a row in the committed fallback price table**, not only the live catalog.
  `estimateMicrocredits` throws on an unpriced node, so without one a catalog outage turns every call
  to that tool into a failed turn instead of a charged one.
- `get_model_schema` — cached per process; always render the duration (7 ms cache hit vs 3.7 s cold).
- `GET /chats` with `?cursor&search&filter`; `PATCH`/`DELETE /chats/:id`; message pagination via
  `messagesCursor`.

**DoD** — each tool succeeds live once; a chained conversation crops a generated image; invalid input
produces a tool-error the model recovers from; chat list pages with no offset scan (check the plan).

---

### Phase 6 — Deferred-by-design · ~8h · take in this order, stop anywhere

Ordered by value per hour. Every item is independent.

| Order | Item | Why here |
|---|---|---|
| 1 | ~~`ask_questions` + resolve payload~~ — **backend done in Phase 4**; the question panel is FE | required (p109) |
| 2 | Uploads: `/uploads/sign`, `/attachments`, quota | `attachmentIds` already validated; biggest single chunk |
| 3 | Step-by-step + `update_step` | reads/writes `activePlan`; auto mode untouched |
| 4 | Media library, files-in-task, attachment PATCH/DELETE | routes over an existing table |
| 5 | `/messages/:id/feedback`, `/llm/status` | one column, one row |

---

### Phase 7 — Bonus · only if Phases 1–5 are genuinely done

Public API (`ApiKey` hashed, versioned `/api/public/v1`), signed webhooks (HMAC-SHA256 with
`svix-id`/`svix-timestamp`/`svix-signature`, mirroring Magica's own scheme), Mintlify from
`scripts/gen-openapi.ts`. Tables already exist — **no migration on Day 3.**

---

## 5. Test strategy

Target: **~15 unit · ~8 integration · 3 acceptance · 2 E2E.** Not a coverage number — these specific things.

| Layer | Runs against | Rule |
|---|---|---|
| unit | fakes | `runAgentTurn` with injected deps. No DB, no network |
| integration | real Postgres + **MSW** | `onUnhandledRequest: "error"` — a real network call in CI is a failing test |
| acceptance | real Magica + real OpenRouter | env-gated, **run ONCE**, Day 3 morning. ~10 of the 50 daily requests |
| E2E | Playwright | one happy path. Reload-recovery is a recorded manual check |

**Two suites guard things that are invisible until they break.** `tests/integration/api.test.ts`
covers the request boundary — 401, malformed JSON, schema failure, an `AppError` keeping its status,
an unexpected throw leaking nothing, CORS on both a success and an error, a BigInt on the wire, and
the account bootstrap under three racing callers. `tests/integration/schema.test.ts` asserts the
hand-written indexes still exist, because `migrate dev` has already reverted them once and a missing
partial unique index is a correctness bug, not a slow query.

**MSW handlers are GENERATED from the contracts, not hand-authored.** Hand-written
handlers drift from the Zod schemas, and at that point integration tests pass against a fiction.
Build response bodies from the same schemas the routes parse. Magica fixtures seed from the archived
live catalog rather than from memory, so the mocks match the real API by construction.

Related: AI SDK v7 streams tool input as `tool-input-start` / `tool-input-delta` (field
`inputTextDelta`) / `tool-input-end`, **and** emits a final `tool-call` carrying the complete `input`.
We handle only `tool-call`, so there is no partial-argument assembler to write.

**OpenRouter budget (50/day, hard). Free-tier OpenRouter is the only permitted path to a model.** All automated tests = **0 requests**. Dev
checks <=20/day. Acceptance ~10, once. Demo ~20 headroom, recorded right after the daily reset.

**The caps bound a runaway, they do not ration normal use.** A one-tool turn costs two requests and a
two-tool turn three, whatever `MAX_TURNS` and `MAX_STEPS` are set to. What consumes the day is the
number of turns run, so the caps exist to stop a loop bug or a tool-calling model from spending it in
one go. Defaults are **`MAX_TURNS` 3 x `MAX_STEPS` 4 = 12** worst case, and `lib/env.ts` now
`superRefine`s the product against `OPENROUTER_DAILY_REQUESTS`: a pair that lets one turn spend more
than half the day fails at boot, naming both variables and printing the arithmetic. The
"raise one, never both" is therefore enforced rather than remembered.

**Step 5b owes the counterpart: make the spend observable.** Nothing today counts actual requests —
the inner tool rounds happen inside `streamText`, so the loop cannot see them. The adapter must pass
`onStepFinish` and count, then log the total per turn, or a runaway is only visible as a 429 the next
day.

---

## 6. Ten decisions worth knowing

The choices most likely to be questioned, and the reason each was made.

1. **Charge before execute.** Catches exhaustion before external cost; no late-settle race.
2. **Admission always refunded in full.** Net turn cost = Σ tool charges. The earlier
   reserve/settle/refund-remainder model double-charged.
3. **`magicaRunId` checkpointed before the first poll.** The one guard that stops paying twice after a crash.
4. **Partial unique index for one-active-run.** The lock is a database constraint, not application code.
5. **`idempotencyKey = {userMessageId}:{attempt}`.** Dedups dispatch without ever blocking a legitimate retry.
6. **Manual retry only (`maxAttempts: 1`).** Auto-retry duplicates narrative and re-runs paid work,
   because regenerated tool ids never match. The PDF agrees: "retry only when safe."
7. **Postgres is truth; realtime is a preview.** Test: could a fresh browser rebuild this screen now?
8. **`segment` increments on text-block close.** Reproduces the reference's repeated step groups
   A waitpoint-only rule would collapse a 10-step turn into a single group.
9. **The server prices plan steps; the model never states a cost.** Otherwise the credit chips are
   model-invented numbers on the credits criterion.
10. **Never infer liveness from timestamps.** A run suspended 14 minutes on a waitpoint looks stale
    and is perfectly healthy. Ask Trigger.dev.

---

### Why the agent lives in `src/agent/`, not `src/trigger/`

`dirs: ["./src/trigger"]` makes Trigger.dev build **every** file in that directory as its own entry
point, whether or not it exports a task. Keeping the loop, the accumulator, the adapter and the tool
runtime there meant four extra bundle entry points for nothing, and the directory stopped telling
you what was actually a task. `src/trigger/` is now task definitions only; the implementation they
bind sits in `src/agent/`.

### The pino transport that breaks the task build

`pino({ transport: { target: "pino-pretty" } })` runs the transport in a **worker thread**, which the
runtime resolves from `pino/lib/worker.js`. That path does not exist inside Trigger.dev's flattened
bundle, so any task whose import graph reaches the logger fails to build — and the only symptom is:

```
Error: Build failed: Uncaught exception:
Cannot find module '<buildDir>/lib/worker.js'
```

Nothing in that message mentions pino, the task files all compile and are emitted, and `tsc`,
`eslint`, `next build` and 143 tests are all green. It is only reproducible through
`pnpm trigger:dev`. The logger now emits plain JSON with no transport; both places these logs are
read — the Trigger.dev dashboard and Vercel — parse JSON anyway.

**The general lesson, which is the reusable part:** a task's whole import graph is executed at index
time, so anything that spawns a thread or a subprocess at module scope breaks the build rather than
the run. `pnpm trigger:dev` is the only check that catches it, and it belongs in every phase's DoD
from here.

## 7. Traps in this stack

| Trap | Symptom | Guard |
|---|---|---|
| No `prismaExtension` in `trigger.config.ts` | works in dev, task crashes in prod | Phase 1 config |
| `agent-skills/` resolved from `cwd` | empty registry in production only | resolve from package root + external files |
| Vercel deploy alone | tasks silently stale | **two deploys, every time**: `npx trigger.dev deploy` |
| `import` (not `import type`) the task in a route | Prisma bundles into the route | `import type` |
| `JSON.stringify` a BigInt | throws at runtime | credits are strings on the wire, one conversion point |
| `channel_binding=require` | Prisma may object | drop that param only if it complains (psql was fine) |
| Neon scale-to-zero | first query after idle is slow | warm the app before recording the demo |
| 10 concurrent realtime connections (free tier) | dropped subscriptions | close on unmount; one browser tab for the demo |
| Trigger.dev env vars set to only the obvious three | **every** task crashes at boot with a Zod error | tasks import `lib/db.ts` → `lib/env.ts`, which parses the **whole** schema at import. The dashboard needs every non-optional variable — including `DATABASE_URL_UNPOOLED` and `FRONTEND_URL`, which a task never uses |
| `prisma generate` in `postinstall` reading config through Prisma's `env()` | `pnpm install` fails on a fresh clone with no `.env` | `prisma.config.ts` resolves the URL permissively; `lib/env.ts` is what fails by name, at app boot |
| A ledger idempotency key that omits the attempt | a retried turn holds **no** admission and can never be refused for credits | `reserve:{runId}:{attempt}`. A retry reuses its run row, so a key of `reserve:{runId}` alone reads as already applied and the second hold silently no-ops |
| Rebuilding a refund key instead of reading the ledger | a hold taken under one key format is never returned | `refundAdmission` reads the run's `reserve` rows and reverses each, so it cannot disagree with what was actually held |
| `undefined` in a Prisma update for a `Json?` column | means "leave unchanged", so a reset keeps the previous attempt's output | `Prisma.DbNull` writes SQL NULL; `Prisma.JsonNull` writes the JSON literal `null`, which readers then have to special-case |
| Judging a suspended run by its age | a healthy run parked on a waitpoint is declared dead, refunded, and a second turn admitted beside it | never infer liveness from a timestamp. Age is only consulted when `triggerRunId IS NULL` — there is nothing to ask about. Otherwise ask Trigger.dev, and treat the call *failing* as "still alive" |
| `pnpm check:wiring` reporting a same-file export as test-only | reads as a wiring bug when the function has real callers in its own module | the checker counts cross-file references. Confirm by grep before acting on it |
| A ledger key built from a **client-supplied** idempotency key alone | two users choosing the same `Idempotency-Key` collide; the second silently gets nothing and a stale balance | scope it by user: `top_up:{userId}:{clientKey}` |
| A test asserting a literal id that lands in a `@unique` column | passes once, then poisons every later run — a suite killed before `afterAll` leaves the value behind | mint globally unique ids in the mock (`randomUUID`), and assert against the value the response returned, not a literal |
| A test asserting an exact registry membership or count | the next phase that adds a tool fails it | partition by `tags`, assert `arrayContaining` for what must be present. A test that hard-codes a name or a total it does not own has an expiry date |
| Resolving a shipped data directory with a fixed number of `..` hops | works in the repo, breaks in a bundle — a bundler flattens compiled chunks, so the file's depth below the package root is not a constant | search upward for the directory from `import.meta.dirname`, bounded, and **throw** when it is absent. An empty registry is the silent failure the search exists to prevent, so it must never be the fallback |
| Assuming a deploy-only build extension cannot be checked locally | a real gap ships unverified | `trigger.dev deploy --dry-run` builds the full deploy bundle without deploying and prints its path. Inspect it. `additionalFiles` is a no-op in dev because dev runs from source, so the dry run is the *only* local way to see it |
| A field whose name promises more than it holds | a client wires the model pill to `lastRoutedModel` and shows null until something breaks, then the name of the model that *failed* | it was only ever written on a rate limit. Renamed `limitedModel`, and the three model questions are answered by three different places: configured = `ChatDTO.modelId`, served = `MessageDTO.aiModel`, available = `LlmStatus` |
| A column read everywhere and written nowhere | `MessageDTO.aiModel` was in the schema, the select, the DTO and the contract, and always null | write it at *bootstrap*, not finalize, so a turn that crashes still names the model that was working on it |
| `wait.forToken` left on its default timeout | a turn parks for 10 minutes when the design says 15, and the discrepancy only shows up as a waitpoint that expired early | the default is 10m and is not stated at the call site. Ours passes `timeout: "15m"` explicitly |
| An interaction tool with no `ToolInvocation` row | the plan card has no duration, no result and vanishes on reload, because the persisted timeline renders from invocations | park inside the same begin/complete pair every other tool uses. It also fills `Waitpoint.invocationId`, which was otherwise a column written nowhere |
| A run parked on a waitpoint left in `running` | `ActiveRun.status` declares `waiting` and nothing ever writes it, so a client cannot tell a thinking turn from one that is asking a question | flip to `waiting` when the token is minted and back to `running` when it resolves, both conditional on a non-terminal status so a cancel is not undone |
| Unconditional writes when the task wakes up | a cancel that swept the row to `expired`, or a resolve that already landed, is overwritten by the task finishing its own bookkeeping afterwards | every post-park write is `updateMany … WHERE status='pending'` / `WHERE status IN (non-terminal)` |
| A client able to send the server's own resolution variant | `{expired:true}` is in `WaitpointResolution`, so a client could expire its own waitpoint through a path that skips the timeout | the route parses `ResolveWaitpoint`, which has no expiry variant. The union is only assembled where the server writes it |
| A fixed number of `..` hops to a shipped data directory | the bundle puts `agent-skills/` at its root and the compiled task two levels down at `src/trigger/`, so three hops lands outside the bundle entirely — measured, not guessed | search upward from `import.meta.dirname`, bounded, and throw when absent. `findSkillsDir` is extracted so a test can assert the real bundle layout |

---

## 8. Open questions

Decisions this document does not make. Each is scoped so it can be answered without reopening
anything above it.

**Model rotation on upstream rate-limiting.** Free-tier models are rate-limited by their upstream
providers independently of our own request budget, and two of the three in `ALLOWED_MODELS` were
unavailable when last exercised. Rotating to the next entry in the allowlist on a `429` is not a paid
fallback and would materially improve reliability. Against it: it makes a turn's served model
non-deterministic, which `Message.aiModel` records but a user does not choose. Unresolved.

**Per-send model selection.** `SendMessage.modelId` is honoured when a chat is created and ignored
afterwards, because the chat's stored `modelId` wins. The three options are to persist it to the chat
on each send, to reject a mismatch, or to drop the field from the send contract and make the model a
chat-level setting only. Silently ignoring it — the current behaviour — is the one option that is
clearly wrong.

**`attachmentIds` before uploads exist.** The send contract accepts up to five and the route ignores
them until Phase 6. Rejecting them with `VALIDATION_ERROR` until the feature lands is more honest than
accepting and discarding.
