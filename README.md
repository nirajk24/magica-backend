# magica-backend

Backend for a Galaxy Agent Chat clone: a long-running, tool-using AI agent behind a REST API.
Next.js route handlers own the request path, Trigger.dev runs the durable agent turns, PostgreSQL
is the single source of truth, and every trust boundary is a Zod schema.

The frontend lives in [magica-frontend](https://github.com/nirajk24/magica-frontend) and consumes
a synced copy of `src/contracts/`.

## Setup

Requires Node 20.9+ (`.nvmrc` pins 20.20.2) and pnpm.

```bash
nvm use
pnpm install                 # generates the Prisma client via postinstall
cp .env.example .env         # fill in every value; the app names any missing one at boot
pnpm db:migrate              # apply migrations to the database in DATABASE_URL
pnpm db:seed                 # demo user and chats
pnpm dev                     # API on :3001
pnpm trigger:dev             # the agent worker — a second process, required for turns to run
```

Verify with `curl localhost:3001/api/v1/health` — it answers only after a live database round trip.

Deploying is **two deploys, every time**: the Next.js app (Vercel) and `pnpm trigger:deploy`.
Deploying the app alone ships stale tasks. The Trigger.dev dashboard needs every non-optional
variable from `lib/env.ts` — tasks parse the full environment at boot.

```bash
pnpm typecheck && pnpm lint && pnpm test   # 400+ tests; integration tests need DATABASE_URL
pnpm check:wiring                          # fails on any export no production code reaches
```

Automated tests make **zero** live network calls: provider APIs are mocked with MSW and
`onUnhandledRequest: "error"` turns an escaped request into a failing test.

## Architecture

```
send route ──▶ Postgres (message + run + credit hold, one transaction)
     │
     └─▶ Trigger.dev task: agent-turn ──▶ OpenRouter (streamText, tools)
              │                              │
              │         ┌────────────────────┴─ tool call, wrapped: cancel guard → validate →
              │         ▼                       record → charge → execute → validate → settle
              │    magica-node-run (child task, polls Magica; suspends between polls)
              │
              ├─▶ realtime: metadata snapshot + append-only text stream (preview only)
              └─▶ Postgres: progressive block persistence, terminal finalize
```

**The REST request never does AI work.** Send validates, persists, reserves credits, dispatches
idempotently and returns in milliseconds. The turn itself is a durable Trigger.dev run that
survives deploys and restarts; a reloading client rebuilds the entire screen from the database and
resubscribes to the streams.

**One tool registry** (`src/tools/registry.ts`). A tool is one declaration — description, Zod
input/output, credit estimator, execute — and the LLM schema, validation, charging, and the
rendered card all derive from it. Adding a tool is one file and one key. Interaction tools
(`submit_plan`, `ask_questions`) declare a `interaction` kind and **no execute**: the missing
execute is what parks the run on a waitpoint token instead of running anything.

**Waitpoints are kind-agnostic.** The orchestration mints a token, persists the payload, flushes
realtime metadata and suspends — it never inspects what it is suspending on. One resolve route
(`POST /waitpoints/:id/resolve`) settles any kind with a conditional update, so duplicate
submissions are no-ops and adding a waitpoint type is a registry entry plus a contract variant.
Plan steps are priced server-side through each tool's own estimator; the model never states a cost.

**Credits are an append-only ledger** with a cached balance, and `balance === SUM(ledger)` is
asserted across the test suite. A fixed admission hold is taken at send and always refunded at
terminal; each tool charges its estimate *before* executing (exhaustion is caught before external
cost) and reconciles to the provider-reported cost after. Every movement is keyed —
`reserve:{runId}:{attempt}`, `charge:{invocationId}` — so a retried anything applies exactly once.

**Exactly-once is a set of unique constraints, not application code**: one active run per chat and
one assistant row per run are partial unique indexes; dispatch dedupes on
`{userMessageId}:{attempt}`; the Magica child task is keyed on the invocation and checkpoints the
provider's run id before its first poll, so a restarted worker resumes the same paid job instead of
buying a second one.

**Provider schemas are resolved live.** The catalog fetch that hydrates pricing also stores each
sub-model's input fields, and every outbound node request is checked against them before dispatch —
a stale field name comes back as a tool error the model can correct rather than a provider
rejection. There is no committed copy of those fields on purpose: a committed copy is exactly the
stale schema this check exists to replace.

**Failures are data.** Tool errors return `{ok:false, error, retryable}` to the model, which
self-corrects or explains; the turn loop converts anything fatal into a user-safe failed message
with all partial output preserved. Cancel flips our rows first (conditionally, so it cannot
overwrite a completed turn), then stops the machine and expires tokens best-effort. Stale-lock
recovery never infers liveness from timestamps — it asks Trigger.dev, and treats "the call failed"
as "still alive".

**Uploads are signed server-side and bounded before they start.** `POST /uploads/sign` returns one
HMAC-SHA384-signed Transloadit assembly per file, with the instructions inline in the signed string
so a client cannot alter them and `num_expected_upload_files: 1` so a signature cannot be reused for
a batch. The Community plan's 0.5 GB per-file and 5 GB monthly limits are enforced *before* anything
is signed, and monthly usage is counted exactly once, on the transition into `ready`, in the same
transaction as the attachment row. Completion is upserted on the assembly id, so a duplicate report
lands on the same row. Results live on Transloadit's temporary storage and expire after 24 hours —
`Attachment.expiresAt` carries that, and the UI renders it rather than pretending otherwise.

**The public API is the same API.** `definePublicApiRoute` differs from `defineRoute` in exactly one
thing: the caller comes from a bearer API key instead of a session. Parsing, the response envelope,
error mapping and every service are shared — message submission is literally one function called by
both routes — so the public surface cannot drift from the app's own behaviour. Keys are stored as
SHA-256 (a 192-bit random token has nothing to brute-force, and a password hash's work factor would
tax every request), returned once, and revoked rather than deleted. A direct tool run is a real run:
it creates an `AgentRun` and executes through the same charged tool runtime the agent uses, so it is
priced, reconciled, exactly-once and visible in usage without a second code path.

**Webhooks never affect the turn that produced them.** `agent.started`, `agent.completed`,
`agent.failed` and `tool.completed` are signed with the same Svix scheme the Magica platform uses.
Emission writes the delivery row and hands it to a durable task — five attempts with exponential
backoff, a delivered row never re-sent — and the emit path swallows its own failure by design,
because a customer's unreachable receiver must not fail a paid turn. `docs-site/` is a Mintlify site
whose OpenAPI document is generated from these same contracts (`pnpm docs:openapi`), so the
published reference cannot drift from what the server enforces.

Layering is one-directional — route → service → `lib/db` — and `src/contracts/` imports nothing
from the rest of the source, which is what makes it safe to copy to the frontend. `CONVENTIONS.md`
holds the day-to-day rules; `LLD.md` holds the full design with every contract.

## Trade-offs

- **Clerk runs a development instance** (production needs a custom domain): dev-mode watermark and
  a 100-user cap, acceptable for a demo.
- **Free tiers everywhere.** OpenRouter's free path allows 50 requests/day, so `MAX_TURNS × MAX_STEPS`
  is validated at boot against that budget and skill loads are capped per turn. The default model is
  `openrouter/free`, a router that picks an available free model per request — which is also why the
  served model is recorded per message from the response, not from configuration.
- **Top-up is not a payment flow.** It exists so the ledger is exercised in both directions and a
  credit-exhausted turn has a way forward.
- **Context is the last 20 messages**, not token-budget trimming.
- **Search is ILIKE over pg_trgm indexes** on titles and message content — right for this scale;
  Postgres FTS is the upgrade path.
- **Chat deletion is soft**, so ledger entries, invocations and generated assets stay explainable.
- **Realtime tokens live 15 minutes** and the client refreshes proactively; the reference uses
  25-hour tokens. Shorter is safer and exercises the refresh path.
- **Rate limiting is a per-user counter in Postgres**, not a Redis sliding window.

## Improvements with more time

- Token-budget context assembly with summarization of older turns.
- Postgres FTS (`tsvector`) for search; Redis for rate limiting at scale.
- Model rotation across free providers on upstream 429s, with the served model already recorded
  per message so history stays truthful.
- Per-account LLM availability instead of a shared status row.
- Contracts published as a versioned package instead of a synced copy.
- Assembly results verified server-side against Transloadit before an attachment is trusted, rather
  than from the uploading client's report.
- Per-endpoint webhook retry policy and a manual redelivery control.
