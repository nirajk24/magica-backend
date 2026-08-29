# magica-backend

Backend for an agent chat product: a long-running, tool-using AI agent behind a REST API.

A user sends a message; an agent reasons, calls media-generation tools, sometimes pauses to ask a
question, and answers. A turn can take minutes and spend real credits, so the API never does the
work itself — it validates, persists, reserves credits, dispatches a durable job and returns. The
job survives deploys and restarts, and a browser that reloads mid-turn rebuilds the entire screen
from PostgreSQL.

The client lives in [magica-frontend](https://github.com/nirajk24/magica-frontend) and consumes a
synced copy of `src/contracts/`.

| | |
|---|---|
| **Design docs** | [`ARCHITECTURE.md`](./ARCHITECTURE.md) — the system · [`LLD.md`](./LLD.md) — module-level design and the traps · [`CONVENTIONS.md`](./CONVENTIONS.md) — day-to-day rules |
| **API reference** | [magica-8fc30897.mintlify.site](https://magica-8fc30897.mintlify.site) — published from `docs-site/`, whose OpenAPI document is generated from the same schemas the routes validate against |

---

## Setup

Requires **Node 20.9+** (`.nvmrc` pins 20.20.2) and **pnpm**. You will need a PostgreSQL database
and accounts for Clerk, Trigger.dev, OpenRouter and the media provider.

```bash
nvm use
pnpm install                 # generates the database client via postinstall
cp .env.example .env         # fill in every value — the app names any missing one at boot
pnpm db:migrate              # apply migrations
pnpm db:seed                 # a demo account and chats
```

Running locally takes **two processes**:

```bash
pnpm dev                     # API on :3001
pnpm trigger:dev             # the agent worker — without it, sends are accepted and nothing runs
```

Verify with `curl localhost:3001/api/v1/health` — it answers only after a live database round trip.

### Environment

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` / `DATABASE_URL_UNPOOLED` | yes | pooled connection for the app, direct for migrations |
| `CLERK_SECRET_KEY` / `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | yes | authentication |
| `TRIGGER_SECRET_KEY` / `TRIGGER_PROJECT_REF` | yes | durable job execution |
| `OPENROUTER_API_KEY` | yes | the model provider |
| `MAGICA_API_KEY` / `MAGICA_BASE_URL` | yes | the media-generation provider |
| `FRONTEND_URL` | yes | CORS origin — a wrong value drops every browser request |
| `TRANSLOADIT_KEY` / `TRANSLOADIT_SECRET` | no | uploads; absent, the signing route fails by name and nothing else is affected |
| `ADMISSION_CREDITS`, `MAX_TURNS`, `MAX_STEPS`, … | no | tuning, all defaulted |

`lib/env.ts` parses the whole environment at import, so a missing or malformed variable fails at
boot naming the variable, rather than surfacing as `undefined` somewhere later.

### Checks

```bash
pnpm typecheck && pnpm lint && pnpm test    # 544 tests across 40 files; integration needs TEST_DATABASE_URL
pnpm check:wiring                           # fails on any export no production code reaches
```

Automated tests make **zero** live network calls: provider APIs are mocked and an escaped request is
a failing test rather than a silent charge.

### Deploying

**Two deploys, every time.**

```bash
pnpm build                   # the web application (Vercel)
pnpm trigger:deploy          # the agent worker
```

Deploying the application alone leaves the worker running previous code. The worker's dashboard
needs **every** non-optional variable above — a task imports the database module, which parses the
entire environment at import, so a missing variable no task ever reads still crashes every task at
boot.

---

## Project structure

```
magica-backend/
├── ARCHITECTURE.md          the system: data model, lifecycle, failure handling, scalability
├── LLD.md                   module-level design, invariants, and the traps in this stack
├── CONVENTIONS.md           layering, comment style, the gates to run
├── docs-site/               Mintlify API reference; openapi.json is generated, not written
├── agent-skills/            versioned agent guidance, one directory per skill
├── prisma/
│   ├── schema.prisma        16 models
│   ├── migrations/          forward-only, each with rollback and compatibility notes
│   └── seed.ts
├── scripts/
│   ├── check-wiring.ts      finds exports nothing reaches
│   └── gen-openapi.ts       OpenAPI from the live Zod contracts
├── src/
│   ├── app/api/
│   │   ├── v1/              application API — session-authenticated
│   │   └── public/v1/       public API — API-key authenticated
│   ├── contracts/           Zod schemas + types. Imports nothing from src/; synced to the client
│   ├── lib/                 env, routing pipeline, database, errors, credits, logging, skills,
│   │                        uploads, API keys, webhook signing
│   ├── services/            business logic, one domain each
│   ├── agent/               the turn loop, block accumulation, model adapter, tool runtime
│   ├── tools/               the tool registry and everything a tool needs
│   ├── prompts/             system prompt assembly and model-message conversion
│   └── trigger/             task definitions only — every file here is a build entry point
└── tests/
    ├── unit/                injected fakes: no database, no network
    ├── integration/         real PostgreSQL, mocked HTTP
    └── msw/                 mock handlers built from the contracts
```

---

## Architecture in brief

Full detail and the complete diagrams in [`ARCHITECTURE.md`](./ARCHITECTURE.md). The shape:

```
 browser
    │  REST (bearer)                                        realtime ▲ preview only
    ▼                                                                │
 ┌─────────────────────────────────────────────────────────┐         │
 │ API RUNTIME — route pipeline                            │         │
 │   identify caller → Zod parse → service → envelope+CORS │         │
 │   one wrapper per auth mode; everything else shared     │         │
 └───────────────┬─────────────────────────────────────────┘         │
                 │                                                   │
   ONE TRANSACTION│ message + run + attachments + credit hold        │
                 ▼                                                   │
        ┌──────────────────┐        enqueue (idempotency key)        │
        │   POSTGRESQL     │◀───────────────┐                        │
        │  ─ the truth ─   │                │                        │
        │                  │   ┌────────────┴────────────────────────┴──────────┐
        │ constraints do   │   │ WORKER RUNTIME — durable, survives deploys     │
        │ the exactly-once │   │                                                │
        │ work:            │   │  agent-turn:                                   │
        │  · 1 active run  │   │    stream ─┬─ text / reasoning                  │
        │    per chat      │◀──┼─ progressive├─ tool call ──▶ guard → validate   │
        │  · 1 assistant   │   │    writes  │   → record → CHARGE → execute      │
        │    msg per run   │   │            │   → validate → settle              │
        │  · unique ledger │   │            │        └──▶ child job ──▶ media    │
        │    key per move  │   │            │             (checkpoints the       │
        │                  │   │            │              provider run id,      │
        │                  │   │            │              suspends between      │
        │                  │   │            │              polls)                │
        │                  │   │            └─ interaction ──▶ park on a token,  │
        │                  │   │                zero compute, wake on resolve    │
        │                  │   │                                                 │
        │                  │◀──┼─ finalize: message + generated media + refund   │
        └──────────────────┘   └────────────────────────┬────────────────────────┘
                                                        │
                      OpenRouter ◀── models   media provider ◀── generation
                                            signed webhooks ──▶ customer receivers
```

**PostgreSQL is the only source of truth.** Realtime is a preview, reconciled at terminal. The test
applied to every feature is whether a freshly loaded browser could rebuild the screen from the
database alone.

**One tool registry.** A tool is a single declaration — description, Zod input/output, credit
estimator, executor — and the model's schema, validation, charging, and the rendered card all derive
from it. Adding a tool is one file and one key. A tool with *no* executor is the mechanism that
parks a run for human input, which is how approvals and questions are the same machinery.

**Exactly-once is a set of database constraints, not application code.** One active run per chat and
one assistant message per run are partial unique indexes; every credit movement carries a unique
key; the media child job checkpoints the provider's run id before its first poll, so a restarted
worker resumes the same paid job instead of buying a second one.

**Credits are an append-only ledger** with a cached balance, and `balance === SUM(ledger)` is
asserted across the test suite. A fixed hold is taken at send and always refunded; each tool charges
its estimate *before* executing, so exhaustion is caught before external cost, and reconciles to the
provider's reported cost afterwards.

**Failures are data.** Tool errors return a structured result to the model, which self-corrects or
explains. Anything fatal becomes a user-safe failed message with all partial output preserved and a
retry affordance — explainable from the interface alone.

**The public API is the same API.** Its route wrapper differs from the internal one in exactly one
respect: the caller comes from a bearer key rather than a session. Message submission is literally
one shared function, so the two surfaces cannot drift.

---

## Design decisions and trade-offs

**Charge before executing.** Catches credit exhaustion before any external cost and removes the
late-settle race entirely. The cost is that a failed tool must refund itself, which is one extra
ledger movement.

**The admission hold is always refunded in full.** Net turn cost is the sum of tool charges. An
earlier reserve/settle/refund-the-remainder model double-charged; a hold that is a gate rather than
a price is simpler to reason about and impossible to get wrong by arithmetic.

**Manual retry only.** Automatic retry replays narrative the user has already watched and re-runs
paid work, because regenerated tool ids no longer match the persisted rows. Retry is a deliberate
user action on a visible failed turn.

**Never infer liveness from a timestamp.** A run parked on a question for fourteen minutes looks
stale and is perfectly healthy, so stale-lock recovery asks the job runner — and treats a *failed*
query as "still alive", because refunding a live run admits a second turn beside it.

**The server prices everything a user is asked to approve.** A model never states a cost; each
proposed step is priced through the same estimator that will charge for it. Otherwise the figures on
an approval screen are numbers a model invented.

**Contracts are copied, not published.** `src/contracts/` is synced to the client and its build
fails on a byte-level mismatch. A versioned package would be correct at scale; for two repositories
moving together, a sync check catches drift at build time with no release step.

**Development-tier third-party services.** Authentication runs a development instance (a production
one needs a custom domain), and the model path uses a free router with strict daily request limits —
so `MAX_TURNS × MAX_STEPS` is validated against that budget at boot and skill loads are capped per
turn. These bound what can be demonstrated, not how the system is built.

**Simplifications, each with a known upgrade path:** top-up is not a payment flow (it exists so the
ledger is exercised in both directions); prompt context is a recent-message window rather than
token-budget assembly with summarisation; search is trigram `ILIKE` rather than full-text search;
rate limiting is a per-account counter in PostgreSQL rather than a distributed sliding window; model
availability is a single shared row rather than per-account; upload results live on the transform
provider's temporary storage and expire after 24 hours, surfaced as state rather than hidden.

---

## What I would improve with more time

- **Token-budget context assembly** with summarisation of older turns, replacing the fixed window.
- **Full-text search** (`tsvector`) and a distributed rate limiter, both of which the current
  choices are deliberately sized below.
- **Model rotation across providers** on upstream rate limits. The served model is already recorded
  per message, so history would stay truthful; what is missing is the rotation policy and a way to
  make the choice visible rather than surprising.
- **Server-side verification of upload completions** — re-fetching the assembly from the provider
  before trusting a client's report.
- **Per-account model availability** instead of one shared row.
- **Contracts as a versioned package**, with the client depending on a release rather than a synced
  copy.
- **Per-endpoint webhook retry policy** and a manual redelivery control, rather than one policy for
  every receiver.
