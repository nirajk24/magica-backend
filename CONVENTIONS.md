# magica-backend

Agent-chat backend for the Magica clone. Next.js route handlers + Prisma/Postgres, with the
agent loop running as a durable Trigger.dev task.

**Design docs:** `LLD.md` (phased build plan, full contracts) and `ARCHITECTURE.md` (HLD, added
at Phase 1). Read `LLD.md` §0 before adding anything.

## Rules

- **Node 20.9+** (`.nvmrc` pins 20.20.2), pnpm. `nvm use` before any command.
- **Layering is one-directional:** route → service → `lib/db`. A route never touches Prisma;
  a service never imports another service (shared logic moves to `lib/`).
- **`src/contracts/` is the source of truth** and imports nothing from `src/`. The frontend
  syncs a committed copy — changing a contract is a cross-repo change.
- **`lib/credits` is the only writer** of `CreditLedgerEntry` and `User.creditBalance`.
- **Extension points are the registries.** Adding a tool, skill, or waitpoint kind is one
  entry. If a feature needs an edit to `trigger/run-agent-turn.ts`, the seam is missing —
  add the seam instead.
- **Credits are `BigInt` in Prisma and `string` on the wire.** `Number()` loses precision, so
  every DTO declares a string. One conversion point, in `message.service.ts`; `lib/api.ts`
  serializes any BigInt that slips past it rather than letting `JSON.stringify` throw a 500.
- **Every `DateTime` is `@db.Timestamptz(3)`** and every table has `createdAt` + `updatedAt`
  with database-level defaults, so raw-SQL inserts and CDC both work.
- **Two deploys, every time:** `pnpm build` (Vercel) does not ship tasks. Run
  `pnpm trigger:deploy` as well or the deployed tasks are stale.
- **`pnpm trigger:dev` must boot at the end of every step that touches `src/trigger/` or anything
  it imports.** A task's entire import graph runs at index time, so a module that spawns a thread at
  import — a pino transport is the one that bit us — fails the *build* with a message naming nothing
  relevant, while `tsc`, `eslint`, `next build` and the whole test suite stay green.
- **`src/trigger/` holds task definitions only.** Trigger builds every file in it as an entry point;
  the agent implementation lives in `src/agent/`.
- **`pnpm check:wiring` at the end of every step.** It lists exports reached only from tests, and
  fails on exports reached from nowhere. A module with passing tests and no caller is not finished —
  that pattern has already shipped three times here. Account for every line: either it is the next
  step's work, or it is a wiring bug.
- **After any migration, `pnpm db:generate`.** `migrate dev` syncs the database but leaves the
  generated client describing the old schema, so the next query sends a column that no longer
  exists. `tests/integration/schema.test.ts` asserts the shape the code depends on.
- **Raw-SQL migrations:** partial unique indexes are hand-written because Prisma cannot
  express a `WHERE` clause. Verified safe — `migrate dev` leaves them alone. Anything Prisma
  *can* express (including GIN with `gin_trgm_ops`) must be declared in the schema, or the
  next `migrate dev` generates a migration that drops it.

## Comments

No inline comments. JSDoc only on exported module boundaries — one block saying what it does
and any invariant a caller must not break. Strict TS and Zod schemas are the documentation.
Reasons live in `docs/decisions.md`, not in the code.

<!-- TRIGGER.DEV SKILLS START --><!-- TRIGGER.DEV SKILLS END -->
