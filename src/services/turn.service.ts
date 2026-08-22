import type { Prisma } from "@/generated/prisma/client";
import type { AssetDTO, ContentBlock } from "@/contracts";
import { refundAdmission } from "@/lib/credits";
import { db } from "@/lib/db";
import { isUniqueViolation } from "@/lib/errors";
import { describeModel } from "@/lib/models";
import type { HistoryMessage } from "@/prompts/system";
import { assetsFromInvocation } from "@/tools/assets";

/** Messages sent to the model. Bounded so prompt size cannot grow with the length of a chat. */
const HISTORY_LIMIT = 20;

/** Statuses a run may still be written from. Anything else has reached a terminal state. */
const WRITABLE = ["queued", "running", "waiting"] as const;

export type LoadedTurn = {
  userId: string;
  chatId: string;
  modelId: string;
  assistantMessageId: string;
  history: HistoryMessage[];
};

/** Prisma's JSON input type cannot express a union carrying `unknown`; the blocks are validated. */
const asJson = (blocks: ContentBlock[]) => blocks as unknown as Prisma.InputJsonValue;

const textOf = (blocks: ContentBlock[]) =>
  blocks
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");

/**
 * The assistant row this run writes into, creating it or finding a previous attempt's.
 *
 * INVARIANT: insert-and-absorb, not upsert — `one_assistant_message_per_run` is a partial index
 * Prisma cannot target, and this is what makes the bootstrap idempotent with no lock.
 *
 * The serving model is recorded here rather than at finalize, so a turn that crashes before it
 * finishes still says which model was working on it.
 */
async function bootstrapAssistantMessage(a: {
  runId: string;
  chatId: string;
  modelId: string;
}): Promise<string> {
  const aiModel = describeModel(a.modelId) as unknown as Prisma.InputJsonValue;

  try {
    const created = await db.message.create({
      data: {
        chatId: a.chatId,
        runId: a.runId,
        role: "assistant",
        status: "streaming",
        aiModel,
      },
      select: { id: true },
    });

    return created.id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    // A resumed or retried attempt already carries the model from its first bootstrap, and a chat's
    // model cannot change under it, so there is nothing to refresh.
    const existing = await db.message.findFirstOrThrow({
      where: { runId: a.runId, role: "assistant" },
      select: { id: true },
    });

    return existing.id;
  }
}

/**
 * Everything the turn needs to start. Marks the run `running` on the way through, and records
 * `triggerRunId` in case the send route died between dispatching and writing it.
 */
export async function loadTurn(runId: string, triggerRunId?: string): Promise<LoadedTurn> {
  const run = await db.agentRun.findUniqueOrThrow({
    where: { id: runId },
    select: { userId: true, chatId: true, chat: { select: { modelId: true } } },
  });

  const assistantMessageId = await bootstrapAssistantMessage({
    runId,
    chatId: run.chatId,
    modelId: run.chat.modelId,
  });

  const recent = await db.message.findMany({
    where: {
      chatId: run.chatId,
      id: { not: assistantMessageId },
      role: { in: ["user", "assistant"] },
      content: { not: "" },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: HISTORY_LIMIT,
    select: { role: true, content: true },
  });

  await db.agentRun.updateMany({
    where: { id: runId, status: { in: [...WRITABLE] } },
    data: { status: "running", assistantMessageId, ...(triggerRunId ? { triggerRunId } : {}) },
  });

  return {
    userId: run.userId,
    chatId: run.chatId,
    modelId: run.chat.modelId,
    assistantMessageId,
    history: recent
      .reverse()
      .map((m) => ({ role: m.role as HistoryMessage["role"], content: m.content })),
  };
}

/** Writes the blocks closed so far, so a crash loses only the text still streaming. */
export async function persistTurnBlocks(a: {
  messageId: string;
  blocks: ContentBlock[];
}): Promise<void> {
  await db.message.update({
    where: { id: a.messageId },
    data: { contentBlocks: asJson(a.blocks), content: textOf(a.blocks) },
  });
}

/**
 * What the run produced and what it cost, from its completed invocations.
 *
 * Assets are read back rather than accumulated in memory so a resumed attempt persists the same set
 * a fresh one would, and each tool's own registry entry decides what counts as a file.
 */
async function completedWork(runId: string): Promise<{ creditUsed: bigint; assets: AssetDTO[] }> {
  const invocations = await db.toolInvocation.findMany({
    where: { runId, status: "completed" },
    orderBy: { createdAt: "asc" },
    select: { toolName: true, toolUseId: true, output: true, creditUsed: true },
  });

  return {
    creditUsed: invocations.reduce((total, invocation) => total + invocation.creditUsed, 0n),
    assets: invocations.flatMap(assetsFromInvocation),
  };
}

/**
 * The terminal write in one transaction: the message, the run, and the admission refund.
 *
 * INVARIANT: the run update is conditional on a non-terminal status, or a cancel loses to a turn
 * that was already mid-flight.
 * INVARIANT: the hold is refunded on every terminal path, so a turn costs its tool charges alone.
 */
async function finalizeTurn(a: {
  runId: string;
  userId: string;
  messageId: string;
  blocks: ContentBlock[];
  status: "completed" | "failed";
  tokenUsage: { inputTokens: number; outputTokens: number } | null;
  servedModel?: string | null;
  failureReason?: string;
}): Promise<void> {
  const { creditUsed, assets } = await completedWork(a.runId);

  await db.$transaction(async (tx) => {
    await tx.message.update({
      where: { id: a.messageId },
      data: {
        status: a.status === "completed" ? "success" : "failed",
        contentBlocks: asJson(a.blocks),
        content: textOf(a.blocks),
        creditUsed,
        assets: assets.length > 0 ? (assets as unknown as Prisma.InputJsonValue) : undefined,
        tokenUsage: a.tokenUsage ?? undefined,
        // The bootstrap recorded what was requested; this is what answered. Under the default
        // router those differ, and only the second is worth showing anyone.
        aiModel: a.servedModel
          ? (describeModel(a.servedModel) as unknown as Prisma.InputJsonValue)
          : undefined,
        errorMessage: a.failureReason ?? null,
      },
    });

    await tx.agentRun.updateMany({
      where: { id: a.runId, status: { in: [...WRITABLE] } },
      data: { status: a.status, failureReason: a.failureReason ?? null },
    });

    await refundAdmission(tx, { userId: a.userId, runId: a.runId });
  });
}

export function completeTurn(a: {
  runId: string;
  userId: string;
  messageId: string;
  blocks: ContentBlock[];
  tokenUsage: { inputTokens: number; outputTokens: number } | null;
  servedModel?: string | null;
}): Promise<void> {
  return finalizeTurn({ ...a, status: "completed" });
}

export function failTurn(a: {
  runId: string;
  userId: string;
  messageId: string;
  blocks: ContentBlock[];
  reason: string;
}): Promise<void> {
  return finalizeTurn({
    runId: a.runId,
    userId: a.userId,
    messageId: a.messageId,
    blocks: a.blocks,
    status: "failed",
    tokenUsage: null,
    failureReason: a.reason,
  });
}
