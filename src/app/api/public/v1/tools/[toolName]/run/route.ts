import { RunTool } from "@/contracts";
import { definePublicApiRoute, preflight } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { startDirectToolRun } from "@/services/tool-run.service";

/**
 * Executes one Magica tool directly, outside a conversation.
 *
 * Accepted-then-poll, like the Magica API it calls: the rows are written and the work dispatched
 * durably, so the caller polls `GET /runs/:runId` instead of holding an HTTP request open for the
 * length of a generation.
 */
export const POST = definePublicApiRoute({
  body: RunTool,
  handler: async ({ userId, body, params }) => {
    const toolName = params.toolName;
    if (!toolName) throw new AppError("VALIDATION_ERROR", "A tool name is required.");

    const run = await startDirectToolRun({ userId, toolName, input: body.input });

    return { runId: run.runId, chatId: run.chatId, status: "running" as const };
  },
});

export const OPTIONS = preflight;
