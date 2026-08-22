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

Why: the grading weights are Architecture 25% · Reliability 20% · Fidelity 20% · Code quality 15% ·
**Features 10%** · Polish 10%. A narrow path with real idempotency, real failure handling and real
recovery outscores a wide surface of half-features. Feature completeness is the *cheapest* criterion
to lose points on.

### What makes later phases safe

The HLD already put extension seams in the right places. **These are the reason Phases 4–7 cannot
break Phase 1–3 code.** Every deferred item below plugs into a seam that ships in Phase 1:

| Seam | Shipped in | Later phases add | Orchestration edits needed |
|---|---|---|---|
| `registry` object (`tools/registry.ts`) | 1 | tools 2–7 | **zero** — one entry each |
| `interaction?: WaitpointKind` + `WaitpointResolution` union | 4 | `questions` kind | **zero** — one entry + one union variant |
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
| `questions` waitpoint (`ask_questions`) | the interaction wrapper is kind-agnostic from Phase 4 | 6 |
| Step-by-step mode + `update_step` | `activePlan` column + a system-prompt branch; auto mode unaffected | 6 |
| Uploads (Transloadit + `/uploads/sign` + `/attachments`) | `attachmentIds: []` is valid; nothing reads attachments until they exist | 6 |
| Search, pin, filter, bulk delete | additive query params + `PATCH`/`DELETE` on an existing route | 5 |
| Media library, files-in-task modal, attachment rename/delete | new routes over an existing table | 6 |
| `/messages/:id/feedback`, `/llm/status` | leaf routes, one column / one row each | 6 |
| Public API, signed webhooks, Mintlify | tables exist from migration #1 | 7 |
| `credit_approval`, `media_selector` kinds | **declined** — see decisions #43 | — |

### Non-deferrable — do not be tempted

| Must be in Phase 1–2 | Why |
|---|---|
| Credits ledger (`lib/credits`) | the send route reserves admission in the same transaction as run creation. Retrofitting money into a live write path is how double-charges are born |
| Idempotency keys | `AgentRun.idempotencyKey`, `charge:{invocationId}` etc. are unique **constraints**. Adding them later means backfilling and a migration against real rows |
| Progressive persistence | partial-output-survives-crash is a graded requirement; bolting it on means rewriting the loop |
| `defineRoute` wrapper | auth + Zod + error envelope + traceId in one place. Written after 10 routes = 10 inconsistent routes |
| Structured logging | the six required keys must be bound at bootstrap. Retro-fitting loses the correlation |

---

## 1. Repo layout with responsibilities

```
magica-backend/
├── prisma/
│   ├── schema.prisma                  Phase 0 — full schema, all tables, migration #1
│   ├── migrations/                    + 2 raw-SQL migrations (partial unique indexes, pg_trgm)
│   └── seed.ts                        Phase 0 — demo user + chats. MOVED from Phase 2 (dry-run F14):
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
│   │   ├── approval.service.ts        Phase 4 — waitpoint resolve, conditional UPDATE
│   │   └── attachment.service.ts      Phase 6
│   ├── lib/
│   │   ├── env.ts                     Phase 0 — Zod over process.env, throws at boot
│   │   ├── db.ts                      Phase 0 — PrismaClient + adapter-pg singleton, max:5
│   │   ├── api.ts                     Phase 0 — defineRoute()
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
│   │   ├── ask-questions.ts           Phase 6
│   │   └── update-step.ts             Phase 6
│   ├── trigger/
│   │   ├── agent-turn.ts              Phase 1 — 3-line task shell
│   │   ├── run-agent-turn.ts          Phase 1 — ★ the loop, plain fn with injected deps
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
  z.object({ ...base, type: z.literal("reasoning"), reasoning: z.string() }),
  z.object({ ...base, type: z.literal("tool_use"),  id: z.string(), name: z.string(),
                                                    input: z.unknown() }),
  z.object({ ...base, type: z.literal("tool_result"), toolUseId: z.string(),
                                                    summary: z.string().optional() }),
  z.object({ ...base, type: z.literal("citations"), items: z.array(
                z.object({ title: z.string(), url: z.string().url() })) }),
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
  chars:     z.number().optional(),   // EXACT character count of a CLOSED text/thinking block.
                                       // This is how the FE slices one flat text stream across
                                       // several text blocks — see the rule below.
  streaming: z.boolean().optional(),   // set on the ONE block currently being written
});
export type BlockProjection = z.infer<typeof BlockProjection>;
```

**How one flat stream feeds many text blocks (dry-run F16).** `agentText` is a single append-only
stream, but a `text → tool → text` turn produces two separate text blocks. Without a rule the
frontend cannot tell which characters belong to which block.

The rule: **`chars` is an exact character count, and text blocks consume the stream in order.**

```
blocks: [ {type:'text', chars:180}, {type:'tool_use', …}, {type:'text', streaming:true} ]
stream: "Sure, I'll generate that…<180 chars>…Here is the result so far"
                                   ▲
        block[0] takes [0, 180)     └─ block[2] takes [180, end) because it is `streaming`

offset(n) = Σ chars of all preceding text/thinking blocks
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
  display: z.object({ label: z.string(), icon: z.string() }),  // from the registry (gap 8)
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
| 9 | `/api/v1/waitpoints/:id/resolve` | POST | **4** | `WaitpointResolution` | `{ ok: true }` |
| 10 | `/api/v1/credits` | GET | **2** | `?cursor` | `{ balance, entries, nextCursor }` |
| 11 | `/api/v1/credits/top-up` | POST | **2** | `{ amount }` + `Idempotency-Key` hdr | `{ balance }` |
| 12 | `/api/v1/uploads/sign` | POST | **6** | `{ files[] }` | `{ params, signature }` |
| 13 | `/api/v1/attachments` | POST | **6** | assembly payload | `{ attachment }` |
| 14 | `/api/v1/attachments` | GET | **6** | `?cursor&source&chatId` | `{ attachments, nextCursor }` |
| 15 | `/api/v1/attachments/:id` | PATCH/DELETE | **6** | `{ name }` / — | `{ attachment }` / `{ ok }` |
| 16 | `/api/v1/messages/:id/feedback` | PATCH | **6** | `{ type }` | `{ ok: true }` |
| 17 | `/api/v1/llm/status` | GET | **6** | — | `{ lastRoutedModel, rateLimitedUntil }` |

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
// TWO IDS, NEVER CONFLATED (dry-run F2). ARCHITECTURE §4.1 returned `runId: handle.id`, which
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
export const WaitpointResolution = z.union([
  z.object({ kind: z.literal("plan_approval"), approved: z.boolean(),
             feedback: z.string().max(2000).optional(),
             executionMode: z.enum(["auto","step_by_step"]).optional() }),
  z.object({ kind: z.literal("questions"),
             answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
             skipped: z.array(z.string()) }),
  z.object({ expired: z.literal(true) }),       // server-written only
]);

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
  blocks: z.array(BlockProjection).max(40),     // ORDERED live narrative (gap 1). BOUNDED — dry-run F5:
  blocksTruncated: z.number().optional(),       // metadata has its OWN size cap, smaller than the 3 MB
                                                // PAYLOAD cap. Spike it. The FE holds full history from
                                                // REST, so metadata only carries the live tail.
  reasoningText: z.string().optional(),         // streaming Thinking row (gap 2)
  activePlan: z.unknown().optional(),           // plan-progress card (gap 4)
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

// z.coerce.boolean() is a TRAP (dry-run F3): Boolean("false") === true, so DEMO_MODE=false
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
  MAX_TURNS: z.coerce.number().default(12),
  DEMO_MODE: bool.default("false"),
  DISABLE_TITLE_GEN: bool.default("false"),
});

export const env = Env.parse(process.env);   // module load = boot check
```

A missing key becomes a named crash on startup, not `undefined` in the middle of a demo.

**`prisma/schema.prisma` datasource (dry-run F7)** — `prisma migrate` takes a Postgres advisory lock
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

      const body  = opts.body  ? opts.body.parse(await req.json()) : undefined;
      const query = opts.query ? opts.query.parse(
                      Object.fromEntries(new URL(req.url).searchParams)) : undefined;

      const data = await opts.handler({ userId, body, query,
                                        params: await params, log, traceId });
      return Response.json({ data });
    } catch (e) {
      return mapError(e, traceId, log);         // ZodError→400, AppError→its code, else 500
    }
  };
}
```

`ensureUserWithGrant` is why the Clerk webhook is a *bonus* and not a blocker: the first
authenticated request creates the user row and grants signup credits, keyed `grant:{userId}`.

**`middleware.ts` — order is load-bearing (dry-run F1).** Two repos means two origins, so there are
no cookies: the frontend sends `Authorization: Bearer <getToken()>` on every request.

```ts
export default clerkMiddleware({ authorizedParties: [env.FRONTEND_URL] });
// CORS lives in this same middleware, and the OPTIONS short-circuit MUST come BEFORE auth —
// a preflight carries no Authorization header, so auth-first answers 401 and the real request
// is never sent. No cookies, no Allow-Credentials.
```

**`P2002` is attributed per call site, never around the transaction (dry-run F8).** Two different
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

**Migration sequence (dry-run F9)** — `migrate dev` generates SQL from the schema and cannot invent
our partial indexes, so 002 and 003 are created empty and hand-edited:
```bash
pnpm prisma migrate dev --name init
pnpm prisma migrate dev --create-only --name partial_unique_indexes   # then paste the SQL below
pnpm prisma migrate dev --create-only --name pg_trgm
pnpm prisma migrate dev                                              # apply 002 + 003
```

**DoD**
- `pnpm dev` boots; `GET /api/v1/health` returns `{data:{ok:true}}`
- `app/page.tsx` and `app/globals.css` from `create-next-app` are **deleted** (F10) — the backend
  serves only `app/api/**`, and a stray Next welcome page on the deployed API reads as carelessness
- `pnpm prisma migrate dev` applies clean against Neon; `psql` shows both partial indexes
- Deleting one env var crashes the boot with that variable's name in the message
- `tsc --noEmit` clean under `strict: true`

**Tests** — none yet, except a `contracts` unit test that every schema parses its own example.

---

### Phase 1 — THE VERTICAL SLICE · ~8h · the demo

**Goal:** *"generate an image of a mountain"* → durable run → live stream → tool card → asset
persisted → **reload mid-run and it keeps going.**

This is the phase that wins or loses the trial. Everything after it is widening.

**Write in this order.** Steps 1–4 need no Trigger.dev, no Clerk and no frontend, and they hold the
highest-risk logic — the cheapest place to be wrong.

```
1  lib/credits              + unit test asserting balance === SUM(ledger)
2  tools/{define,registry}, gpt_image_2, magica-client (against MSW)
3  trigger/magica-node-run  + the resume-not-resubmit test
4  trigger/run-agent-turn   with fake deps → block order + segment increment tests
5  trigger/agent-turn shell + streams + trigger.config.ts    ← first real Trigger.dev run
6  services + POST send + GET chat + GET active-run + GET chats + GET credits
7  frontend (see its LLD Phase 1)
```

**Files**
```
src/lib/credits/index.ts
src/app/api/v1/credits/route.ts                  (GET — moved from Phase 2: the DoD asserts the
                                                  ledger invariant, and that is far easier to eyeball
                                                  over REST than in psql. One thin route.)
src/tools/{define,registry,to-ai-sdk,magica-client,gpt-image-2}.ts
src/trigger/{streams,magica-node-run,run-agent-turn,agent-turn}.ts
src/prompts/system.ts
src/services/{chat,message,run}.service.ts
src/app/api/v1/chats/[id]/messages/route.ts      (POST — send)
src/app/api/v1/chats/[id]/route.ts               (GET  — reload)
src/app/api/v1/chats/[id]/active-run/route.ts    (GET  — recovery)
src/app/api/v1/chats/route.ts                    (GET  — LIST ONLY, cursor, no search/filter.
                                                  Moved from Phase 5 (review #21): FE Phase 3's
                                                  sidebar + Tasks page need it real, not mocked, and
                                                  it is the most-seen surface for the 20% fidelity
                                                  score. ~20 lines over an index that already exists)
trigger.config.ts
tests/msw/magica.ts, tests/msw/openrouter.ts
```

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
> An earlier draft of this file updated the balance first and caught `P2002` from the insert. That was
> wrong twice over, and both failures are exactly what the credits criterion looks for:
> 1. **It double-charged on retry.** The decrement ran again, *then* the insert collided, and the
>    catch returned success — so `balance` drifted from `SUM(ledger)` silently.
> 2. **It poisoned the transaction.** In Postgres, an error inside a transaction aborts it; every
>    later statement in that `tx` fails with "current transaction is aborted". Since
>    `reserveAdmission` runs inside the send route's transaction alongside the message and run
>    inserts, a caught `P2002` would have taken the whole send down.
>
> Insert-first inverts both: the unique index decides whether this is the first application, the row
> count tells us without raising, and the balance only moves when the ledger actually grew.

Four properties to be able to defend cold:
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
  display: { label: string; icon: string };       // the HUMAN reads this (gap 8)
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

Contract facts that must be encoded, not assumed (see `docs/api-notes/magica-api-reference.md`):
`202` not `200`; statuses `QUEUED|RUNNING|COMPLETED|FAILED|CANCELED` (one L); **403 = insufficient
credits**; prefer `userMessage` over `error` for display; `creditUsed` is microcredits.

#### 4.1.4 `trigger/magica-node-run.ts` — the typed child task

```ts
export const magicaNodeRun = task({
  id: "magica-node-run",
  maxAttempts: 1,                                  // manual retry only (decision #20)
  run: async (p: { invocationId: string; nodeType: string;
                   subModelId?: string; input: unknown }) => {
    // If a previous attempt already submitted, resume instead of re-submitting.
    const inv = await db.toolInvocation.findUniqueOrThrow({ where: { id: p.invocationId } });
    if (inv.magicaRunId) return pollUntilTerminal(inv.magicaRunId);   // ← never pay twice
    return runMagicaNode({ ...p, onRunId: (id) =>
      db.toolInvocation.update({ where: { id: p.invocationId }, data: { magicaRunId: id } }) });
  },
});
```

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
  // `one_assistant_message_per_run` is a RAW partial index, so Prisma cannot `upsert` on it (F6):
  //   try { create assistant Message } catch (P2002) { findFirst({ runId, role:'assistant' }) }
  // That is precisely why the index is partial-unique: idempotent bootstrap with no lock.

  let segment = 0, turns = 0;
  const blocks: ContentBlock[] = [];

  while (turns++ < env.MAX_TURNS) {
    const stream = streamText({
      model: openrouter(run.modelId),
      messages: toModelMessages(history, blocks),
      tools: toAiSdkTools(registry, ctx),
      stopWhen: [stepCountIs(env.MAX_TURNS), hasToolCall("submit_plan"),
                 hasToolCall("ask_questions")],
    });

    let textOpen = false;
    for await (const part of stream.fullStream) {
      switch (part.type) {
        case "text-delta":                          // v5 carries `.text` (F4)
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
          if (textOpen) { closeTextBlock(); segment++; textOpen = false; }   // gap 3
          blocks.push({ segment, type: "tool_use", id: part.toolCallId,
                        name: part.toolName, input: part.input });   // v5: `.input`, not `.args` (F4)
          await deps.persistBlocks(blocks);         // progressive persistence
          await deps.metadata.set({ phase: "working",
                                    currentStep: registry[part.toolName].display.label,
                                    blocks: project(blocks) });
          break;
        case "error":
          throw new StreamErrored(part.error);      // mid-stream SSE errors don't throw themselves
      }
    }

    // 2. EMPTY-STREAM GUARD — one cheap in-process retry, then fail safely
    if (!producedText && !producedToolCalls) { if (!retried) { retried = true; continue; }
                                               return deps.finalizeFailed("empty response"); }

    // 3. WAITPOINT — task level, never inside a live stream
    // An interaction tool has NO `execute`, so v5 emits the call and ends the step; `stopWhen` halts
    // the loop. The resolution MUST go back as a tool-result message or the model repeats the call.
    if (pendingInteraction) { const resolution = await deps.suspendOn(pendingInteraction);
                              history.push(toolResultMessage(pendingInteraction, resolution));
                              segment++; continue; }
    break;
  }

  // 4. FINALIZE — one transaction
  await deps.finalize({ blocks, assets, tokenUsage });   // + refundAdmission ALWAYS
}
```

The `deps` seam is what makes this testable: `bootstrap`, `agentText`, `metadata`, `persistBlocks`,
`suspendOn`, `finalize` are all injected. Unit tests pass fakes and assert block order, segment
increments and credit calls **without Trigger.dev, without Postgres, without OpenRouter**.

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
| unit | `runAgentTurn` with fakes: block order, `segment` increments on text→tool, MAX_TURNS cap |
| unit | credits: reserve→charge→refund invariant; double-charge is a no-op; negative balance impossible |
| unit | `magica-client`: 202/401/403/429/timeout/FAILED mapping |
| integration | send route: happy path, 409 on active run, 400 on bad model, 402 on no credits |
| integration | resume: pre-set `magicaRunId` → child task polls, does not re-submit |

---

### Phase 2 — Reliability & the failure matrix · ~5h · the 20%

**Goal:** every row of `ARCHITECTURE §5` demonstrably behaves as written, and every failed turn is
explainable from the UI alone.

**Files** — `run.service.ts` (cancel + state machine + stale-lock), `messages/[id]/retry/route.ts`,
`runs/[id]/cancel/route.ts`, `credits` routes, `prisma/seed.ts`.

**Build**
1. `assertTransition(from,to)` — one map. Illegal jumps throw, so a bug cannot resurrect a terminal run.
2. **Cancel**, in this order: status flip → `runs.cancel` → message cancelled keeping partials →
   **sweep pending waitpoints to `expired`** (gap 9e) → `refundAdmission`.
3. **Retry** — only from `failed`/`cancelled`; `attempt+1`; resets the assistant row (clear blocks,
   cancel + refund non-terminal invocations).
4. **Stale-lock recovery** — never infer liveness from timestamps. `triggerRunId IS NULL` and >90s
   → dead, refund, admit. Otherwise `runs.retrieve()` and trust Trigger.dev.
5. Rate limit on send (Postgres UPSERT counter) → `429` + `Retry-After`.
6. `prisma/seed.ts` — makes `migrate reset` cost 10 seconds instead of your demo data.

**DoD** — every §5 row reproducible on demand; a failed turn shows error text + partial output +
tool outcomes + Retry; cancel leaves no `pending` waitpoint; logs carry all six keys.

**Tests** — integration per §5 row; the acceptance list's 401/429/timeout/failed-run/duplicate-dispatch.

---

### Phase 3 — Skills · ~3h · explicitly graded, explicitly tested

**Goal:** the PDF's skills system, with its five named tests.

**Files** — `lib/skills/{scan,load}.ts`, `tools/{load-skill,read-skill-asset}.ts`,
`agent-skills/*/SKILL.md`, `prompts/system.ts` (+ L1 index), `tests/fixtures/bad-skills/`.

**Build**
- Startup scan of `agent-skills/`, **resolved from package root not `cwd`** — otherwise the registry
  is empty in the Trigger.dev bundle while working perfectly in dev. Ship the directory via
  `trigger.config.ts` external files.
- `gray-matter` → `SkillMeta.parse` → reject duplicates → 64 KB cap → `sha256`.
- L1: `name: description` pairs in the system prompt. L2: `load_skill`. L3: `read_skill_asset` with
  the containment check `abs.startsWith(resolve(dir, name) + path.sep)` — **the `+ path.sep` matters**,
  without it `skills/foo-evil` passes a check meant for `skills/foo`.
- `RunSkill` upsert on `(runId, skillName, assetPath)` with `assetPath` defaulting to `""` **not null**.

**DoD** — 4 skills load; malformed frontmatter is rejected at boot with a named error; `../../etc/passwd`
is refused; a repeat load dedups; an unknown skill returns a tool-error the model recovers from;
a suspended run resumes with the same hashes.

**Tests** — the five above, by name. These are in the PDF; a grader will look for them.

---

### Phase 4 — Plan approval, the first waitpoint · ~4h

**Goal:** the interaction machinery — generic, so Phase 6 adds a second kind for free.

**Files** — `tools/submit-plan.ts`, `services/approval.service.ts`,
`app/api/v1/waitpoints/[id]/resolve/route.ts`, `suspendOn` in the loop.

**Build**
- `submit_plan` per **§3.2b**: `steps[].toolCall` is **required**; orchestration parses each step's
  input with that tool's own schema and prices it via `credits()`. **The model never states a cost.**
- `suspendOn(interaction)`: `wait.createToken({timeout:'15m', idempotencyKey:`wp-${invocationId}`})`
  → INSERT `Waitpoint` → `metadata.set({phase:'waiting', waitpoint})` → `await wait.forToken()`.
- Resolve route: `WaitpointResolution.parse` → **reject `kind` mismatch** → conditional
  `UPDATE … WHERE status='pending'` → only on a won update, `wait.completeToken(id, resolution)`.
- 0 rows updated → already completed (`{ok}` no-op) or expired (`WAITPOINT_EXPIRED`).

**DoD** — plan card renders with **server-priced** chips; approve resumes the same run; reject +
feedback re-plans in the same message; double-click resolve is a no-op; letting it expire clears the
overlay and the model wraps up; `LIMIT_EXCEEDED` fires at plan time if the priced total exceeds balance.

---

### Phase 5 — Tools 2–4 + chat management · ~4h · the widening

Pure additive. **If any of this requires touching `run-agent-turn.ts`, stop — a seam is missing.**

- `crop_image` — Zod `.superRefine`: a complete percent rect **or** a complete pixel rect; reject
  partial sets and mixed units. The catalog marks no coord field required, so this validation is
  entirely ours.
- `merge_videos` — `video_urls` 2–100 (our bound, not the catalog's), order preserved, `transition` enum.
- `get_model_schema` — cached per process; always render the duration (7 ms cache hit vs 3.7 s cold).
- `GET /chats` with `?cursor&search&filter`; `PATCH`/`DELETE /chats/:id`; message pagination via
  `messagesCursor`.

**DoD** — each tool succeeds live once; a chained conversation crops a generated image; invalid input
produces a tool-error the model recovers from; chat list pages with no offset scan (check the plan).

---

### Phase 6 — Deferred-by-design · ~8h · take in this order, stop anywhere

Ordered by *graded value per hour*. Every item is independent.

| Order | Item | Why here |
|---|---|---|
| 1 | `ask_questions` + resolve payload | required (p109); the Phase-4 machinery is kind-agnostic, so this is mostly FE |
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

**MSW fixtures come from the archived live catalog** (`docs/api-notes/magica-docs/`), not from
hand-written guesses — so the mocks match the real API shape by construction.

**OpenRouter budget (50/day, hard):** all automated tests = **0 requests**. Dev checks ≤20/day.
Acceptance ~10, once. Demo ~20 headroom, recorded right after the daily reset.

---

## 6. Ten decisions to be able to defend cold

A reviewer will pick from this list.

1. **Charge before execute.** Catches exhaustion before external cost; no late-settle race.
2. **Admission always refunded in full.** Net turn cost = Σ tool charges. The earlier
   reserve/settle/refund-remainder model double-charged (decision #19a).
3. **`magicaRunId` checkpointed before the first poll.** The one guard that stops paying twice after a crash.
4. **Partial unique index for one-active-run.** The lock is a database constraint, not application code.
5. **`idempotencyKey = {userMessageId}:{attempt}`.** Dedups dispatch without ever blocking a legitimate retry.
6. **Manual retry only (`maxAttempts: 1`).** Auto-retry duplicates narrative and re-runs paid work,
   because regenerated tool ids never match. The PDF agrees: "retry only when safe."
7. **Postgres is truth; realtime is a preview.** Test: could a fresh browser rebuild this screen now?
8. **`segment` increments on text-block close.** Reproduces the reference's repeated step groups
   (corrected in session 4 — the waitpoint-only rule collapsed a 10-step turn into one group).
9. **The server prices plan steps; the model never states a cost.** Otherwise the credit chips are
   model-invented numbers on the credits criterion.
10. **Never infer liveness from timestamps.** A run suspended 14 minutes on a waitpoint looks stale
    and is perfectly healthy. Ask Trigger.dev.

---

## 7. Traps that have already cost other people hours

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
