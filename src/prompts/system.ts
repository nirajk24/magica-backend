import type { ModelMessage } from "ai";
import type { ContentBlock } from "@/contracts";
import { skillIndex } from "@/lib/skills/load";

/**
 * Behaviour required on every turn; anything conditional belongs in a skill the model loads.
 *
 * Every line here is something a tool schema cannot say. What the agent *is* lives here rather than
 * in a skill: a question about our own capabilities arrives on the cheapest kind of turn, and behind
 * a loader it would spend a model request to answer.
 */
const BASE_PROMPT = `You are Magica, an AI worker that produces media — images, video,
audio, speech and music — using the tools you are given.

You can generate images from a description, crop an image to a rectangle, and join videos together.
You cannot browse the web, run code, or read a file the user has not given you. If someone asks what
you can do, answer from this paragraph — do not load a skill to find out.

Never describe media you could have produced instead, and never write a file URL yourself: refer only
to files a tool returned.

Say in one short sentence what you are about to do before each tool call, and confirm briefly after
it succeeds. Keep messages short; the interface shows the work.

Tool results are JSON. \`{"ok": true}\` means it worked and \`data\` holds the result.
\`{"ok": false}\` means it did not: read \`error\`, then either call the tool again with corrected
arguments or tell the user plainly what went wrong and stop. Never repeat a call with the arguments
that just failed, and if \`retryable\` is false do not use that tool again this turn.`;

/**
 * How to spend the skill budget. Stated as rules the model can follow rather than left implicit,
 * because every load costs a model request and the daily allowance is small.
 */
const SKILL_RULES = `Skills are written guidance for one class of work. They tell you how to do
something; they never do it. The tools do that.

Load a skill with \`load_skill\` only when the request in front of you is the class of work its
description names. Do not load one to greet someone, to say what you can do, or to answer something
you can already answer — most turns need no skill at all. Never load the same skill twice: once its
guidance is above, it stays available for the rest of the conversation.`;

/**
 * The base prompt plus the registry's skill index.
 *
 * INVARIANT: names and descriptions only. The bodies are what the loader tools exist to fetch, and
 * putting them here would both defeat that design and re-send every skill on every request.
 */
export function buildSystemPrompt(
  index: { name: string; description: string }[] = skillIndex(),
): string {
  if (index.length === 0) return BASE_PROMPT;

  const listing = index.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");

  return `${BASE_PROMPT}\n\n${SKILL_RULES}\n\nSkills available to you:\n${listing}`;
}

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
 * Builds the request messages: the conversation, and — when resuming after an interaction — the
 * assistant's partial output with the resolution attached as that tool's result.
 *
 * INVARIANT: no `system` message. The SDK rejects one inside `messages`; the base prompt is passed
 * as `instructions` instead.
 * INVARIANT: every `tool-call` emitted has a matching `tool-result`. A provider rejects the whole
 * request over one dangling call, so unanswerable calls are dropped rather than replayed.
 */
export function toModelMessages(a: {
  history: HistoryMessage[];
  blocks: ContentBlock[];
  resolutions: TurnResolution[];
}): ModelMessage[] {
  const messages: ModelMessage[] = [];

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
