import { RunTool } from "@/contracts";
import { definePublicApiRoute, preflight } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { openDirectToolRun } from "@/services/tool-run.service";

/**
 * Executes one Magica tool directly, outside a conversation.
 *
 * Accepted-then-poll, like the Magica API it calls: the rows are written here and the provider
 * work happens in a durable task, so the caller polls `GET /runs/:runId` instead of holding an
 * HTTP request open for the length of a generation.
 */
export const POST = definePublicApiRoute({
  body: RunTool,
  handler: async ({ userId, body, params }) => {
    const toolName = params.toolName;
    if (!toolName) throw new AppError("VALIDATION_ERROR", "A tool name is required.");

    const run = await openDirectToolRun({ userId, toolName, input: body.input });

    const { publicToolRun } = await import("@/trigger/public-tool-run");
    await publicToolRun.trigger(
      {
        userId,
        chatId: run.chatId,
        runId: run.runId,
        toolUseId: run.toolUseId,
        toolName: run.toolName,
        input: run.input,
      },
      { idempotencyKey: run.toolUseId },
    );

    return { runId: run.runId, chatId: run.chatId, status: "running" as const };
  },
});

export const OPTIONS = preflight;
