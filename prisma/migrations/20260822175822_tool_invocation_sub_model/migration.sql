-- Records which provider model a Magica node actually served, which differs from the chat's
-- model and is reported per invocation.
--
-- Compatibility: both directions. Nullable and additive, so old code ignores it and rows
-- predating the column read as NULL — the same as an invocation that reported no sub-model.
--
-- Rollback: ALTER TABLE "ToolInvocation" DROP COLUMN "subModelId";

-- AlterTable
ALTER TABLE "ToolInvocation" ADD COLUMN     "subModelId" TEXT;
