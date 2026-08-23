# Architecture

The backend for an agent chat product: a user sends a message, an AI agent works on it — reasoning,
calling tools, sometimes pausing to ask a question — and the result is streamed live and persisted
durably. A turn can take minutes, cost real money, and must survive a deploy halfway through.

Three ideas shape everything below.

**The API never does AI work.** A send request validates, persists, reserves credits, dispatches a
durable job and returns in milliseconds. Nothing that can take a minute happens inside an HTTP
request.

**PostgreSQL is the only source of truth.** Realtime streams are a preview. The design question
asked of every feature is: *could a browser that just loaded rebuild this screen from the database
alone?* If not, the feature is wrong.

**Extension happens at registries, not in the orchestrator.** Adding a tool, a skill or a new kind
of human interaction is a declaration in one file. If a feature needs an edit to the agent loop,
the seam is missing — add the seam instead.

---

## 1. System shape

Two runtimes. The **API** accepts work and answers in milliseconds; the **worker** performs it and
may run for minutes. They share one database and never call each other synchronously.

```
┌─ CLIENT ─────────────────────────────────────────────────────────────────────────┐
│  browser (Next.js app, separate origin)                                          │
│    · bearer token per request        · realtime subscription, scoped to one run  │
└───────┬─────────────────────────────────────────────────────▲────────────────────┘
        │ REST                                                │ two channels
        │                                                     │ (preview only)
╔═══════▼═════════════════════════════════════════════════════╪════════════════════╗
║ API RUNTIME — Next.js route handlers                        │                    ║
║                                                             │                    ║
║  defineRoute / definePublicApiRoute / definePublicRoute     │                    ║
║  ┌───────────────────────────────────────────────────────┐  │                    ║
║  │ identify caller → bootstrap account → Zod parse       │  │   Clerk (session)  ║
║  │ → handler → { data } | { error } envelope + CORS      │◀─┼── or hashed API key║
║  └──────────────────────┬────────────────────────────────┘  │                    ║
║                         │  services (one domain each)       │                    ║
║   chat · message · message-submit · run · waitpoint ·       │                    ║
║   attachment · usage · api-key · webhook · tool-run         │                    ║
║                         │                                   │                    ║
║                         │  lib/credits — the only ledger writer                  ║
╚═════════════════════════╪════════════════════════════════════════════════════════╝
                          │                                   │
      ┌───────────────────┼───────────────────┐               │
      │ one transaction   │                   │ enqueue       │
      ▼                   │                   ▼  (idempotency key)
╔═══════════════════╗     │      ╔════════════════════════════╪════════════════════╗
║ POSTGRESQL        ║     │      ║ WORKER RUNTIME — durable tasks                  ║
║ ── the truth ──   ║     │      ║                            │                    ║
║                   ║     │      ║  ┌─ agent-turn ────────────┴─────────────────┐  ║
║ User              ║◀────┼──────╬─▶│  bootstrap → stream loop → finalize       │  ║
║ CreditLedgerEntry ║ progressive║  │                                           │  ║
║ Chat / Message    ║ + terminal ║  │  ├─ text / reasoning / tool call ─────────┼──╬──▶ OpenRouter
║ AgentRun          ║   writes   ║  │  │                                        │  ║   (streaming)
║ ToolInvocation    ║            ║  │  ├─ charged tool wrapper:                 │  ║
║ Waitpoint         ║            ║  │  │  guard → validate → record → CHARGE    │  ║
║ RunSkill          ║            ║  │  │  → execute → validate → settle         │  ║
║ Attachment        ║            ║  │  │        │                               │  ║
║ MessageAttachment ║            ║  │  │        └─▶ magica-node-run ────────────┼──╬──▶ Magica API
║ UploadUsage       ║            ║  │  │            (child task: checkpoints    │  ║   (submit,
║ ApiKey            ║            ║  │  │             the provider run id, then  │  ║    then poll)
║ WebhookEndpoint   ║            ║  │  │             polls; SUSPENDS between)   │  ║
║ WebhookDelivery   ║            ║  │  │                                        │  ║
║ LlmStatus         ║            ║  │  └─ interaction tool (no executor)        │  ║
║ SendRateLimit     ║            ║  │     └─▶ park on a waitpoint token ────────┼╮ ║
║                   ║            ║  │         (zero compute while waiting)      ││ ║
║ ── constraints ── ║            ║  └───────────────────────────────────────────┘│ ║
║ one active run    ║            ║                                               │ ║
║   per chat        ║            ║  ┌─ public-tool-run ─┐  ┌─ deliver-webhook ──┐│ ║
║ one assistant msg ║            ║  │ same charged      │  │ HMAC-signed, 5×    │╬─╬──▶ customer
║   per run         ║            ║  │ wrapper, no model │  │ backoff, once only ││ ║    receiver
║ unique ledger key ║            ║  └───────────────────┘  └────────────────────┘│ ║
╚═══════════════════╝            ╚═══════════════════════════════════════════════╪═╝
        ▲                                                                        │
        │                        POST /waitpoints/:id/resolve                    │
        └────────────────────────────────────────────────────────────────────────┘
                     (conditional update wins → completes the token → wakes the run)

  Uploads bypass both runtimes: the API signs an assembly, the browser uploads
  directly to Transloadit, and the client reports completion back to the API.
```

**Reading the diagram.** Solid boundaries are processes; the database sits between them because it
is the only thing both trust. The client's realtime subscription points *at* the worker but carries
no authority — it is a preview of what is already being written to Postgres, and the two channels
have different semantics (a latest-value metadata snapshot, and an append-only text stream).

**The three loops that make it durable.** A tool call charges before it executes, so exhaustion is
caught before external cost. A provider call checkpoints its run id before the first poll, so a
restarted worker resumes rather than re-buys. A parked interaction holds a token and no compute, so
a fifteen-minute wait costs nothing and a resolution wakes it exactly once.

---

## 2. Data model

Sixteen tables in five groups. Everything queried, constrained or counted is a real column;
everything read back as an opaque display payload is validated JSON.

**Identity and money**
`User` holds a cached `creditBalance`. `CreditLedgerEntry` is append-only, with a unique
`idempotencyKey` on every row. The balance is a cache of the ledger, and `balance === SUM(ledger)`
is asserted after every scenario in the test suite.

**Conversation**
`Chat` → `Message`. A message carries its role, status, plain-text `content`, and an ordered
`contentBlocks` array — the narrative of a turn as text, thinking, tool use and usage rows, in the
order they happened. `assets` and `attachments` hold frozen render snapshots of media.

**Execution**
`AgentRun` is one attempt at answering one user message. `ToolInvocation` is one tool call within
it, carrying its input, output, cost, provider run id and timing. `Waitpoint` is a point where the
run parked for a human. `RunSkill` records which guidance a run loaded, with content hashes.

**Media**
`Attachment` covers both uploads and generated output, distinguished by `source`.
`MessageAttachment` joins attachments to messages with an explicit `position`, so ordering is a
column rather than an accident. `UploadUsage` tracks monthly bytes per account.

**Platform**
`ApiKey` (hashed), `WebhookEndpoint`, `WebhookDelivery`, `LlmStatus`, `SendRateLimit`.

### The constraints that do the work

Three exactly-once guarantees are database constraints, not application logic:

| Guarantee | Mechanism |
|---|---|
| One active run per chat | partial unique index on `(chatId)` where status is non-terminal |
| One assistant message per run | partial unique index on `(runId)` where role is assistant |
| One ledger movement per event | unique `idempotencyKey`, e.g. `charge:{invocationId}` |

Partial unique indexes are hand-written SQL, because Prisma cannot express a `WHERE` clause on an
index. Anything Prisma *can* express is declared in the schema, or the next migration silently drops
it.

Every `DateTime` is `timestamptz`, and every table carries `createdAt`/`updatedAt` with
database-level defaults — so raw-SQL inserts and change-data-capture both work.

---

## 3. The request path

A send is five steps and one transaction:

1. Rate-limit the account.
2. Resolve or create the chat.
3. **One transaction**: insert the user message, bind any attachments, create the run, bump the
   chat, reserve the admission hold.
4. Dispatch the durable job, keyed `{userMessageId}:{attempt}`.
5. Return ids plus a scoped realtime token.

The dispatch sits *outside* the transaction deliberately: holding one open across a network call
ties a database connection to a third party's latency, and the compensating path already exists —
a run with no job id is exactly what stale-lock recovery looks for.

If the transaction fails on the active-run index, the chat is already busy. Rather than rejecting
immediately, the route asks whether the holder is genuinely alive (below), and only then answers
`409`.

---

## 4. Turn lifecycle

The task is a thin shell over a pure loop. Everything the loop needs — persistence, streaming,
credits, suspension — is injected, so the whole turn is testable with no database, no job runner
and no model.

```
 BOOTSTRAP
   ├─ load run, chat, recent history, any active plan
   ├─ create-or-find the assistant row      ← partial unique index makes this idempotent
   ├─ record the requested model            ← so a crash still says what was working
   └─ mark the run running                  ← conditional on non-terminal
        │
        ▼
 ┌──▶ TURN ──────────────────────────────────────────────────────────────────────┐
 │      │                                                                        │
 │      ├─ build messages: history + files as context lines + any resolution     │
 │      │  INVARIANT every tool call replayed has a matching result              │
 │      │                                                                        │
 │      ├─ stream ─┬─ text delta ─────────▶ append to stream, grow a text block  │
 │      │          ├─ reasoning delta ────▶ metadata field (never the stream)    │
 │      │          ├─ tool call ──────────▶ TOOL PATH ─┐                         │
 │      │          └─ error ──────────────▶ classify, then fail safely           │
 │      │                                              │                         │
 │      │   ┌──────────────────────────────────────────┘                         │
 │      │   │  has an executor?                                                  │
 │      │   ├─ yes ─▶ guard cancelled → parse input → INSERT invocation          │
 │      │   │         → CHARGE estimate ─── fails ──▶ tool error to the model    │
 │      │   │         → execute (may dispatch a child job)                       │
 │      │   │         → parse output → complete + reconcile actual cost          │
 │      │   │         → failure? refund this tool, keep the turn alive           │
 │      │   │                                                                    │
 │      │   └─ no ──▶ INTERACTION: price it, persist payload, mint token,        │
 │      │             flush metadata, mark waiting, SUSPEND ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┼─▶ human
 │      │                                                    resolve or expire   │
 │      │             ◀─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┼─
 │      │             apply the resolution, mark running, feed it back as        │
 │      │             this tool's result                                         │
 │      │                                                                        │
 │      ├─ persist closed blocks progressively                                   │
 │      └─ model still wants a turn, and under the cap? ──▶ loop ────────────────┘
 │                                                                                │
 └────────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
 FINALIZE — exactly one of two, on every path, in one transaction
   ├─ message: status, blocks, text, cost, assets, tokens, served model
   ├─ generated media → attachment rows      ← idempotent by (invocation, url)
   ├─ run: terminal status                   ← conditional on non-terminal
   └─ refund the admission hold in full      ← so net cost = Σ tool charges
        │
        └─▶ emit a lifecycle webhook (never throws, never blocks)
```

**The loop returns a status and never throws.** An uncaught exception surfaces from the job runner
with no message and no stack, so everything is caught and converted. Exactly one finalize runs on
every path, and both refund the admission hold.

**Blocks are persisted progressively**, so a crash loses only the text still in flight. The
terminal write is one transaction: the message, the run status, generated-media rows and the refund.

**Every terminal write is conditional on a non-terminal status.** That single rule is what stops a
cancel from being overwritten by a turn that was already finishing, and it is why the compensating
paths compose rather than race.

### The charged tool wrapper

Every tool call passes through one ordered pipeline:

```
cancel guard → parse input → record invocation → charge estimate → execute → parse output → settle
```

The order is deliberate. **Charging happens before execution**, so credit exhaustion is caught
before any external cost is incurred and there is no late-settle race. A failed tool refunds itself.
Bad arguments create no invocation row at all, so a model that corrects itself leaves no failed card
behind. Provider costs, where reported, are reconciled against the estimate afterwards.

Remote work never runs inline. It goes to a child job keyed on the invocation, which **checkpoints
the provider's run id before its first poll** — so a restarted worker resumes the same paid job
instead of buying a second one. Between polls the machine suspends rather than holding a CPU.

**Failures are data, not exceptions.** A tool returns `{ok: false, error, retryable}` to the model,
which rephrases or explains. Raw provider text never reaches the model or the database.

### Human interaction

A tool declaring an `interaction` kind and **no execute function** is the mechanism: the missing
executor is what makes the loop park instead of run. The orchestrator mints a token, persists the
payload, flushes realtime metadata and suspends — it never inspects what it is suspending on.

One route resolves any kind, with a conditional update, so a double-submitted approval is a no-op
rather than a second resumption. Adding a new interaction kind is a registry entry and a schema
variant; the orchestration does not change.

---

## 5. Extension points

The claim this architecture makes is that the common kinds of growth are additive. Each has been
exercised.

**Tools.** One declaration carries name, description, Zod input/output, a credit estimator, an
executor, display metadata, and optionally what media it produces and what a resolution means.
Everything else derives: the schema sent to the model, validation, charging, the rendered card, and
the media library. Adding a tool is one file and one registry key.

**Skills.** Versioned guidance in `agent-skills/<name>/SKILL.md`, scanned and validated at startup.
Only names and descriptions enter the prompt; bodies are fetched through typed tools when the model
decides it needs them. Skill names from a model are untrusted input — paths are normalised, names
allowlisted, sizes capped, and loads budgeted per run.

**Interaction kinds.** As above — kind-agnostic orchestration, one resolve route.

The enforcement rule is mechanical: the agent loop and its state accumulator have had an empty diff
across every feature added since they were written — waitpoints, step-by-step execution, image
editing, catalog validation, uploads and webhooks.

---

## 6. Credits

An append-only ledger with a cached balance.

| Movement | When | Key |
|---|---|---|
| Admission hold | at send | `reserve:{runId}:{attempt}` |
| Tool charge | before executing | `charge:{invocationId}` |
| Tool refund | on tool failure | `toolrefund:{invocationId}` |
| Reconciliation | provider reports actual cost | derived from the charge |
| Admission refund | at terminal, always in full | reverses the run's reserve rows |

Net cost of a turn is the sum of its tool charges. The admission hold is a gate, not a price — it
exists so a turn cannot start without headroom, and it always comes back.

Two details that were bought with bugs. The hold is keyed **per attempt**, because a retry reuses
its run row and a run-only key reads as "already applied" — leaving a retried turn with no hold and
no way to refuse it for credits. And the refund **reads the run's reserve rows and reverses each**
rather than rebuilding a key, so a hold taken under an older key format still comes back.

Ledger writes insert first with `ON CONFLICT DO NOTHING` and only move the balance if a row was
actually inserted. Checking the balance first and catching the constraint violation both
double-charges on retry and aborts the surrounding transaction.

---

## 7. Failure handling

Every failure has a defined behaviour, a user-safe message and a way forward.

| Failure | Detection | Response |
|---|---|---|
| Model rate-limited or unavailable | stream error, classified structurally | user-safe copy, partial output preserved, retryable |
| Empty stream | no blocks produced | fail with an explanation, admission refunded |
| Malformed tool call | input parse fails | tool error back to the model, no invocation row |
| Mid-turn credit exhaustion | charge fails pre-execute | model told, wraps up, turn still completes |
| Cancellation | conditional status flip | partial output kept, started charges stand, hold refunded |
| Unanswered interaction | token timeout | resolution recorded as expired, model told, overlay cleared |
| Worker crash mid-tool | provider run id checkpointed | resumes the same paid job |
| Duplicate send | partial unique index | `409`, exactly one run row |
| Stale lock | job runner queried, never a timestamp | dead run released, new turn admitted |

Two rules underpin the table. **Liveness is never inferred from age** — a run parked on a question
for fourteen minutes looks stale and is perfectly healthy, so the job runner is asked and a *failed*
query is treated as "still alive". And **charges for work already started stand**: the provider may
have done and billed it, so refunding would hand back credits for a real cost. One case is carved
out deliberately — a provider that answers with nothing usable at all. The user cannot act on "the
cropper returned no image", so that cost is absorbed rather than passed on, and the invocation
refunds in full.

Cancel orders its effects deliberately: our rows flip first (conditionally), then the machine is
stopped, and only then are parked tokens released. Releasing a token first would wake the task,
which would then spend a model request finishing a turn the user just cancelled.

Every failed turn carries a user-safe message, its tool outcomes, its partial output and a retry
affordance — explainable from the interface alone, without reading logs.

---

## 8. Realtime and recovery

Two channels with different semantics: a **metadata snapshot** carrying the latest state (phase,
block structure, tool states, current reasoning, any pending interaction), and an **append-only text
stream** carrying tokens.

The snapshot is re-sent whenever anything in it changes, so everything in it is bounded — block
projections capped, long inputs truncated with a visible ellipsis, reasoning kept to a tail. The
full values live in the database for the finished view.

Recovery is one path, not a special case: fetch the conversation, ask whether a run is active, and
if so resubscribe. Because the live and persisted views render from the same shapes, a reload
mid-turn rebuilds the screen from Postgres and picks the stream back up. Tokens are short-lived and
refreshed proactively; a dropped subscription falls back to polling within bounded retries.

---

## 9. Public API and webhooks

The public REST API is **the same API**. Its route wrapper differs from the internal one in exactly
one respect — the caller is identified by a bearer API key rather than a session. Parsing, the
response envelope, error mapping and every service are shared, so the two cannot diverge. Message
submission is literally one function called by both.

Keys are stored as SHA-256 hashes and returned once. A password hash's work factor exists to slow
brute force against low-entropy human secrets; a 192-bit random token has nothing to brute-force,
and a slow hash would tax every authenticated request instead. Revocation marks rather than deletes,
so an audit line naming a leaked key still resolves.

Direct tool execution is a real run: it creates a run and an invocation and goes through the same
charged wrapper the agent uses, so it is priced, reconciled, exactly-once and visible in usage
without a second code path. Like the provider API it calls, it is accepted-then-poll rather than a
request held open for the length of a generation.

Four lifecycle webhooks — agent started, completed, failed, and tool completed — are signed with
HMAC-SHA256 over `{id}.{timestamp}.{body}`. Emission writes a delivery row and hands the send to a
durable job with bounded backoff; a delivered row is never sent twice. **Emission never throws**: a
turn's outcome must not depend on whether a customer's receiver is reachable.

The published API reference is generated from the same schemas the routes validate against, so
documentation cannot drift from enforcement.

---

## 10. Scalability

The system is designed for these three pressures; the mechanisms below are the arguments, and the
thresholds are configuration rather than rewrites.

**Many tools and skills.** Only skill *names and descriptions* enter the base prompt, and bodies are
fetched on demand — so a large library costs a few hundred tokens, not tens of thousands. That part
is built, and it is what actually scales to a hundred skills.

Tools do not have the equivalent: the loop declares the whole registry on every request, because at
eight tools a selection mechanism would cost more than it saves. The seam for it exists — `tags` on
every declaration, already read by the public API's direct-run gate — so the upgrade is a filter at
one call site, passing a tag-matched subset plus an always-on core rather than `registry`. Until a
registry is large enough for that to pay, declaring all of it is the cheaper correct answer.

**Long conversations.** Message reads are cursor-paginated on a composite index, with no unbounded
scans anywhere. Prompt context is bounded to a recent window rather than growing with the chat.
Search uses trigram indexes over titles and message content.

**Many concurrent turns.** The API is stateless and horizontally scalable; the work is queued rather
than held. Per-chat serialisation is a database constraint, so it holds regardless of how many
instances are running. Turns suspend while waiting on a provider or a human, so a parked turn
consumes no compute. Realtime payloads are bounded, and the connection ceiling is a per-plan
configuration rather than a design limit.

---

## 11. Deliberate simplifications

Each is a scope decision with a known upgrade path, not an oversight.

- **Top-up is not a payment flow.** It exists so the ledger is exercised in both directions and an
  exhausted account has a way forward.
- **Prompt context is a recent-message window**, not token-budget assembly with summarisation.
- **Search is trigram `ILIKE`** rather than full-text search; right at this scale, and `tsvector` is
  the upgrade.
- **Rate limiting is a per-account counter in Postgres**, not a distributed sliding window.
- **Model availability is a single shared row**, so one account's rate limit warns everyone. The
  free-model path genuinely is shared, but per-account status is the more correct model.
- **Upload results live on the transform provider's temporary storage** and expire after 24 hours.
  The expiry is surfaced as state rather than hidden; durable object storage is the upgrade.
- **Assembly completion is reported by the uploading client**, not confirmed with the transform
  provider. The reported `url` is constrained to the provider's own result host, matched on the
  parsed hostname, so it cannot name an arbitrary address. What is still taken on trust is `size`,
  which the monthly quota is decremented by — under-reporting it stretches the allowance, at the
  account's own expense and within the per-file cap the schema enforces. Neither the row nor the
  quota is reachable across accounts: the upsert is ownership-checked and a guessed `assemblyId`
  answers `NOT_FOUND`. Re-fetching the assembly and taking `size` and `mime` from *its* response is
  the remaining hardening step.
- **Retries are manual.** Automatic retry replays narrative the user has already seen and re-runs
  paid work, because regenerated tool ids no longer match the persisted rows.
- **Some declared surfaces have no producer yet.** `citations` is a content block with a renderer,
  and `system` and `tool` are message roles, because the brief names all three — but nothing in this
  build emits one: no tool returns sources, and the loop carries system text as an instruction
  rather than a row. They are modelled rather than dropped so that adding a retrieval tool is a tool
  and a renderer, not a schema migration and a contract resync across both repos.
