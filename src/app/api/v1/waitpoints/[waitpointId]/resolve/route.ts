import type { z } from "zod";
import { ResolveWaitpoint, type Ok } from "@/contracts";
import { defineRoute, preflight } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { resolveWaitpoint } from "@/services/waitpoint.service";

/**
 * Answers whatever a turn is waiting for and lets it continue.
 *
 * One route for every waitpoint kind: the resolution passes through verbatim to the parked task, so
 * a new kind is a contract variant and nothing here changes. Resolving twice answers `{ ok: true }`
 * without resuming the run a second time.
 */
export const POST = defineRoute({
  body: ResolveWaitpoint,
  handler: async ({ userId, body, params, log }): Promise<z.infer<typeof Ok>> => {
    const waitpointId = params.waitpointId;
    if (!waitpointId) throw new AppError("VALIDATION_ERROR", "A waitpoint id is required.");

    await resolveWaitpoint({ userId, waitpointId, resolution: body, log });

    return { ok: true };
  },
});

export const OPTIONS = preflight;
