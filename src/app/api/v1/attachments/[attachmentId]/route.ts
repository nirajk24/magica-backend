import { UpdateAttachment, type AttachmentResponse, type Ok } from "@/contracts";
import { defineRoute, preflight } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { deleteAttachment, renameAttachment } from "@/services/attachment.service";

const requireAttachmentId = (params: Record<string, string>) => {
  const attachmentId = params.attachmentId;
  if (!attachmentId) throw new AppError("VALIDATION_ERROR", "An attachment id is required.");

  return attachmentId;
};

export const PATCH = defineRoute({
  body: UpdateAttachment,
  handler: async ({ userId, body, params }): Promise<AttachmentResponse> => ({
    attachment: await renameAttachment({
      userId,
      attachmentId: requireAttachmentId(params),
      name: body.name,
    }),
  }),
});

export const DELETE = defineRoute({
  handler: async ({ userId, params }): Promise<Ok> => {
    await deleteAttachment({ userId, attachmentId: requireAttachmentId(params) });

    return { ok: true };
  },
});

export const OPTIONS = preflight;
