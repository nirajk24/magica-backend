import type { ModelMessage } from "ai";
import type { ContentBlock } from "@/contracts";

/**
 * Behaviour required on every turn. Anything conditional belongs in a skill the model loads, not
 * here — this text is paid for on every request.
 *
 * The tool-failure paragraph is not advice: `toAiSdkTools` returns
 * `{ ok: false, error, retryable }` rather than throwing, so the model is the thing that has to
 * read it and decide. Without this the model treats a blocked prompt as a dead end.
 */
export const SYSTEM_PROMPT = `You are Magica, an AI worker that produces media for people.

Use your tools to make what the user asks for. Never describe an image you could have generated, and
never write a URL yourself — only refer to files a tool actually returned.

Before each tool call, say in one short sentence what you are about to do. After it succeeds, confirm
briefly what you produced. Keep every message short; the interface shows the work, so you do not need
to narrate it.

Tool results come back as JSON. \`{"ok": true}\` means it worked and \`data\` holds the result.
\`{"ok": false}\` means it did not: read \`error\`, and then either call the tool again with corrected
arguments, or tell the user plainly what went wrong and stop. Never repeat a call with the same
arguments that just failed. If \`retryable\` is false, do not try that tool again this turn.

If a request needs no tool, just answer it.`;

/** One prior message, projected out of a `Message` row so this stays a pure function. */
export type HistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

/** A resolved interaction: the answer that has to go back as the tool's result. */
export type TurnResolution = {
  toolUseId: string;
  toolName: string;
  output: unknown;
};

function assistantParts(blocks: ContentBlock[], answered: Set<string>) {
  const parts: ({ type: "text"; text: string } | {
    type: "tool-call";
    toolCallId: string;
    toolName: string;
    input: unknown;
  })[] = [];

  for (const block of blocks) {
    if (block.type === "text" && block.text !== "") {
      parts.push({ type: "text", text: block.text });
      continue;
    }

    // A tool call with no result would be an unanswered call, which providers reject. The
    // assistant's own text around it already carries what happened, so the call is dropped.
    if (block.type === "tool_use" && answered.has(block.id)) {
      parts.push({
        type: "tool-call",
        toolCallId: block.id,
        toolName: block.name,
        input: block.input,
      });
    }
  }

  return parts;
}

/**
 * Builds the request messages: the base prompt, the conversation so far, and — when this turn is
 * resuming after an interaction — the assistant's own partial output with the resolution attached as
 * that tool's result.
 *
 * INVARIANT: every `tool-call` part emitted has a matching `tool-result`. A resumed turn replays
 * only the calls it can answer; the rest are dropped rather than sent unanswered, because a provider
 * rejects the whole request over one dangling call.
 *
 * `thinking` blocks are never replayed — reasoning is ours to display, not part of the conversation.
 */
export function toModelMessages(a: {
  history: HistoryMessage[];
  blocks: ContentBlock[];
  resolutions: TurnResolution[];
}): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];

  for (const message of a.history) {
    if (message.content !== "") messages.push({ role: message.role, content: message.content });
  }

  const answered = new Set(a.resolutions.map((r) => r.toolUseId));
  const parts = assistantParts(a.blocks, answered);

  if (parts.length > 0) messages.push({ role: "assistant", content: parts });

  if (a.resolutions.length > 0) {
    messages.push({
      role: "tool",
      content: a.resolutions.map((resolution) => ({
        type: "tool-result" as const,
        toolCallId: resolution.toolUseId,
        toolName: resolution.toolName,
        output: { type: "json" as const, value: resolution.output as never },
      })),
    });
  }

  return messages;
}
