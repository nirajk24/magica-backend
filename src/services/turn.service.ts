import { Prisma } from "@/generated/prisma/client";
import { ActivePlan, type AssetDTO, type AttachmentDTO, type ContentBlock } from "@/contracts";
import { refundAdmission } from "@/lib/credits";
import { db } from "@/lib/db";
import { isUniqueViolation, ToolError } from "@/lib/errors";
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
  planMode: boolean;
  activePlan: ActivePlan | null;
  assistantMessageId: string;
  history: HistoryMessage[];
};

/** A row that fails the schema reads as no plan, so a bad write can never wedge a chat. */
function parseActivePlan(raw: unknown): ActivePlan | null {
  const parsed = ActivePlan.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

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
    select: {
      userId: true,
      chatId: true,
      planMode: true,
      chat: { select: { modelId: true, activePlan: true } },
    },
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
    select: { role: true, content: true, attachments: true, assets: true },
  });

  await db.agentRun.updateMany({
    where: { id: runId, status: { in: [...WRITABLE] } },
    data: { status: "running", assistantMessageId, ...(triggerRunId ? { triggerRunId } : {}) },
  });

  return {
    userId: run.userId,
    chatId: run.chatId,
    modelId: run.chat.modelId,
    planMode: run.planMode,
    activePlan: parseActivePlan(run.chat.activePlan),
    assistantMessageId,
    history: recent.reverse().map((m) => ({
      role: m.role as HistoryMessage["role"],
      content: m.content,
      files: historyFiles(m),
    })),
  };
}

/**
 * The files a history message carries, as the model needs to see them: user uploads from the
 * attachments snapshot, generated media from the assets snapshot. This is how a URL from an earlier
 * turn stays referenceable — "edit that image" only works if the image's URL is in the replayed
 * history.
 */
function historyFiles(m: { attachments: unknown; assets: unknown }): HistoryMessage["files"] {
  const attachments = (m.attachments as AttachmentDTO[] | null) ?? [];
  const assets = (m.assets as AssetDTO[] | null) ?? [];

  const files = [
    ...attachments
      .filter((attachment) => attachment.url !== null)
      .map((attachment) => ({
        name: attachment.name,
        type: attachment.type,
        url: attachment.url as string,
      })),
    ...assets.map((asset) => ({ name: nameFromUrl(asset.url), type: asset.type, url: asset.url })),
  ];

  return files.length > 0 ? files : undefined;
}

function nameFromUrl(url: string): string {
  try {
    const base = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    return base || "generated-file";
  } catch {
    return "generated-file";
  }
}

/**
 * Moves a live turn between running and suspended.
 *
 * INVARIANT: conditional on a non-terminal status, so a run cancelled while it was parked is not
 * resurrected by the task waking up afterwards.
 */
async function markTurn(runId: string, status: "waiting" | "running"): Promise<void> {
  await db.agentRun.updateMany({
    where: { id: runId, status: { in: [...WRITABLE] } },
    data: { status },
  });
}

/** The turn is parked on a waitpoint: idle, healthy, and not to be judged stale by its age. */
export const markTurnWaiting = (runId: string) => markTurn(runId, "waiting");

/** The interaction is answered and the turn is working again. */
export const markTurnRunning = (runId: string) => markTurn(runId, "running");

/** How the approved plan runs, from its approval — recorded on the run for diagnosability. */
export async function recordExecutionMode(
  runId: string,
  mode: "auto" | "step_by_step",
): Promise<void> {
  await db.agentRun.updateMany({
    where: { id: runId, status: { in: [...WRITABLE] } },
    data: { executionMode: mode },
  });
}

/**
 * Replaces the chat's active plan, or clears it with `null`.
 *
 * `Prisma.DbNull` on purpose: `undefined` means "leave unchanged" in a Prisma update, and the JSON
 * literal `null` would make every reader special-case a second kind of empty.
 */
export async function writeActivePlan(chatId: string, plan: ActivePlan | null): Promise<void> {
  await db.chat.update({
    where: { id: chatId },
    data: { activePlan: plan === null ? Prisma.DbNull : (plan as Prisma.InputJsonValue) },
  });
}

/**
 * Advances one step of the chat's active plan and returns the plan as it now stands.
 *
 * Throws `ToolError`, not `AppError`: the caller is the model, and both failure modes — no active
 * plan, a key naming no step — are things it can correct or explain.
 */
export async function patchActivePlanStep(a: {
  chatId: string;
  stepKey: string;
  status: "in_progress" | "completed" | "failed";
  note?: string;
}): Promise<ActivePlan> {
  const chat = await db.chat.findUniqueOrThrow({
    where: { id: a.chatId },
    select: { activePlan: true },
  });

  const plan = ActivePlan.safeParse(chat.activePlan);
  if (!plan.success) {
    throw new ToolError("No plan is active. Submit a plan and get it approved first.");
  }

  const step = plan.data.steps.find((candidate) => candidate.key === a.stepKey);
  if (!step) {
    const keys = plan.data.steps.map((candidate) => candidate.key).join(", ");
    throw new ToolError(`No step is named "${a.stepKey}". The plan's steps are: ${keys}.`);
  }

  step.status = a.status;
  if (a.note !== undefined) step.note = a.note;

  await writeActivePlan(a.chatId, plan.data);

  return plan.data;
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
type ProducedAsset = { invocationId: string; asset: AssetDTO };

async function completedWork(runId: string): Promise<{
  creditUsed: bigint;
  assets: AssetDTO[];
  produced: ProducedAsset[];
}> {
  const invocations = await db.toolInvocation.findMany({
    where: { runId, status: "completed" },
    orderBy: { createdAt: "asc" },
    select: { id: true, toolName: true, toolUseId: true, output: true, creditUsed: true },
  });

  const produced = invocations.flatMap((invocation) =>
    assetsFromInvocation(invocation).map((asset) => ({ invocationId: invocation.id, asset })),
  );

  return {
    creditUsed: invocations.reduce((total, invocation) => total + invocation.creditUsed, 0n),
    assets: produced.map((p) => p.asset),
    produced,
  };
}

const EXTENSION_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
};

const generatedContentType = (url: string, type: string): string =>
  EXTENSION_TYPES[nameFromUrl(url).split(".").pop()?.toLowerCase() ?? ""] ?? `${type}/*`;

/**
 * The media library rows for what this run generated, one per produced file.
 *
 * INVARIANT: idempotent by (invocationId, url) — a retried attempt re-reads every completed
 * invocation of the run, including the previous attempt's, and must not list its files twice.
 * The check-then-insert is race-free here because a run finalizes at most once per attempt.
 *
 * `size` is 0: the provider reports no byte size and the file lives on its CDN, not ours.
 */
async function insertGeneratedAttachments(
  tx: Prisma.TransactionClient,
  a: { userId: string; chatId: string; produced: ProducedAsset[] },
): Promise<void> {
  if (a.produced.length === 0) return;

  const existing = await tx.attachment.findMany({
    where: {
      toolInvocationId: { in: [...new Set(a.produced.map((p) => p.invocationId))] },
      source: "generated",
    },
    select: { toolInvocationId: true, url: true },
  });
  const seen = new Set(existing.map((row) => `${row.toolInvocationId}|${row.url ?? ""}`));

  const rows = a.produced
    .filter((p) => !seen.has(`${p.invocationId}|${p.asset.url}`))
    .map((p) => ({
      userId: a.userId,
      source: "generated" as const,
      chatId: a.chatId,
      toolInvocationId: p.invocationId,
      status: "ready" as const,
      type: p.asset.type,
      url: p.asset.url,
      name: nameFromUrl(p.asset.url),
      contentType: generatedContentType(p.asset.url, p.asset.type),
      size: 0,
    }));

  if (rows.length > 0) await tx.attachment.createMany({ data: rows });
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
  const { creditUsed, assets, produced } = await completedWork(a.runId);

  await db.$transaction(async (tx) => {
    const message = await tx.message.update({
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

    await insertGeneratedAttachments(tx, {
      userId: a.userId,
      chatId: message.chatId,
      produced,
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
