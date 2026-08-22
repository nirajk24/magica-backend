import { auth } from "@trigger.dev/sdk";
import type { ActiveRun } from "@/contracts";
import { defineRoute, preflight } from "@/lib/api";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { getChatForUser } from "@/services/chat.service";

const TOKEN_LIFETIME = "15m";

type WaitpointPayload = NonNullable<ActiveRun["pendingWaitpoint"]>["payload"];

/**
 * The run a reloading client should resubscribe to, or null when nothing is in flight.
 *
 * A fresh token is minted per call, which is why the client must not put a finite stale time on this
 * query: a changing token rebuilds the subscription against a 10-connection cap.
 */
export const GET = defineRoute({
  handler: async ({ userId, params }): Promise<ActiveRun | null> => {
    const chatId = params.chatId;
    if (!chatId) throw new AppError("VALIDATION_ERROR", "A chat id is required.");

    await getChatForUser({ userId, chatId });

    const run = await db.agentRun.findFirst({
      where: { chatId, status: { in: ["queued", "running", "waiting"] } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        triggerRunId: true,
        status: true,
        assistantMessageId: true,
        waitpoints: {
          where: { status: "pending" },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, kind: true, payload: true },
        },
      },
    });

    if (!run) return null;

    const waitpoint = run.waitpoints[0];

    return {
      runId: run.id,
      triggerRunId: run.triggerRunId,
      status: run.status as ActiveRun["status"],
      assistantMessageId: run.assistantMessageId,
      // Scoped to nothing until dispatch lands, so the token is always safe to hand out.
      publicAccessToken: await auth.createPublicToken({
        scopes: { read: { runs: run.triggerRunId ? [run.triggerRunId] : [] } },
        expirationTime: TOKEN_LIFETIME,
      }),
      pendingWaitpoint: waitpoint
        ? {
            id: waitpoint.id,
            kind: waitpoint.kind,
            // Prisma's JsonValue is wider than the contract's json type; we wrote this payload.
            payload: waitpoint.payload as WaitpointPayload,
          }
        : null,
    };
  },
});

export const OPTIONS = preflight;
