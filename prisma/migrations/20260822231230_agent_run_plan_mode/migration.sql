-- Whether the turn was started in plan mode, which decides the system prompt and whether the
-- plan tools are offered. Held on the run, not the chat: the mode is chosen per send.
--
-- Compatibility: both directions. NOT NULL with a default, so the backfill is implicit and
-- existing runs read as `false` — the mode they actually ran in.
--
-- Rollback: ALTER TABLE "AgentRun" DROP COLUMN "planMode";

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "planMode" BOOLEAN NOT NULL DEFAULT false;
