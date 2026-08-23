import {
  DEFAULT_MODEL_ID,
  type ChatDTO,
  type ChatsPage,
  type ChatsQuery,
  type UpdateChat,
} from "@/contracts";
import { decodeCursor, encodeCursor } from "@/lib/cursor";
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

/**
 * Renames a chat or pins it.
 *
 * INVARIANT: ownership is in the WHERE clause, so a chat the caller does not own is indistinguishable
 * from one that does not exist. An empty patch is a no-op that still returns the current row.
 *
 * The rename does not touch `updatedAt`: the sidebar orders by real activity, and retitling a chat
 * is not activity.
 */
export async function updateChat(a: {
  userId: string;
  chatId: string;
  patch: UpdateChat;
}): Promise<ChatDTO> {
  const current = await db.chat.findFirst({
    where: { id: a.chatId, userId: a.userId, deletedAt: null },
    select: chatSelect,
  });

  if (!current) throw new AppError("NOT_FOUND", "That chat does not exist.");

  // Carried forward explicitly. `updatedAt: undefined` reads as "not provided" and Prisma's
  // `@updatedAt` bumps it anyway, which would reorder the sidebar and move a live cursor key.
  const updated = await db.chat.update({
    where: { id: a.chatId },
    data: { ...a.patch, updatedAt: current.updatedAt },
    select: chatSelect,
  });

  return toChatDTO(updated);
}

/**
 * Soft-deletes a chat the caller owns.
 *
 * Soft, not erased: the ledger entries, invocations and assets its turns produced stay explainable,
 * and every read already filters on `deletedAt`. Deleting twice is a no-op.
 *
 * INVARIANT: a run still holding this chat must be cancelled first, by the caller. The work would
 * otherwise keep spending credits for a chat nobody can open.
 */
export async function deleteChat(a: { userId: string; chatId: string }): Promise<void> {
  const { count } = await db.chat.updateMany({
    where: { id: a.chatId, userId: a.userId, deletedAt: null },
    data: { deletedAt: new Date() },
  });

  if (count === 0) {
    const exists = await db.chat.findFirst({
      where: { id: a.chatId, userId: a.userId },
      select: { id: true },
    });

    if (!exists) throw new AppError("NOT_FOUND", "That chat does not exist.");
  }
}

/**
 * Most recently touched first, which is the order the sidebar renders.
 *
 * `search` covers titles **and** message content, as one `EXISTS` against the trigram index rather
 * than a scan. The two conditions are `AND`ed as separate clauses because both need an `OR` of their
 * own, and two `OR` keys in one Prisma filter silently keep the last.
 */
export async function listChats(a: { userId: string } & ChatsQuery): Promise<ChatsPage> {
  const after = a.cursor ? decodeCursor(a.cursor) : null;
  const like = { contains: a.search ?? "", mode: "insensitive" } as const;

  const rows = await db.chat.findMany({
    where: {
      userId: a.userId,
      deletedAt: null,
      ...(a.filter === "pinned" ? { isFavorite: true } : {}),
      AND: [
        ...(a.search
          ? [{ OR: [{ title: like }, { messages: { some: { content: like } } }] }]
          : []),
        ...(after
          ? [
              {
                OR: [
                  { updatedAt: { lt: after.at } },
                  { updatedAt: after.at, id: { lt: after.id } },
                ],
              },
            ]
          : []),
      ],
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: a.limit + 1,
    select: chatSelect,
  });

  const page = rows.slice(0, a.limit);
  const last = page.at(-1);

  return {
    chats: page.map(toChatDTO),
    nextCursor:
      rows.length > a.limit && last ? encodeCursor({ at: last.updatedAt, id: last.id }) : null,
  };
}
