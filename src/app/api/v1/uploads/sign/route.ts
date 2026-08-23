import { SignUploads, type SignUploadsResult } from "@/contracts";
import { defineRoute, preflight } from "@/lib/api";
import { signUploadAssemblies } from "@/services/attachment.service";

/**
 * Signed Transloadit assembly params for direct browser upload. MIME, count, per-file and
 * monthly quota are all enforced here, before any signature exists — limits are not client-only.
 */
export const POST = defineRoute({
  body: SignUploads,
  handler: async ({ userId, body }): Promise<SignUploadsResult> =>
    signUploadAssemblies({ userId, files: body.files }),
});

export const OPTIONS = preflight;
