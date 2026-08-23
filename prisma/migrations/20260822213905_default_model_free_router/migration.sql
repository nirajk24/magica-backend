-- New chats default to the free router rather than one named free model, so a single model
-- going unavailable does not take new chats down with it.
--
-- Compatibility: both directions. Existing chats keep their own `modelId`, and the API sends
-- the column explicitly on create.
--
-- Rollback: ALTER TABLE "Chat" ALTER COLUMN "modelId"
--             SET DEFAULT 'nvidia/nemotron-3-super-120b-a12b:free';

-- AlterTable
ALTER TABLE "Chat" ALTER COLUMN "modelId" SET DEFAULT 'openrouter/free';
