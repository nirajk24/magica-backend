import { z } from "zod";
import type { RunToolResult, ToolsPage } from "@/contracts";
import type { AgentTool } from "@/tools/define";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { uuidv7 } from "@/lib/ids";
import { estimateMicrocredits } from "@/tools/pricing";
import { getTool, registry } from "@/tools/registry";
import { publicToolRun } from "@/trigger/public-tool-run";

/**
 * Tools the public API may execute directly: provider work, not conversational machinery.
 *
 * `media` is the registry's existing partition and holds exactly the three required Magica tools.
 * Partitioning by tag rather than by a list of names means a fourth provider tool is exposed by
 * its own registry entry, with no edit here.
 */
const DIRECT_TAG = "media";

const API_CHAT_TITLE = "API tool runs";

/**
 * The tools a public caller can run, with the JSON Schema the runtime actually parses.
 *
 * Interaction tools and skill loaders are excluded: they only mean something inside a turn, and
 * exposing them would be an endpoint that cannot work.
 */
export function listPublicTools(): ToolsPage {
  return {
    tools: Object.values(registry)
      .filter((tool) => tool.tags?.includes(DIRECT_TAG))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        tags: tool.tags ?? [],
        inputSchema: toJsonSchema(tool as AgentTool),
      })),
  };
}

/**
 * JSON Schema for a tool's input, generated from the Zod schema the runtime parses — so the
 * published contract cannot drift from what is enforced.
 *
 * `io: "input"` because a caller sends the input side: a schema carrying a `.transform()` has a
 * different output type, and publishing that would document what we produce rather than what to
 * send. `unrepresentable: "any"` because a transform has no JSON Schema form and must degrade to
 * an unconstrained field rather than throw — `gpt_image_2` clamps quality that way.
 */
function toJsonSchema(tool: AgentTool): unknown {
  return z.toJSONSchema(tool.input, { io: "input", unrepresentable: "any" });
}

/**
 * The chat a caller's direct tool runs are recorded against, created on first use.
 *
 * A direct run is a real run: it charges credits, produces invocations and assets, and shows up in
 * usage. Giving it a chat means every one of those reads works unchanged, and nothing about the
 * public API is invisible to the person who owns the account.
 */
async function apiChatId(userId: string): Promise<string> {
  const existing = await db.chat.findFirst({
    where: { userId, title: API_CHAT_TITLE, deletedAt: null },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  if (existing) return existing.id;

  const created = await db.chat.create({
    data: { userId, title: API_CHAT_TITLE },
    select: { id: true },
  });

  return created.id;
}

export type DirectToolRun = {
  runId: string;
  /** The tool-call id the execution is keyed on — NOT the invocation row's id, which the runtime
   * creates from it. Two ids named alike is how this codebase last shipped a real bug. */
  toolUseId: string;
  chatId: string;
  toolName: string;
  input: unknown;
};

/**
 * Records a direct tool execution and dispatches it durably.
 *
 * INVARIANT: the only path to `publicToolRun.trigger`, and the dispatch is keyed on the tool-call
 * id, so a repeated request cannot run the provider twice.
 *
 * The provider call happens in the task, not here — a public caller gets the same
 * accepted-then-poll behaviour the Magica API itself has, rather than an HTTP request held open
 * for the length of a generation.
 */
export async function startDirectToolRun(a: {
  userId: string;
  toolName: string;
  input: unknown;
}): Promise<DirectToolRun> {
  const tool = getTool(a.toolName);

  if (!tool || !tool.tags?.includes(DIRECT_TAG)) {
    throw new AppError("NOT_FOUND", `No runnable tool is named "${a.toolName}".`);
  }

  const parsed = tool.input.safeParse(a.input);
  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "The tool input is invalid.", parsed.error.issues);
  }

  // Priced before anything is written, so an unpriceable call never leaves a row behind.
  estimateMicrocredits(a.toolName, parsed.data as Record<string, unknown>);

  const chatId = await apiChatId(a.userId);
  const runId = uuidv7();
  const userMessageId = uuidv7();

  await db.$transaction(async (tx) => {
    await tx.message.create({
      data: {
        id: userMessageId,
        chatId,
        role: "user",
        status: "success",
        content: `Direct API run: ${a.toolName}`,
      },
    });

    await tx.agentRun.create({
      data: {
        id: runId,
        chatId,
        userId: a.userId,
        userMessageId,
        idempotencyKey: `${userMessageId}:1`,
        status: "running",
      },
    });
  });

  const toolUseId = uuidv7();

  await publicToolRun.trigger(
    { userId: a.userId, chatId, runId, toolUseId, toolName: a.toolName, input: parsed.data },
    { idempotencyKey: toolUseId },
  );

  return { runId, toolUseId, chatId, toolName: a.toolName, input: parsed.data };
}

/** Marks a direct run terminal. Conditional, like every other terminal write in the system. */
export async function closeDirectToolRun(a: {
  runId: string;
  status: "completed" | "failed";
  failureReason?: string;
}): Promise<void> {
  await db.agentRun.updateMany({
    where: { id: a.runId, status: { in: ["queued", "running", "waiting"] } },
    data: { status: a.status, failureReason: a.failureReason ?? null },
  });
}

/** What a completed direct run produced, for the caller polling its result. */
export async function readDirectToolResult(a: {
  userId: string;
  runId: string;
}): Promise<RunToolResult | null> {
  const invocation = await db.toolInvocation.findFirst({
    where: { runId: a.runId, run: { userId: a.userId } },
    orderBy: { createdAt: "asc" },
    select: {
      toolName: true,
      subModelId: true,
      output: true,
      creditUsed: true,
      startedAt: true,
      completedAt: true,
      status: true,
    },
  });

  if (!invocation || invocation.status !== "completed") return null;

  return {
    tool: invocation.toolName,
    subModelId: invocation.subModelId,
    output: invocation.output,
    creditUsed: invocation.creditUsed.toString(),
    durationMs:
      invocation.startedAt && invocation.completedAt
        ? invocation.completedAt.getTime() - invocation.startedAt.getTime()
        : 0,
  };
}
