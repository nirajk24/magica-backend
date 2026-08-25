-- AlterTable
ALTER TABLE "ToolInvocation" ADD COLUMN "failureCode" TEXT;

-- CreateIndex
CREATE INDEX "ToolInvocation_failureCode_createdAt_idx" ON "ToolInvocation"("failureCode", "createdAt" DESC);
