/*
  Warnings:

  - You are about to drop the column `lastRoutedModel` on the `LlmStatus` table. All the data in the column will be lost.

  The row records which model is rate limited, not which one last served — the latter was
  telemetry nothing read.

  Compatibility: deploy code first, as with any drop. `LlmStatus` is a single-row cache that
  the next provider response rewrites, so the lost value costs nothing.

  Rollback:
    ALTER TABLE "LlmStatus" DROP COLUMN "limitedModel",
      ADD COLUMN "lastRoutedModel" TEXT;
*/
-- AlterTable
ALTER TABLE "LlmStatus" DROP COLUMN "lastRoutedModel",
ADD COLUMN     "limitedModel" TEXT;
