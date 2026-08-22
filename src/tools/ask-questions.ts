import { z } from "zod";
import { QuestionsPayload, QuestionsResolution, WaitpointExpired } from "@/contracts";
import { defineTool } from "@/tools/define";

/**
 * Asks the user for something the agent cannot invent, and waits for the answers.
 *
 * Callable more than once in a turn: a round whose answers were skipped is a normal outcome, and the
 * model is expected to explain why it cannot proceed and ask again more narrowly.
 *
 * The payload is the input unchanged — no `prepare` — which is the whole demonstration that the
 * waitpoint machinery is kind-agnostic: a second kind is a registry entry and nothing else.
 */
export const askQuestions = defineTool({
  name: "ask_questions",
  description:
    "Ask the user for information you cannot invent — a reference photo, a missing choice, a " +
    "preference — before spending credits on work that would be wrong without it. Ask only what " +
    "you genuinely cannot proceed without, and mark those questions required. Every question can " +
    "be skipped by the user, so be ready to continue without an answer.",
  display: { label: "Asking questions", icon: "message-circle-question" },
  tags: ["interaction"],
  interaction: "questions",
  input: QuestionsPayload,
  output: z.union([QuestionsResolution, WaitpointExpired]),
  credits: () => 0n,
});
