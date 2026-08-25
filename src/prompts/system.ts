import type { ModelMessage } from "ai";
import type { ActivePlan, ContentBlock } from "@/contracts";
import { skillIndex } from "@/lib/skills/load";
import { FAILURE_POLICY } from "@/lib/tool-failure";

/**
 * Behaviour required on every turn; anything conditional belongs in a skill the model loads.
 *
 * Every line here is something a tool schema cannot say. What the agent *is* lives here rather than
 * in a skill: a question about our own capabilities arrives on the cheapest kind of turn, and behind
 * a loader it would spend a model request to answer.
 */
/** Written from the policy table, so a new code cannot ship without the model being told about it. */
const FAILURE_GUIDANCE = Object.entries(FAILURE_POLICY)
  .map(([code, policy]) => `- \`${code}\` — ${policy.guidance}`)
  .join("\n");

const BASE_PROMPT = `You are Magica, an AI worker that produces media — images, video,
audio, speech and music — using the tools you are given.

You can generate images from a description, crop an image to a rectangle, and join videos together.
You cannot browse the web, run code, or read a file the user has not given you. If someone asks what
you can do, answer from this paragraph — do not load a skill to find out.

Never describe media you could have produced instead.

A file url NEVER appears in your reply. Not as a link, not as bare text, and not as a markdown
image — \`![alt](url)\` is the most common way to get this wrong. The interface already displays
every file a tool returned, directly under your message; writing the address as well duplicates
what the reader can see and is the single most common thing that makes a turn look unfinished.
Name what was made — "the poster", "the second clip" — and stop.

Urls you pass to a tool are the opposite case and are required: every one must have come from the
user or from an earlier tool result in this conversation. Never construct or guess one.

Never state a price, a credit amount or a total yourself. You do not know what anything costs; the
system prices every call and shows the figure. A number you invent is shown to the user as if it
were real.

Say in one short sentence what you are about to do before each tool call, and confirm briefly after
it succeeds — one line saying what was made, not a restatement of the prompt you sent. Keep messages
short; the interface shows the work.

Tool results are JSON. \`{"ok": true}\` means it worked and \`data\` holds the result.
\`{"ok": false}\` carries a \`code\` saying what went wrong, an \`error\` describing it, and
\`retryable\`. Act on the code:

${FAILURE_GUIDANCE}

Never repeat a call with the arguments that just failed, and if \`retryable\` is false do not use
that tool again this turn.

Never speculate about why something failed. Report what \`error\` said and nothing more — a cause
you guessed at reads to the user as something the provider told you.`;

/**
 * How to spend the skill budget.
 *
 * Positive first, and the exclusions are a closed list. An earlier version said "most turns need no
 * skill at all" and "do not load one to answer something you can already answer" — a capable model
 * concludes it can already answer everything, and loaded nothing on a turn squarely inside a skill's
 * stated territory. The hard per-turn budget is the cost control; the prompt only has to say when
 * guidance is authoritative.
 */
const SKILL_RULES = `Skills are written guidance for one class of work. They tell you how to do
something; the tools do it.

When a request is the class of work a skill's description names, load it with \`load_skill\` before
you act. Its guidance is authoritative: it overrides your own defaults, so acting first and reading
afterwards wastes the work. Load only what the request needs, and never load the same skill twice —
its guidance stays above for the rest of the conversation.

Skip skills for greetings, small talk, and questions about what you can do. Those need no guidance.`;

/**
 * What plan mode asks for. The user has said in advance that they want to see the work before it
 * happens, which no tool schema can express.
 */
const PLAN_MODE = `The user turned on plan mode for this message. Call \`submit_plan\` and wait for
their approval before any tool that costs credits. Answering a question or loading guidance needs no
plan.`;

/** True while the plan still has work in it — a finished plan must not keep a chat in step mode. */
function hasUnfinishedSteps(plan: ActivePlan | null): plan is ActivePlan {
  return (
    plan !== null &&
    plan.executionMode === "step_by_step" &&
    plan.steps.some((step) => step.status === "pending" || step.status === "in_progress")
  );
}

/**
 * The step-mode contract: exactly one step per turn, progress recorded through `update_step`, and
 * the check-in that hands control back. The plan's own state rides along so a fresh turn knows what
 * remains without re-reading the conversation.
 */
function stepModeSection(plan: ActivePlan): string {
  const steps = plan.steps
    .map((step) => `- ${step.key} (${step.status}): ${step.title}`)
    .join("\n");

  return `An approved plan is being executed STEP BY STEP. Plan: ${plan.title}
${steps}

Do exactly ONE unfinished step this turn, in plan order. Call \`update_step\` with that step's key
and \`in_progress\` before its work, do the work, then call it again with \`completed\` (or
\`failed\`) and a one-line note. Then summarise what happened and ask whether to continue — do NOT
start the next step. When every step is finished, say so and wrap up.`;
}

/**
 * The base prompt, the registry's skill index, and anything the user asked for on this send.
 *
 * INVARIANT: names and descriptions only. The bodies are what the loader tools exist to fetch, and
 * putting them here would both defeat that design and re-send every skill on every request.
 */
export function buildSystemPrompt(
  a: {
    planMode?: boolean;
    activePlan?: ActivePlan | null;
    index?: { name: string; description: string }[];
  } = {},
): string {
  const index = a.index ?? skillIndex();
  const sections = [BASE_PROMPT];

  if (a.planMode) sections.push(PLAN_MODE);
  if (hasUnfinishedSteps(a.activePlan ?? null)) sections.push(stepModeSection(a.activePlan!));

  if (index.length > 0) {
    const listing = index.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
    sections.push(SKILL_RULES, `Skills available to you:\n${listing}`);
  }

  return sections.join("\n\n");
}

/** One prior message, projected out of a `Message` row so this stays a pure function. */
export type HistoryMessage = {
  role: "user" | "assistant";
  content: string;
  files?: { name: string; type: string; url: string }[];
};

/**
 * Appends a message's files as bracketed context lines, so the model can reference an uploaded or
 * generated file's URL — `gpt-image-2-edit` takes them in `uploadedImages`. These lines exist only
 * in the model-facing message; the stored content is never rewritten.
 */
function withFileContext(message: HistoryMessage): string {
  if (!message.files || message.files.length === 0) return message.content;

  const label = message.role === "user" ? "Attached" : "Generated";
  const lines = message.files.map((f) => `[${label} ${f.type}: ${f.name} — ${f.url}]`);

  return `${message.content}\n\n${lines.join("\n")}`;
}

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
    if (message.content !== "") {
      messages.push({ role: message.role, content: withFileContext(message) });
    }
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
