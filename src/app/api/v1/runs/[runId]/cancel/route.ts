import type { z } from "zod";
import type { Ok } from "@/contracts";
import { defineRoute, preflight } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { bindContext } from "@/lib/logger";
import { cancelRun } from "@/services/run.service";

/**
 * Stops a run in flight, keeping whatever it has already produced.
 *
 * Answers `{ ok: true }` for a run that had already finished — the user pressing stop as a turn
 * completes is a race, and reporting it as an error would put a failure on screen for a turn that
 * actually succeeded.
 */
export const POST = defineRoute({
  handler: async ({ userId, params, log }): Promise<z.infer<typeof Ok>> => {
    const runId = params.runId;
    if (!runId) throw new AppError("VALIDATION_ERROR", "A run id is required.");

    await cancelRun({ userId, runId, log: bindContext(log, { runId }) });

    return { ok: true };
  },
});

export const OPTIONS = preflight;
