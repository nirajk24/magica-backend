import {
  ContentBlock,
  type AssetDTO,
  type AttachmentDTO,
  type Feedback,
  type MessageDTO,
  type ToolInvocationDTO,
} from "@/contracts";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getTool } from "@/tools/registry";

/** Newest-first page size ceiling; the route's Zod schema clamps the request itself. */
const DEFAULT_LIMIT = 20;

const messageSelect = {
  id: true,
  role: true,
  status: true,
  content: true,
  contentBlocks: true,
  attachments: true,
  assets: true,
  aiModel: true,
  tokenUsage: true,
  creditUsed: true,
  feedback: true,
  metadata: true,
  errorMessage: true,
  runId: true,
  createdAt: true,
} as const;

const invocationSelect = {
  id: true,
  toolUseId: true,
  toolName: true,
  subModelId: true,
  status: true,
  input: true,
  output: true,
  errorMessage: true,
  failureCode: true,
  creditUsed: true,
  startedAt: true,
  completedAt: true,
} as const;

type MessageRow = {
  [K in keyof typeof messageSelect]: unknown;
} & { creditUsed: bigint; createdAt: Date; id: string };

type InvocationRow = {
  id: string;
  toolUseId: string;
  toolName: string;
  subModelId: string | null;
  status: ToolInvocationDTO["status"];
  input: unknown;
  output: unknown;
  errorMessage: string | null;
  failureCode: string | null;
  creditUsed: bigint;
  startedAt: Date | null;
  completedAt: Date | null;
};

/**
 * Blocks are written by the turn loop through a typed path, so an invalid array means a bug upstream.
 * Degrading to null keeps one bad row from failing the whole chat, which parsing on the client
 * would not.
 */
function readBlocks(value: unknown, messageId: string): ContentBlock[] | null {
  if (value === null || value === undefined) return null;

  const parsed = ContentBlock.array().safeParse(value);
  if (parsed.success) return parsed.data;

  logger.error({ messageId, issues: parsed.error.issues }, "unreadable content blocks");
  return null;
}

function toInvocationDTO(row: InvocationRow): ToolInvocationDTO {
  return {
    id: row.id,
    toolUseId: row.toolUseId,
    toolName: row.toolName,
    subModelId: row.subModelId,
    display: getTool(row.toolName)?.display ?? { label: row.toolName, icon: "tool" },
    status: row.status,
    input: row.input,
    output: row.output ?? null,
    errorMessage: row.errorMessage,
    failureCode: row.failureCode,
    creditUsed: row.creditUsed.toString(),
    durationMs:
      row.startedAt && row.completedAt
        ? row.completedAt.getTime() - row.startedAt.getTime()
        : null,
  };
}

/**
 * The one place a stored message becomes wire shape.
 *
 * INVARIANT: every credit value leaves here as a string. `JSON.stringify` throws on a BigInt and
 * `Number()` loses precision, so no route may serialise a row itself.
 */
function toMessageDTO(row: MessageRow, invocations: InvocationRow[]): MessageDTO {
  return {
    id: row.id,
    role: row.role as MessageDTO["role"],
    status: row.status as MessageDTO["status"],
    content: row.content as string,
    contentBlocks: readBlocks(row.contentBlocks, row.id),
    attachments: (row.attachments as AttachmentDTO[] | null) ?? null,
    assets: (row.assets as AssetDTO[] | null) ?? null,
    toolInvocations: invocations.map(toInvocationDTO),
    aiModel: (row.aiModel as MessageDTO["aiModel"]) ?? null,
    tokenUsage: (row.tokenUsage as MessageDTO["tokenUsage"]) ?? null,
    creditUsed: row.creditUsed.toString(),
    feedback: (row.feedback as MessageDTO["feedback"]) ?? null,
    errorMessage: (row.errorMessage as string | null) ?? null,
    metadata: (row.metadata as MessageDTO["metadata"]) ?? null,
    runId: (row.runId as string | null) ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Opaque to the client: `(createdAt, id)` is the composite the message index is built on. */
function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!iso || !id) return null;

  const createdAt = new Date(iso);
  return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
}

/**
 * One page of a chat's messages, oldest first, with a cursor pointing at OLDER ones.
 *
 * Read newest-first so the newest page is the cheap one and the index is used, then reversed —
 * the timeline renders chronologically, so returning it that way keeps the client from re-sorting.
 */
export async function listMessages(a: {
  chatId: string;
  cursor?: string;
  limit?: number;
}): Promise<{ messages: MessageDTO[]; nextCursor: string | null }> {
  const limit = a.limit ?? DEFAULT_LIMIT;
  const after = a.cursor ? decodeCursor(a.cursor) : null;

  const rows = await db.message.findMany({
    where: {
      chatId: a.chatId,
      ...(after
        ? {
            OR: [
              { createdAt: { lt: after.createdAt } },
              { createdAt: after.createdAt, id: { lt: after.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: messageSelect,
  });

  const page = rows.slice(0, limit);
  const oldest = page.at(-1);

  const runIds = [...new Set(page.map((row) => row.runId).filter((id): id is string => id !== null))];
  const invocations =
    runIds.length === 0
      ? []
      : await db.toolInvocation.findMany({
          where: { runId: { in: runIds } },
          orderBy: { createdAt: "asc" },
          select: { ...invocationSelect, runId: true },
        });

  return {
    messages: page
      .reverse()
      .map((row) =>
        toMessageDTO(
          row as MessageRow,
          invocations.filter((invocation) => invocation.runId === row.runId),
        ),
      ),
    nextCursor: rows.length > limit && oldest ? encodeCursor(oldest) : null,
  };
}

/**
 * Records or clears a like on an assistant message the caller owns.
 *
 * INVARIANT: ownership travels through the chat in the WHERE clause, and a message that is not the
 * caller's answers NOT_FOUND. Only an assistant message can be rated — there is nothing to tell us
 * about the user's own words.
 */
export async function setMessageFeedback(a: {
  userId: string;
  messageId: string;
  type: Feedback["type"];
}): Promise<void> {
  const { count } = await db.message.updateMany({
    where: {
      id: a.messageId,
      role: "assistant",
      chat: { userId: a.userId, deletedAt: null },
    },
    data: { feedback: a.type },
  });

  if (count === 0) throw new AppError("NOT_FOUND", "That message does not exist.");
}
