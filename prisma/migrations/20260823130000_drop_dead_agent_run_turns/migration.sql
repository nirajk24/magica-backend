-- The column was declared in migration #1 and written by nothing: the turn count the loop
-- tracks is returned in memory and logged, never persisted. Every existing row holds the
-- untouched default.
--
-- Rollback: ALTER TABLE "AgentRun" ADD COLUMN "turns" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentRun" DROP COLUMN "turns";
