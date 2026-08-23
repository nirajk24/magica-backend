import { AttachmentsQuery, type AttachmentsPage } from "@/contracts";
import { definePublicApiRoute, preflight } from "@/lib/api";
import { listAttachments } from "@/services/attachment.service";

/**
 * The media library: everything the caller has uploaded, plus everything the agent and direct tool
 * runs generated for them. Read-only on this surface — uploads are a signed browser flow, so a key
 * holder can list and fetch what exists but cannot create a row here.
 */
export const GET = definePublicApiRoute({
  query: AttachmentsQuery,
  handler: ({ userId, query }): Promise<AttachmentsPage> => listAttachments({ userId, ...query }),
});

export const OPTIONS = preflight;
