import {
  AttachmentsQuery,
  CreateAttachment,
  type AttachmentResponse,
  type AttachmentsPage,
} from "@/contracts";
import { defineRoute, preflight } from "@/lib/api";
import { listAttachments, recordAssemblyResult } from "@/services/attachment.service";

/** Assembly completion (or failure), reported by the uploading client. Upsert on `assemblyId`. */
export const POST = defineRoute({
  body: CreateAttachment,
  handler: async ({ userId, body }): Promise<AttachmentResponse> => ({
    attachment: await recordAssemblyResult({ userId, report: body }),
  }),
});

/** The media library: `?source=` picks a tab, `?chatId=` backs "All files in this task". */
export const GET = defineRoute({
  query: AttachmentsQuery,
  handler: async ({ userId, query }): Promise<AttachmentsPage> =>
    listAttachments({ userId, ...query }),
});

export const OPTIONS = preflight;
