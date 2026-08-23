-- Moves the default model for new chats. Superseded by 20260822213905_default_model_free_router.
--
-- Compatibility: both directions. The default applies to inserts that omit `modelId`; existing
-- chats keep whatever they were created with, and the API always sends the column explicitly.
--
-- Rollback: ALTER TABLE "Chat" ALTER COLUMN "modelId" SET DEFAULT 'google/gemma-4-31b-it:free';

-- AlterTable
ALTER TABLE "Chat" ALTER COLUMN "modelId" SET DEFAULT 'nvidia/nemotron-3-super-120b-a12b:free';
