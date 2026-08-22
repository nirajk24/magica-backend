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
- **Credits are `BigInt` in Prisma and `string` on the wire.** `JSON.stringify` throws on a
  BigInt and `Number()` loses precision. One conversion point, in `message.service.ts`.
- **Every `DateTime` is `@db.Timestamptz(3)`** and every table has `createdAt` + `updatedAt`
  with database-level defaults, so raw-SQL inserts and CDC both work.
- **Two deploys, every time:** `pnpm build` (Vercel) does not ship tasks. Run
  `pnpm trigger:deploy` as well or the deployed tasks are stale.
- **Raw-SQL migrations:** partial unique indexes are hand-written because Prisma cannot
  express a `WHERE` clause. Verified safe — `migrate dev` leaves them alone. Anything Prisma
  *can* express (including GIN with `gin_trgm_ops`) must be declared in the schema, or the
  next `migrate dev` generates a migration that drops it.

## Comments

No inline comments. JSDoc only on exported module boundaries — one block saying what it does
and any invariant a caller must not break. Strict TS and Zod schemas are the documentation.
Reasons live in `docs/decisions.md`, not in the code.

<!-- TRIGGER.DEV SKILLS START -->
## Trigger.dev agent skills

This project has Trigger.dev agent skills installed in `.claude/skills/`. Before writing or changing Trigger.dev code (background tasks, scheduled tasks, realtime, or chat.agent AI agents), load the most relevant skill: `trigger-authoring-chat-agent`.
<!-- TRIGGER.DEV SKILLS END -->
