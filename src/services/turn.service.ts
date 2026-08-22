import type { Prisma } from "@/generated/prisma/client";
import type { ContentBlock } from "@/contracts";
import { refundAdmission } from "@/lib/credits";
import { db } from "@/lib/db";
import { isUniqueViolation } from "@/lib/errors";
import type { HistoryMessage } from "@/prompts/system";

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

/**
 * Prisma's JSON input type cannot express a discriminated union whose `tool_use.input` is `unknown`.
 * The blocks are already Zod-validated when they are built, so this is the narrowing Prisma's types
 * cannot do rather than an escape from validation.
 */
const asJson = (blocks: ContentBlock[]) => blocks as unknown as Prisma.InputJsonValue;

const textOf = (blocks: ContentBlock[]) =>
  blocks
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");

/**
 * Creates the assistant row this run will write into, or finds the one a previous attempt already
 * created.
 *
 * INVARIANT: relies on the `one_assistant_message_per_run` partial unique index. Prisma cannot
 * express a `WHERE` clause on an index, so it cannot `upsert` against it — insert and absorb the
 * conflict instead. That is what makes the bootstrap idempotent with no lock and no read-then-write
 * race between two attempts of the same run.
 */
async function bootstrapAssistantMessage(a: { runId: string; chatId: string }): Promise<string> {
  try {
    const created = await db.message.create({
      data: { chatId: a.chatId, runId: a.runId, role: "assistant", status: "streaming" },
      select: { id: true },
    });

    return created.id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    const existing = await db.message.findFirstOrThrow({
      where: { runId: a.runId, role: "assistant" },
      select: { id: true },
    });

    return existing.id;
  }
}

/**
 * Everything the turn needs to start: the run, its chat's model, the bounded history, and the
 * assistant row to write into. Marks the run `running` on the way through.
 */
export async function loadTurn(runId: string): Promise<LoadedTurn> {
  const run = await db.agentRun.findUniqueOrThrow({
    where: { id: runId },
    select: { userId: true, chatId: true, chat: { select: { modelId: true } } },
  });

  const assistantMessageId = await bootstrapAssistantMessage({ runId, chatId: run.chatId });

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
    data: { status: "running", assistantMessageId },
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

/**
 * Writes the blocks closed so far, so a crash mid-turn loses only the text still streaming. Called
 * at block boundaries rather than per delta.
 */
export async function persistTurnBlocks(a: {
  messageId: string;
  blocks: ContentBlock[];
}): Promise<void> {
  await db.message.update({
    where: { id: a.messageId },
    data: { contentBlocks: asJson(a.blocks), content: textOf(a.blocks) },
  });
}

async function creditsSpent(runId: string): Promise<bigint> {
  const { _sum } = await db.toolInvocation.aggregate({
    where: { runId, status: "completed" },
    _sum: { creditUsed: true },
  });

  return _sum.creditUsed ?? 0n;
}

/**
 * The terminal write, in one transaction: the message, the run, and the admission refund.
 *
 * INVARIANT: the run update is conditional on a non-terminal status. A cancelled run must not be
 * resurrected as `completed` by a turn that was already mid-flight — without the condition, cancel
 * would silently lose to whichever write landed last.
 *
 * INVARIANT: the admission hold is refunded on EVERY terminal path, so the net cost of a turn is the
 * sum of its tool charges. `refundAdmission` is keyed, so a replayed finalize pays out once.
 */
async function finalizeTurn(a: {
  runId: string;
  userId: string;
  messageId: string;
  blocks: ContentBlock[];
  status: "completed" | "failed";
  tokenUsage: { inputTokens: number; outputTokens: number } | null;
  failureReason?: string;
}): Promise<void> {
  const creditUsed = await creditsSpent(a.runId);

  await db.$transaction(async (tx) => {
    await tx.message.update({
      where: { id: a.messageId },
      data: {
        status: a.status === "completed" ? "success" : "failed",
        contentBlocks: asJson(a.blocks),
        content: textOf(a.blocks),
        creditUsed,
        tokenUsage: a.tokenUsage ?? undefined,
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
