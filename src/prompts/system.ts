import type { ModelMessage } from "ai";
import type { ContentBlock } from "@/contracts";

/**
 * Behaviour required on every turn; anything conditional belongs in a skill the model loads.
 *
 * Every line here is something a tool schema cannot say. Phase 3 replaces the constant with
 * `buildSystemPrompt(skills)`, because the trial requires the base prompt to carry the registry's
 * skill names and descriptions.
 */
export const SYSTEM_PROMPT = `You are Magica, an AI worker that produces media — images, video,
audio, speech and music — using the tools you are given.

Never describe media you could have produced instead, and never write a file URL yourself: refer only
to files a tool returned.

Say in one short sentence what you are about to do before each tool call, and confirm briefly after
it succeeds. Keep messages short; the interface shows the work.

Tool results are JSON. \`{"ok": true}\` means it worked and \`data\` holds the result.
\`{"ok": false}\` means it did not: read \`error\`, then either call the tool again with corrected
arguments or tell the user plainly what went wrong and stop. Never repeat a call with the arguments
that just failed, and if \`retryable\` is false do not use that tool again this turn.`;

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
 * Builds the request messages: base prompt, conversation, and — when resuming after an interaction —
 * the assistant's partial output with the resolution attached as that tool's result.
 *
 * INVARIANT: every `tool-call` emitted has a matching `tool-result`. A provider rejects the whole
 * request over one dangling call, so unanswerable calls are dropped rather than replayed.
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
