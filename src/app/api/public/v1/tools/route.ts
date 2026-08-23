import type { ToolsPage } from "@/contracts";
import { definePublicApiRoute, preflight } from "@/lib/api";
import { listPublicTools } from "@/services/tool-run.service";

/**
 * The runnable tools and their input schemas.
 *
 * Generated from the same Zod schemas the runtime parses, so a published field list cannot drift
 * from what is enforced — the documentation is derived, not maintained.
 */
export const GET = definePublicApiRoute({
  handler: async (): Promise<ToolsPage> => listPublicTools(),
});

export const OPTIONS = preflight;
