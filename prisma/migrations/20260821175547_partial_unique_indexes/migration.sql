-- Partial unique indexes. Prisma cannot express a WHERE clause on an index, so these are
-- hand-written and MUST NOT be removed by a later `migrate dev` drift correction.
-- Verified after creation: Prisma leaves partial indexes alone because it cannot model them.
--
-- Compatibility: forward-only in practice. Creation fails if a chat already holds two live runs
-- or a run already holds two assistant messages, so it must be applied before the send path is
-- allowed to race. Old code is unaffected — it never wrote a duplicate deliberately.
--
-- Rollback: DROP INDEX "one_active_run_per_chat"; DROP INDEX "one_assistant_message_per_run";
-- Reverting removes the only thing serialising concurrent sends; application code has no
-- fallback lock.

-- One live run per chat. This constraint IS the concurrency lock: a duplicate send
-- collides in Postgres rather than racing in application code.
CREATE UNIQUE INDEX "one_active_run_per_chat"
  ON "AgentRun" ("chatId")
  WHERE status IN ('queued', 'running', 'waiting');

-- One assistant message per run. Makes the agent-turn bootstrap idempotent, which is also
-- the retry reset path.
CREATE UNIQUE INDEX "one_assistant_message_per_run"
  ON "Message" ("runId")
  WHERE role = 'assistant';
