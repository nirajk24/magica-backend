import type {
  AttachmentDTO,
  AttachmentsPage,
  AttachmentsQuery,
  CreateAttachment,
  SignUploadsResult,
  UploadFileSpec,
} from "@/contracts";
import type { Prisma } from "@/generated/prisma/client";
import { encodeCursor, decodeCursor } from "@/lib/cursor";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { AppError, isUniqueViolation } from "@/lib/errors";
import {
  MONTHLY_QUOTA_BYTES,
  PER_FILE_LIMIT_BYTES,
  RESULT_TTL_MS,
  SIGNATURE_TTL_MS,
  signAssembly,
  usagePeriod,
} from "@/lib/transloadit";

const attachmentSelect = {
  id: true,
  type: true,
  source: true,
  url: true,
  name: true,
  contentType: true,
  size: true,
  status: true,
  metadata: true,
  expiresAt: true,
  createdAt: true,
} as const;

type AttachmentRow = {
  id: string;
  type: string;
  source: "uploaded" | "generated";
  url: string | null;
  name: string;
  contentType: string;
  size: number;
  status: "uploading" | "ready" | "failed" | "cancelled";
  metadata: unknown;
  expiresAt: Date | null;
  createdAt: Date;
};

function toAttachmentDTO(row: AttachmentRow): AttachmentDTO {
  return {
    id: row.id,
    type: row.type as AttachmentDTO["type"],
    source: row.source,
    url: row.url,
    name: row.name,
    contentType: row.contentType,
    size: row.size,
    status: row.status,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

const GB = 1_073_741_824;
const asGb = (bytes: number | bigint) => (Number(bytes) / GB).toFixed(2);

/**
 * The one place the Transloadit credentials are read. They are optional in `lib/env.ts` so a
 * missing pair cannot crash every Trigger.dev task at boot; this is the named failure instead.
 */
function transloaditCredentials(): { key: string; secret: string } {
  if (!env.TRANSLOADIT_KEY || !env.TRANSLOADIT_SECRET) {
    throw new AppError(
      "INTERNAL",
      "Uploads are not configured: TRANSLOADIT_KEY and TRANSLOADIT_SECRET are missing.",
    );
  }

  return { key: env.TRANSLOADIT_KEY, secret: env.TRANSLOADIT_SECRET };
}

/**
 * Enforces the Community-plan limits BEFORE any signature exists: 0.5 GB per file, 5 GB per user
 * per UTC calendar month. Field-specific `QUOTA_EXCEEDED` (413) — a signature for a file that can
 * never land is a promise the plan cannot keep.
 */
async function assertUploadQuota(a: { userId: string; files: UploadFileSpec[]; now: Date }): Promise<void> {
  for (const [index, file] of a.files.entries()) {
    if (file.size > PER_FILE_LIMIT_BYTES) {
      throw new AppError(
        "QUOTA_EXCEEDED",
        `"${file.name}" is ${asGb(file.size)} GB; the per-file limit is 0.5 GB.`,
        { field: `files.${index}.size` },
      );
    }
  }

  const requested = a.files.reduce((sum, f) => sum + BigInt(f.size), 0n);
  const usage = await db.uploadUsage.findUnique({
    where: { userId_period: { userId: a.userId, period: usagePeriod(a.now) } },
    select: { bytesUsed: true },
  });
  const used = usage?.bytesUsed ?? 0n;

  if (used + requested > MONTHLY_QUOTA_BYTES) {
    throw new AppError(
      "QUOTA_EXCEEDED",
      `This upload needs ${asGb(requested)} GB but only ${asGb(MONTHLY_QUOTA_BYTES - used)} GB ` +
        `of this month's 5 GB allowance is left.`,
      { field: "files" },
    );
  }
}

/**
 * Signed Transloadit params for direct browser upload — one single-file assembly per requested
 * file, in request order. Quota is checked before anything is signed.
 */
export async function signUploadAssemblies(a: {
  userId: string;
  files: UploadFileSpec[];
  now?: Date;
}): Promise<SignUploadsResult> {
  const { key, secret } = transloaditCredentials();
  const now = a.now ?? new Date();

  await assertUploadQuota({ userId: a.userId, files: a.files, now });

  const expiresAt = new Date(now.getTime() + SIGNATURE_TTL_MS);

  return {
    assemblies: a.files.map(() => signAssembly({ key, secret, expiresAt })),
    expiresAt: expiresAt.toISOString(),
  };
}

const mediaTypeOf = (contentType: string) => contentType.split("/")[0] as AttachmentDTO["type"];

type UpsertArgs = { userId: string; report: CreateAttachment; now?: Date };

/**
 * Records what an assembly did, upserted on the unique `assemblyId` so duplicate completion
 * reports (client retry, reconnect, repost) land on the same row.
 *
 * INVARIANT: `ready` is sticky — a late or replayed non-ready report never downgrades a row that
 * already carries its result. Monthly usage is incremented exactly once, on the transition INTO
 * `ready`, inside the same transaction as the row write.
 * INVARIANT: another user's assemblyId answers NOT_FOUND; an upsert without the ownership check
 * would let a guessed id overwrite someone else's row.
 */
export async function recordAssemblyResult(a: UpsertArgs): Promise<AttachmentDTO> {
  try {
    return await upsertAssemblyRow(a);
  } catch (error) {
    // Two first reports racing: the loser's create hits the unique index; on retry the row exists.
    if (isUniqueViolation(error)) return upsertAssemblyRow(a);
    throw error;
  }
}

async function upsertAssemblyRow(a: UpsertArgs): Promise<AttachmentDTO> {
  const { report } = a;
  const now = a.now ?? new Date();

  if (report.file.size > PER_FILE_LIMIT_BYTES) {
    throw new AppError(
      "QUOTA_EXCEEDED",
      `"${report.file.name}" is ${asGb(report.file.size)} GB; the per-file limit is 0.5 GB.`,
      { field: "file.size" },
    );
  }

  const row = await db.$transaction(async (tx) => {
    const existing = await tx.attachment.findUnique({
      where: { assemblyId: report.assemblyId },
      select: { ...attachmentSelect, userId: true },
    });

    if (existing && existing.userId !== a.userId) {
      throw new AppError("NOT_FOUND", "That upload does not exist.");
    }
    if (existing && existing.status === "ready" && report.status !== "ready") {
      return existing;
    }

    const data = {
      source: "uploaded" as const,
      status: report.status,
      type: mediaTypeOf(report.file.contentType),
      url: report.file.url ?? null,
      name: report.file.name,
      contentType: report.file.contentType,
      size: report.file.size,
      metadata: (report.file.metadata ?? undefined) as never,
      expiresAt: report.status === "ready" ? new Date(now.getTime() + RESULT_TTL_MS) : null,
    };

    const written = existing
      ? await tx.attachment.update({
          where: { id: existing.id },
          data,
          select: attachmentSelect,
        })
      : await tx.attachment.create({
          data: { ...data, userId: a.userId, assemblyId: report.assemblyId },
          select: attachmentSelect,
        });

    if (report.status === "ready" && existing?.status !== "ready") {
      await tx.uploadUsage.upsert({
        where: { userId_period: { userId: a.userId, period: usagePeriod(now) } },
        create: { userId: a.userId, period: usagePeriod(now), bytesUsed: BigInt(report.file.size) },
        update: { bytesUsed: { increment: BigInt(report.file.size) } },
      });
    }

    return written;
  });

  return toAttachmentDTO(row as AttachmentRow);
}

/**
 * Binds ready attachments to a user message inside the send transaction: join rows in request
 * order (the PDF's "preserve attachment order" is the `position` column), the sanitized snapshot
 * frozen onto `Message.attachments`, and `Attachment.chatId` claimed on first use.
 *
 * INVARIANT: every id must exist, belong to the caller and be `ready` — anything else answers
 * NOT_FOUND without saying which of those it was, so a stranger's id is indistinguishable from a
 * missing one.
 */
export async function claimMessageAttachments(
  tx: Prisma.TransactionClient,
  a: { userId: string; chatId: string; messageId: string; attachmentIds: string[] },
): Promise<void> {
  if (a.attachmentIds.length === 0) return;

  const rows = await tx.attachment.findMany({
    where: { id: { in: a.attachmentIds }, userId: a.userId, status: "ready" },
    select: { ...attachmentSelect, chatId: true },
  });

  if (rows.length !== a.attachmentIds.length) {
    throw new AppError("NOT_FOUND", "One or more attachments do not exist or are not ready.");
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = a.attachmentIds.map((id) => byId.get(id)!);

  await tx.messageAttachment.createMany({
    data: a.attachmentIds.map((attachmentId, position) => ({
      messageId: a.messageId,
      attachmentId,
      position,
    })),
  });

  await tx.attachment.updateMany({
    where: { id: { in: a.attachmentIds }, chatId: null },
    data: { chatId: a.chatId },
  });

  await tx.message.update({
    where: { id: a.messageId },
    data: {
      attachments: ordered.map((row) => toAttachmentDTO(row as AttachmentRow)) as never,
    },
  });
}

/** The media library page: newest first over `(userId, createdAt DESC, id)`. */
export async function listAttachments(a: { userId: string } & AttachmentsQuery): Promise<AttachmentsPage> {
  const after = a.cursor ? decodeCursor(a.cursor) : null;

  const rows = await db.attachment.findMany({
    where: {
      userId: a.userId,
      ...(a.source ? { source: a.source } : {}),
      ...(a.chatId ? { chatId: a.chatId } : {}),
      ...(after
        ? {
            OR: [
              { createdAt: { lt: after.at } },
              { createdAt: after.at, id: { lt: after.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: a.limit + 1,
    select: attachmentSelect,
  });

  const page = rows.slice(0, a.limit);
  const last = page.at(-1);

  return {
    attachments: page.map((row) => toAttachmentDTO(row as AttachmentRow)),
    nextCursor:
      rows.length > a.limit && last ? encodeCursor({ at: last.createdAt, id: last.id }) : null,
  };
}

/**
 * Renames one attachment the caller owns.
 *
 * INVARIANT: ownership is in the WHERE clause; another user's id answers NOT_FOUND. The frozen
 * `Message.attachments` snapshot deliberately keeps the name the message was sent with.
 */
export async function renameAttachment(a: {
  userId: string;
  attachmentId: string;
  name: string;
}): Promise<AttachmentDTO> {
  const { count } = await db.attachment.updateMany({
    where: { id: a.attachmentId, userId: a.userId },
    data: { name: a.name },
  });

  if (count === 0) throw new AppError("NOT_FOUND", "That file does not exist.");

  const row = await db.attachment.findUniqueOrThrow({
    where: { id: a.attachmentId },
    select: attachmentSelect,
  });

  return toAttachmentDTO(row as AttachmentRow);
}

/**
 * Removes one attachment the caller owns. Hard delete: the row is gone from the library, message
 * joins cascade, and the frozen `Message.attachments` snapshot keeps rendering what was sent.
 * Deleting twice answers NOT_FOUND, like any other missing id.
 */
export async function deleteAttachment(a: { userId: string; attachmentId: string }): Promise<void> {
  const { count } = await db.attachment.deleteMany({
    where: { id: a.attachmentId, userId: a.userId },
  });

  if (count === 0) throw new AppError("NOT_FOUND", "That file does not exist.");
}
