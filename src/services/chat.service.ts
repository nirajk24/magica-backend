import { DEFAULT_MODEL_ID, type ChatDTO, type ChatsPage, type ChatsQuery } from "@/contracts";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";

/** The sentinel the composer uses before a chat exists; the send route creates one for it. */
export const NEW_CHAT_ID = "new";

const chatSelect = {
  id: true,
  title: true,
  isFavorite: true,
  modelId: true,
  activePlan: true,
  createdAt: true,
  updatedAt: true,
} as const;

type ChatRow = {
  id: string;
  title: string;
  isFavorite: boolean;
  modelId: string;
  activePlan: unknown;
  createdAt: Date;
  updatedAt: Date;
};

function toChatDTO(row: ChatRow): ChatDTO {
  return {
    id: row.id,
    title: row.title,
    isFavorite: row.isFavorite,
    modelId: row.modelId,
    activePlan: row.activePlan ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * A chat the caller owns.
 *
 * INVARIANT: ownership is part of the WHERE clause, not a check afterwards, and another user's chat
 * answers NOT_FOUND rather than FORBIDDEN — a 403 would confirm the id exists.
 */
export async function getChatForUser(a: { userId: string; chatId: string }): Promise<ChatDTO> {
  const chat = await db.chat.findFirst({
    where: { id: a.chatId, userId: a.userId, deletedAt: null },
    select: chatSelect,
  });

  if (!chat) throw new AppError("NOT_FOUND", "That chat does not exist.");

  return toChatDTO(chat);
}

export async function createChat(a: {
  userId: string;
  modelId?: string;
  title?: string;
}): Promise<ChatDTO> {
  const chat = await db.chat.create({
    data: {
      userId: a.userId,
      modelId: a.modelId ?? DEFAULT_MODEL_ID,
      ...(a.title ? { title: a.title } : {}),
    },
    select: chatSelect,
  });

  return toChatDTO(chat);
}

/** Opaque to the client: `(updatedAt, id)` is the composite the chat list index is built on. */
function encodeCursor(row: { updatedAt: Date; id: string }): string {
  return Buffer.from(`${row.updatedAt.toISOString()}|${row.id}`).toString("base64url");
}

function decodeCursor(cursor: string): { updatedAt: Date; id: string } | null {
  const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!iso || !id) return null;

  const updatedAt = new Date(iso);
  return Number.isNaN(updatedAt.getTime()) ? null : { updatedAt, id };
}

/** Most recently touched first, which is the order the sidebar renders. */
export async function listChats(a: { userId: string } & ChatsQuery): Promise<ChatsPage> {
  const after = a.cursor ? decodeCursor(a.cursor) : null;

  const rows = await db.chat.findMany({
    where: {
      userId: a.userId,
      deletedAt: null,
      ...(a.filter === "pinned" ? { isFavorite: true } : {}),
      ...(a.search ? { title: { contains: a.search, mode: "insensitive" } } : {}),
      ...(after
        ? {
            OR: [
              { updatedAt: { lt: after.updatedAt } },
              { updatedAt: after.updatedAt, id: { lt: after.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: a.limit + 1,
    select: chatSelect,
  });

  const page = rows.slice(0, a.limit);
  const last = page.at(-1);

  return {
    chats: page.map(toChatDTO),
    nextCursor: rows.length > a.limit && last ? encodeCursor(last) : null,
  };
}
