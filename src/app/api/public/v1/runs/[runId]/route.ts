import type { PublicRunStatus, RunToolResult } from "@/contracts";
import { definePublicApiRoute, preflight } from "@/lib/api";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { readDirectToolResult } from "@/services/tool-run.service";

/**
 * Run status, and the result once a direct tool run has finished.
 *
 * INVARIANT: ownership is part of the lookup, so another account's run is indistinguishable from
 * one that does not exist.
 */
export const GET = definePublicApiRoute({
  handler: async ({ userId, params }): Promise<PublicRunStatus & { result?: RunToolResult }> => {
    const runId = params.runId;
    if (!runId) throw new AppError("VALIDATION_ERROR", "A run id is required.");

    const run = await db.agentRun.findFirst({
      where: { id: runId, userId, chat: { deletedAt: null } },
      select: {
        id: true,
        chatId: true,
        status: true,
        assistantMessageId: true,
        failureReason: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!run) throw new AppError("NOT_FOUND", "That run does not exist.");

    const result = await readDirectToolResult({ userId, runId });

    return {
      runId: run.id,
      chatId: run.chatId,
      status: run.status as PublicRunStatus["status"],
      assistantMessageId: run.assistantMessageId,
      failureReason: run.failureReason,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      ...(result ? { result } : {}),
    };
  },
});

export const OPTIONS = preflight;
