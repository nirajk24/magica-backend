# Low-Level Design

How the pieces in [`ARCHITECTURE.md`](./ARCHITECTURE.md) are actually built: what each module owns,
the invariants a change must not break, and the traps this stack sets.

`src/contracts/` is the source of truth for every shape on the wire. This document describes the
design around those schemas rather than reproducing them, so the two cannot drift.

---

## 1. Module map

```
src/
├── app/api/                REST surface — thin handlers, no business logic, no Prisma
│   ├── v1/                 the application API (session-authenticated)
│   └── public/v1/          the public API (API-key authenticated)
├── contracts/              Zod schemas + inferred types. Imports nothing from src/
├── lib/                    framework-level building blocks; may touch the database
├── services/               business logic, one domain each
├── agent/                  the turn loop and its collaborators — no task definitions
├── tools/                  the tool registry and everything a tool needs
├── prompts/                system prompt assembly and model-message conversion
└── trigger/                task definitions only — every file here is a build entry point
```

Layering runs one way: **route → service → `lib` → database.** A route never touches Prisma; a
service never imports another service. Two named exceptions, both deliberate:

- **A composition service** exists where two routes must run the identical multi-service use case.
  `message-submit.service.ts` is called by both the application send route and the public API's
  submission endpoint, which differ only in how the caller was authenticated. Duplicating that path
  is the failure the layering rule exists to prevent.
- **Authentication primitives live in `lib/`** even though they query the database, because the
  request pipeline itself authenticates with them, and a `lib` module importing a service would
  invert the direction every route depends on.

### `lib/`

| Module | Owns |
|---|---|
| `env.ts` | the validated environment. Parsed at import, so a missing variable fails at boot, by name |
| `api.ts` | the route pipeline: `defineRoute`, `definePublicApiRoute`, `definePublicRoute`, `preflight` |
| `db.ts` | the Prisma client and the transaction type |
| `errors.ts` | `AppError` (HTTP-facing) and `ToolError` (model-facing), plus the status map |
| `credits/` | the only writer of ledger entries and balances |
| `logger.ts` | structured JSON logging and context binding |
| `ids.ts` | uuidv7 — time-sortable, so `(createdAt, id)` is monotonic without a counter |
| `cursor.ts` | opaque keyset cursors over `(timestamp, id)` composites |
| `rate-limit.ts` | per-account send allowance |
| `users.ts` | account bootstrap and the signup grant |
| `models.ts` | model identity description |
| `llm-status.ts` | shared model availability |
| `skills/` | scanning and loading skill files |
| `transloadit.ts` | upload signing and plan limits |
| `api-keys.ts` | key minting, hashing and resolution |
| `webhook-signature.ts` | signing and verification |
| `webhook-emit.ts` | the one call sites use to publish a lifecycle event |

### `services/`

One domain each: `chat`, `message`, `message-submit`, `turn`, `run`, `waitpoint`, `attachment`,
`usage`, `api-key`, `webhook`, `tool-run`.

### `agent/`

`run-agent-turn.ts` (the loop), `turn-state.ts` (block and segment accumulation), `llm.ts` (the
model adapter), `tool-runtime.ts` (the effects half of the tool wrapper), `interaction.ts`
(pricing a proposed call).

**Why the agent is not in `src/trigger/`:** the task builder treats every file in that directory as
its own entry point. Keeping implementation there produced extra bundle entries for nothing and
stopped the directory from telling you what was actually a task.

---

## 2. The request pipeline

`lib/api.ts` provides three wrappers over one implementation:

| Wrapper | Caller identified by |
|---|---|
| `defineRoute` | Clerk session |
| `definePublicApiRoute` | bearer API key |
| `definePublicRoute` | nobody — unauthenticated probes |

They differ **only** in how `userId` is resolved. Everything downstream is shared: Zod parsing of
body and query, the account bootstrap, the `{ data }` / `{ error }` envelope, CORS headers, the
trace id bound into the logger and echoed to the client, and error mapping.

Handlers therefore contain no validation and no error handling. They receive a guaranteed `userId`
whose row exists, already-parsed input, and throw an `AppError` for a specific status.

Three behaviours worth knowing:

- **A non-JSON body is a `400`, never a `500`.** `req.json()` is caught and converted.
- **BigInt is serialised, not thrown on.** `JSON.stringify` throws on a BigInt, so one forgotten
  conversion would be an opaque 500. The responder converts to the string every DTO declares.
- **Anything not an `AppError` or `ZodError` becomes a generic `INTERNAL`**, so provider text and
  stack traces cannot reach a client.

CORS headers are applied by the shared responder, on success *and* error paths. Attaching them only
to preflight passes a curl check and fails a browser.

---

## 3. Contracts

`src/contracts/` holds four modules and a barrel:

- `blocks.ts` — the content-block union: text, thinking, tool use, tool result, usage.
- `messages.ts` — `MessageDTO`, `ChatDTO`, `ToolInvocationDTO`, `AssetDTO`, `AttachmentDTO`.
- `api.ts` — every request and response shape, the error-code union, model allowlist.
- `realtime.ts` — the run metadata snapshot and stream shapes.

Rules:

- **It imports nothing from `src/`.** That is what makes it safe to copy wholesale to the client.
- **Credits are `BigInt` in the database and `string` on the wire.** `Number()` loses precision.
  One conversion point, in `message.service.ts`.
- **The client syncs a committed copy**, and its build fails on a byte-level mismatch. Changing a
  contract is therefore a cross-repo change, not a local one.
- **Never accept a schema variant the server alone should write.** The waitpoint resolution union
  includes an expiry variant; the route parses a narrower schema that excludes it, or a client could
  expire its own interaction through a path that skips the timeout.

---

## 4. Credits

`lib/credits/` is the only module that writes `CreditLedgerEntry` or `User.creditBalance`.

Every movement goes through one `entry()` primitive:

1. Insert the ledger row with `ON CONFLICT DO NOTHING`.
2. If no row was inserted, the movement already happened — return, having changed nothing.
3. Only then move the balance, conditionally.

**Order matters and the reverse is a real bug.** Checking the balance first and catching the unique
violation double-charges on retry *and* poisons the surrounding transaction — a caught error inside
Postgres aborts it, which takes down whatever else the request was doing.

Keys: `reserve:{runId}:{attempt}`, `charge:{invocationId}`, `toolrefund:{invocationId}`,
`grant:{userId}`, `top_up:{userId}:{clientKey}`. A client-supplied idempotency key is always scoped
by account, or two callers choosing the same value collide.

`refundAdmission` reads the run's reserve rows from the ledger and reverses each, rather than
rebuilding a key. Its signature therefore never changes when a key format does, and a thrice-retried
run cannot leave a hold behind.

The invariant `balance === SUM(ledger)` is asserted after every scenario in the credit tests.

---

## 5. The agent turn

### The shell and the loop

`trigger/agent-turn.ts` is a thin task that binds dependencies; `agent/run-agent-turn.ts` is a pure
function over them. The injected surface is: bootstrap, stream start, block persistence, waitpoint
suspension, both finalizers, a clock and a logger.

That seam is the whole testing strategy for the turn: block ordering, segment breaks, turn caps and
which finalizer ran are all asserted with no database, no job runner and no model — driven by a
scripted array of stream parts.

**The loop never throws.** An uncaught exception is reported by the job runner with no message and
no stack, so everything is caught and converted through the failure finalizer. `AppError` and
`ToolError` copy passes through; anything else becomes one generic sentence.

**Exactly one finalizer runs on every path**, and both refund the admission hold.

**The failure finalizer takes the blocks.** An earlier version took only a reason, so a failed turn
persisted with no blocks — every partial answer and tool card the user had just watched vanished.

### Block accumulation

`agent/turn-state.ts` owns two rules that are easy to get wrong.

**Segments** group the timeline into the step groups a client renders. A segment break is *queued*
on closing a text block, not applied eagerly — that is what stops a turn ending in prose from
opening a group nothing ever fills. Reasoning does not break a segment; resolving an interaction
does.

**Stream offsets.** Only text blocks carry a character count. Reasoning goes to its own metadata
field and never onto the text stream, so counting it would shift every later text block by the
whole thinking transcript. Both sides of that seam were separately correct and only disagreed at
the boundary.

### The model adapter

`agent/llm.ts` is the one place the AI SDK's part names appear. It maps them to an internal union,
counts every model request including the SDK's inner tool rounds, classifies stream errors
structurally (never by `instanceof` — the provider bundles its own copy of the error classes), and
notifies availability on a rate limit through an injected callback.

Reasoning must be requested at the model or it is silently dropped with no error.

The base prompt is passed as instructions, **not** as a system message inside the message array;
the SDK rejects the latter.

### Message conversion

`prompts/system.ts` builds the request messages. One invariant: **every tool call emitted has a
matching tool result.** A resumed turn replays only what it can answer, because one dangling call
makes a provider reject the entire request. Reasoning is never replayed.

Files carried by earlier messages — uploads and generated media alike — are appended to the
model-facing message as labelled context lines, never written into the stored content. That is what
makes "edit that image" work across turns.

---

## 6. Tools

### The registry

`tools/define.ts` declares what a tool is; `tools/registry.ts` is an import and a key per tool.

A declaration carries: name, description, tags, Zod input and output, a credit estimator, display
metadata, and optionally an executor, the media it produces, an interaction kind, a `prepare` hook
and an `applyResolution` hook.

Two seams make interaction tools work without the orchestrator knowing what they mean:

- **`prepare(input, ctx)`** returns either a payload to park on, or a resolution that makes parking
  pointless. It is given a pricing function — the same estimator that charges at execution — so a
  figure shown to a user can never be one a model invented.
- **`applyResolution(resolution, payload, fx)`** says what a resolution *does*. The orchestration
  supplies a small set of effects and learns nothing about the domain.

**A tool with no executor is the termination signal** that parks a run. This is load-bearing: an
executor on an interaction tool would turn an approval gate into a plan that approves itself.

### The wrapper

`tools/to-ai-sdk.ts` owns the ordering; `agent/tool-runtime.ts` performs the effects. The split
exists so the ordering can be asserted as a call log against fakes:

```
isRunActive → beginInvocation → chargeEstimate → execute → completeInvocation
```

and, on a failed charge, a log containing **no execute**.

Invocations are idempotent on `(runId, toolUseId)`, which keeps the charge key stable. Bad arguments
create no invocation row. Provider-reported costs are reconciled; an uncollectable shortfall is
logged and stops at zero rather than failing finished work.

### The provider client

`tools/magica-client.ts` is the single adapter: submit, then poll to a terminal status, with the
poll ceiling a parameter rather than a constant so a video merge can have a different budget from an
image crop.

`tools/catalog-schema.ts` stores each sub-model's live input-field specification from the same
catalog fetch that hydrates pricing, and every outbound request is checked against it *before* the
durable dispatch. A stale field name comes back as a correctable tool error instead of a provider
rejection after a child job was already spawned.

**Pricing fails closed; field specs fail open.** An unpriced node must refuse to run — it is money.
A missing catalog must not turn every generation into a failure, so schemas fall back to the Zod
transport guard. There is deliberately no committed copy of field specs: a committed copy is exactly
the stale duplicate the live lookup exists to replace.

---

## 7. Skills

Versioned guidance under `agent-skills/<name>/SKILL.md` with YAML frontmatter. Scanned and validated
at startup; malformed frontmatter, duplicates and traversal attempts are rejected there.

Only names and descriptions enter the base prompt. Bodies and assets are fetched through
`load_skill` and `read_skill_asset`, which are ordinary registry entries.

Constraints, because a skill load costs a model request:

- A per-run budget of distinct loads, enforced in the loader as distinct persisted rows. A repeat
  load never counts and never errors — it is a deduplication.
- Reading an asset requires its skill to be loaded first, which prevents a second path around the
  budget without duplicating the budget logic.
- Loads are persisted with content hashes, so a resumed run is deterministic.

**Everything needed on every turn belongs in the base prompt, not behind a loader.** Capability
questions were a skill once; behind a loader they burned a request on the cheapest kind of turn.

`skillsRoot()` searches upward from the module's own directory, bounded, and **throws** when the
directory is absent. A fixed number of `..` hops is correct in the repository and wrong in a bundle,
because bundlers flatten chunks and the file's depth stops being constant. An empty registry must
never be the fallback — it is the silent failure the search exists to prevent.

---

## 8. Interactions

A run parks by calling a tool that declares an interaction kind and has no executor.

`suspendOn` owns the whole lifecycle — mint the token, persist the row, flush realtime metadata,
park, close the row, clear metadata — so no token id ever crosses a seam. **Flushing before parking
matters**: without it, a reload during a wait renders no interaction at all.

Parking happens inside the same invocation begin/complete pair every other tool uses. That gives the
interaction a duration, a result row and a persisted timeline entry, and fills the waitpoint's
invocation reference, which would otherwise be a column nothing wrote.

The run's status flips to a distinct waiting state while parked and back on resume, both conditional
on non-terminal — so a cancel during a wait is not undone by the task finishing its own bookkeeping
afterwards.

Resolution: ownership is part of the lookup and a miss answers not-found (a 403 would confirm the id
exists); the submitted kind is checked against the row; the update is conditional on still being
pending; the token is completed only by the caller that won that update. Zero rows means already
answered (a no-op success) or expired (a gone status the client can clear from).

Image answers carry attachment **ids** from the client and are resolved to URLs server-side at
resolution time — the model never sees a client-supplied URL.

---

## 9. Uploads and attachments

`POST /uploads/sign` returns one signed assembly **per file**, because the assembly id is unique per
attachment row. The instructions are inline in the signed string rather than a stored template, so
they cannot be altered by a client and nothing lives outside the repository; the expected file count
is inside the signature too, so one signature cannot be reused for a batch.

Plan limits are enforced **before anything is signed** — per-file size and a monthly byte allowance —
because a signature for a file that can never land is a promise the plan cannot keep.

Completion is reported by the uploading client and upserted on the assembly id, so a duplicate
report lands on the same row. A `ready` row is sticky: a replayed non-ready report never downgrades
one that already carries its result. Monthly usage increments exactly once, on the transition into
ready, inside the same transaction as the row.

Attachments are bound to a message inside the send transaction — existence, ownership and readiness
or the whole admission rolls back — with an explicit `position` column, so ordering is guaranteed
rather than incidental.

Generated media is written at finalize as attachment rows with a generated source, idempotently by
invocation and URL so a retried attempt cannot list the same file twice.

---

## 10. Public API, keys and webhooks

Covered in [`ARCHITECTURE.md`](./ARCHITECTURE.md) §9. The implementation notes that matter here:

- Key format is checked before any database lookup, so a malformed bearer value never becomes a
  query.
- Hash comparison is constant-time.
- A direct tool run creates its rows and dispatches through **one service function** — the same
  single-path discipline `dispatchTurn` has for agent turns.
- Webhook emission catches everything internally and reports through a callback, so it satisfies
  "never throws" by construction rather than by every call site remembering to wrap it.
- Delivery is a durable task with bounded exponential backoff; an already-delivered row short
  circuits, so a retried task cannot resend.
- Task references are **static imports**. Dynamic imports of task modules resolve differently inside
  a deployed bundle — the same class of failure as a fixed-hops data path.

---

## 11. Testing

| Layer | Runs against | Rule |
|---|---|---|
| unit | injected fakes | the loop, the wrapper ordering, pure mappers. No database, no network |
| integration | real Postgres + mocked HTTP | `onUnhandledRequest: "error"` — an escaped request is a failing test |
| acceptance | real providers | environment-gated, run deliberately, never in the suite |

**The whole suite makes zero live provider calls.** Mocked handlers are built from the same schemas
the routes parse, and provider fixtures come from an archived live catalog rather than from memory,
so the mocks match reality by construction.

Two suites guard things that are invisible until they break:

- The **request-boundary suite** covers authentication, malformed bodies, schema failures, an
  `AppError` keeping its status, an unexpected throw leaking nothing, CORS on success *and* error, a
  BigInt on the wire, and the account bootstrap under concurrent callers.
- The **schema suite** reads `information_schema` and asserts the hand-written partial unique
  indexes still exist *with their `WHERE` clauses*, that trigram indexes are present, and that
  database-level defaults match the constants the code depends on. It checks the database, not the
  file it was built from.

Habits that catch what tests do not:

- `pnpm check:wiring` after any change — it fails on an export nothing reaches. A module with
  passing tests and no caller is not finished. It counts *cross-file* references, so confirm a
  same-file export by grep before acting on it.
- `pnpm trigger:dev` after touching anything in the task import graph. A task's entire graph runs at
  index time, so a module that spawns a thread at import breaks the **build** while every other gate
  stays green.
- `npx trigger.dev deploy --dry-run` builds the real deploy bundle without deploying. It is the only
  local way to inspect what will actually ship.

---

## 12. Traps in this stack

Each of these cost real debugging time.

### Deployment and build

| Trap | Symptom | Guard |
|---|---|---|
| Deploying the web app alone | tasks silently run old code | **two deploys, every time** |
| Task environment set to only the obvious variables | *every* task crashes at boot | a task imports the database module, which parses the whole environment schema at import — the dashboard needs every non-optional variable, including ones no task reads |
| A module that spawns a thread at import (e.g. a pretty-printing log transport) | the task **build** fails, with a message naming nothing relevant, while typecheck, lint, web build and the full test suite stay green | only `pnpm trigger:dev` catches it |
| Resolving a shipped data directory by a fixed number of `..` hops | correct in the repository, wrong in a bundle — bundlers flatten chunks, so depth is not constant | search upward, bounded, and throw when absent |
| Dynamic `import()` of a task module | resolves differently inside a deployed bundle | static imports only |
| Assuming a deploy-only build behaviour cannot be checked locally | a real gap ships unverified | `deploy --dry-run` |
| `prisma generate` in `postinstall` resolving config through eager `env()` | install fails on a fresh clone with no environment file — the exact case postinstall exists to serve | resolve permissively there; fail by name at app boot instead |

### Prisma and Postgres

| Trap | Symptom | Guard |
|---|---|---|
| `migrate dev` and hand-written indexes | it reverts anything it can model, including trigram indexes | declare in the schema whatever Prisma *can* express; only truly inexpressible things (a partial index's `WHERE`) stay raw |
| Forgetting to regenerate after a migration | the client still describes the old schema, so the next query names a column that no longer exists — a generic 500 from a route that did not change | regenerate, and restart anything running: the client is held in the module cache and survives hot reload |
| `migrate dev` on a diff that drops a column | refuses to run non-interactively, blocking CI and any automated session | hand-write the migration with its rollback in a comment and apply with `migrate deploy` |
| `updatedAt: undefined` in an update | means "not provided", so the auto-timestamp fires anyway — a rename reorders a list, and can skip or repeat a row mid-pagination when the timestamp is half the cursor | read the current value and write it back explicitly |
| Two `OR` keys in one filter object | the second silently replaces the first — a cursored search restarts the whole result set on every page | wrap each in its own clause under one `AND` |
| `undefined` for a nullable JSON column | means "leave unchanged", so a reset keeps the previous attempt's output | write the database-null sentinel |
| `JSON.stringify` on a BigInt | throws at runtime | one conversion point, plus a serializer in the responder as a backstop |

### Correctness

| Trap | Symptom | Guard |
|---|---|---|
| A ledger key that omits the attempt | a retried turn holds **no** admission and can never be refused for credits, while the balance invariant stays perfectly intact | key by attempt; the gate is what was lost, not the arithmetic |
| Rebuilding a refund key instead of reading the ledger | a hold taken under an older key format is never returned | reverse the rows that exist |
| A client-supplied idempotency key used unscoped | two accounts choosing the same value collide; the second silently gets nothing | scope by account |
| Judging a suspended run by its age | a healthy run parked on an interaction is declared dead, refunded, and a second turn admitted beside it | never infer liveness from a timestamp; ask the job runner, and treat a *failed* query as "still alive" |
| Unconditional writes after a task wakes | a cancel that already swept the row, or a resolution that already landed, is overwritten by the task finishing its bookkeeping | every post-park write is conditional on still being pending or non-terminal |
| An interaction with no invocation row | it has no duration, no result, and vanishes on reload — the persisted timeline renders from invocations | park inside the same begin/complete pair every other tool uses |
| A column read everywhere and written nowhere | a field is in the schema, the select, the DTO and the contract, and is always null | write it where it is first known, not at the end |
| A field whose name promises more than it holds | a client binds to it and shows null until something breaks, then shows the name of the thing that failed | name it for what it actually records |
| An unbounded value in a realtime snapshot | the snapshot is re-sent on every change, so one long value is multiplied by the number of updates | bound every field in it; the database keeps the full value |
| Leaving a wait on its default timeout | the design says one duration and the runtime uses another, visible only as something expiring early | state it explicitly at the call site |

### Testing

| Trap | Symptom | Guard |
|---|---|---|
| A test asserting a literal id that lands in a unique column | passes once, then poisons every later run — a suite killed before cleanup leaves the value behind | mint unique ids; assert against what the response returned |
| A test asserting exact registry membership or a total | the next tool added fails it | partition by tag and assert what must be present |
| Reading `body.data?.x ?? []` before checking the status | a 500 reads as a plausible empty result | assert the status first |
| Editing source while a suite runs, or running two suites at once | a timing number that looks like evidence and is not | one run at a time, no edits during it |
| A hand-copied credential one character short | every local gate stays green, because signing works on any string; only the live call fails | length-check a pasted credential against the provider's documented format |

---

## 13. Operations

**Environment.** `lib/env.ts` parses at import and fails by name. Optional variables are genuinely
optional — a feature-specific credential must not be required, or every task crashes at boot over a
feature no task uses; the route that needs it produces the named failure instead.

**Migrations.** Forward-only, applied with `migrate deploy` in any non-interactive context. Each
migration carries its rollback statement in a comment. After any migration, regenerate the client
and restart running processes.

**Deploys are always two:** the web application and the task worker. The application deploy alone
leaves the worker running previous code.

**Logging** is structured JSON with correlation keys — chat, run, message, trace, process, delivery
— bound at the boundary and inherited by everything downstream. No pretty-printing transport, ever:
it runs in a worker thread that does not exist inside the task bundle.
