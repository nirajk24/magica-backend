-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "expiresAt" TIMESTAMPTZ(3),
ADD COLUMN     "rateLimitPerDay" INTEGER,
ADD COLUMN     "rateLimitPerMinute" INTEGER;
