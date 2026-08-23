-- Baseline: every enum, table, index and foreign key. `pg_trgm` backs the two GIN indexes that
-- serve search, so the extension must be creatable by the migration role.
--
-- Compatibility: none to hold — this is the first migration, and no code predates it.
--
-- Rollback: DROP SCHEMA "public" CASCADE; CREATE SCHEMA "public";
-- Destructive by definition. There is no partial revert of a baseline.

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('signup_grant', 'top_up', 'reserve', 'settle', 'refund');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('user', 'assistant', 'system', 'tool');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('streaming', 'success', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('queued', 'running', 'waiting', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "InvocationStatus" AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "WaitpointStatus" AS ENUM ('pending', 'completed', 'expired');

-- CreateEnum
CREATE TYPE "WaitpointKind" AS ENUM ('plan_approval', 'questions');

-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM ('uploading', 'ready', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "AttachmentSource" AS ENUM ('uploaded', 'generated');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "creditBalance" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditLedgerEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "runId" TEXT,
    "invocationId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CreditLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chat" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'New task',
    "isFavorite" BOOLEAN NOT NULL DEFAULT false,
    "modelId" TEXT NOT NULL DEFAULT 'google/gemma-4-31b-it:free',
    "activePlan" JSONB,
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Chat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'success',
    "content" TEXT NOT NULL DEFAULT '',
    "contentBlocks" JSONB,
    "attachments" JSONB,
    "assets" JSONB,
    "aiModel" JSONB,
    "tokenUsage" JSONB,
    "creditUsed" BIGINT NOT NULL DEFAULT 0,
    "feedback" TEXT,
    "metadata" JSONB,
    "errorMessage" TEXT,
    "sequence" BIGINT NOT NULL DEFAULT 0,
    "runId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'queued',
    "triggerRunId" TEXT,
    "userMessageId" TEXT NOT NULL,
    "assistantMessageId" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "executionMode" TEXT NOT NULL DEFAULT 'auto',
    "idempotencyKey" TEXT NOT NULL,
    "turns" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolInvocation" (
    "id" TEXT NOT NULL,
    "toolUseId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "status" "InvocationStatus" NOT NULL DEFAULT 'pending',
    "input" JSONB NOT NULL,
    "output" JSONB,
    "errorMessage" TEXT,
    "magicaRunId" TEXT,
    "creditUsed" BIGINT NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ToolInvocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunSkill" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "assetPath" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RunSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Waitpoint" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" "WaitpointKind" NOT NULL,
    "status" "WaitpointStatus" NOT NULL DEFAULT 'pending',
    "payload" JSONB NOT NULL,
    "resolution" JSONB,
    "invocationId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Waitpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" "AttachmentSource" NOT NULL DEFAULT 'uploaded',
    "chatId" TEXT,
    "toolInvocationId" TEXT,
    "status" "AttachmentStatus" NOT NULL DEFAULT 'uploading',
    "assemblyId" TEXT,
    "type" TEXT NOT NULL,
    "url" TEXT,
    "name" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "metadata" JSONB,
    "expiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageAttachment" (
    "messageId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MessageAttachment_pkey" PRIMARY KEY ("messageId","attachmentId")
);

-- CreateTable
CREATE TABLE "SendRateLimit" (
    "userId" TEXT NOT NULL,
    "window" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SendRateLimit_pkey" PRIMARY KEY ("userId","window")
);

-- CreateTable
CREATE TABLE "UploadUsage" (
    "userId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "bytesUsed" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "UploadUsage_pkey" PRIMARY KEY ("userId","period")
);

-- CreateTable
CREATE TABLE "LlmStatus" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "lastRoutedModel" TEXT,
    "rateLimitedUntil" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LlmStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "hashedKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedgerEntry_idempotencyKey_key" ON "CreditLedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CreditLedgerEntry_userId_createdAt_idx" ON "CreditLedgerEntry"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Chat_userId_updatedAt_id_idx" ON "Chat"("userId", "updatedAt" DESC, "id");

-- CreateIndex
CREATE INDEX "Chat_userId_isFavorite_idx" ON "Chat"("userId", "isFavorite");

-- CreateIndex
CREATE INDEX "Chat_title_idx" ON "Chat" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Message_chatId_createdAt_id_idx" ON "Message"("chatId", "createdAt" DESC, "id");

-- CreateIndex
CREATE INDEX "Message_content_idx" ON "Message" USING GIN ("content" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_triggerRunId_key" ON "AgentRun"("triggerRunId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_userMessageId_key" ON "AgentRun"("userMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_assistantMessageId_key" ON "AgentRun"("assistantMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_idempotencyKey_key" ON "AgentRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AgentRun_chatId_status_idx" ON "AgentRun"("chatId", "status");

-- CreateIndex
CREATE INDEX "ToolInvocation_runId_idx" ON "ToolInvocation"("runId");

-- CreateIndex
CREATE INDEX "ToolInvocation_magicaRunId_idx" ON "ToolInvocation"("magicaRunId");

-- CreateIndex
CREATE UNIQUE INDEX "ToolInvocation_runId_toolUseId_key" ON "ToolInvocation"("runId", "toolUseId");

-- CreateIndex
CREATE UNIQUE INDEX "RunSkill_runId_skillName_assetPath_key" ON "RunSkill"("runId", "skillName", "assetPath");

-- CreateIndex
CREATE INDEX "Waitpoint_runId_status_idx" ON "Waitpoint"("runId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_assemblyId_key" ON "Attachment"("assemblyId");

-- CreateIndex
CREATE INDEX "Attachment_userId_createdAt_id_idx" ON "Attachment"("userId", "createdAt" DESC, "id");

-- CreateIndex
CREATE INDEX "Attachment_chatId_idx" ON "Attachment"("chatId");

-- CreateIndex
CREATE INDEX "MessageAttachment_attachmentId_idx" ON "MessageAttachment"("attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_hashedKey_key" ON "ApiKey"("hashedKey");

-- CreateIndex
CREATE INDEX "ApiKey_userId_idx" ON "ApiKey"("userId");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_userId_idx" ON "WebhookEndpoint"("userId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_endpointId_createdAt_idx" ON "WebhookDelivery"("endpointId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_userMessageId_fkey" FOREIGN KEY ("userMessageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_assistantMessageId_fkey" FOREIGN KEY ("assistantMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolInvocation" ADD CONSTRAINT "ToolInvocation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunSkill" ADD CONSTRAINT "RunSkill_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Waitpoint" ADD CONSTRAINT "Waitpoint_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_toolInvocationId_fkey" FOREIGN KEY ("toolInvocationId") REFERENCES "ToolInvocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
