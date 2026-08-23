-- Per-key throttles and expiry, all nullable because NULL means "inherit the account default"
-- rather than zero. A key issued before this migration keeps the account allowance and never
-- expires, which is the behaviour it was issued under.
--
-- Compatibility: both directions. Additive and nullable, so old code ignores the columns and
-- reverting only drops per-key overrides back to the account default.
--
-- Rollback:
--   ALTER TABLE "ApiKey" DROP COLUMN "expiresAt",
--     DROP COLUMN "rateLimitPerDay",
--     DROP COLUMN "rateLimitPerMinute";

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "expiresAt" TIMESTAMPTZ(3),
ADD COLUMN     "rateLimitPerDay" INTEGER,
ADD COLUMN     "rateLimitPerMinute" INTEGER;
