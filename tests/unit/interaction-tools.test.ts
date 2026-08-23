import { describe, expect, it } from "vitest";
import { PlanApprovalPayload, QuestionsPayload } from "@/contracts";
import { buildInteractionOutcome, priceToolCall } from "@/agent/interaction";
import { AppError } from "@/lib/errors";
import { askQuestions } from "@/tools/ask-questions";
import { gptImage2 } from "@/tools/gpt-image-2";
import { registry } from "@/tools/registry";
import { submitPlan } from "@/tools/submit-plan";

const PLENTY = 100_000_000n;

const imageStep = (over: Record<string, unknown> = {}) => ({
  key: "hero_image",
  title: "Generate the hero image",
  description: "A mountain at sunrise.",
  toolCall: { tool: "gpt_image_2", input: { prompt: "a mountain at sunrise" } },
  ...over,
});

const plan = (steps: unknown[]) => ({
  title: "Poster",
  overview: "Two images and a crop.",
  steps,
});

/** What the tool hands the orchestrator, given a plan the model just proposed. */
function prepare(input: unknown, balance = PLENTY) {
  return buildInteractionOutcome({
    tool: submitPlan,
    input: submitPlan.input.parse(input),
    balance,
  });
}

const payloadOf = (outcome: ReturnType<typeof prepare>) => {
  if (!("payload" in outcome)) throw new Error("expected a payload to park on");
  return PlanApprovalPayload.parse(outcome.payload);
};

const resolutionOf = (outcome: ReturnType<typeof prepare>) => {
  if (!("resolution" in outcome)) throw new Error("expected an immediate resolution");
  return outcome.resolution as { kind: string; approved: boolean; feedback?: string };
};

describe("priceToolCall", () => {
  it("returns exactly what that tool's own estimator charges at execution", () => {
    const input = gptImage2.input.parse({ prompt: "a mountain at sunrise" });

    expect(priceToolCall({ tool: "gpt_image_2", input: { prompt: "a mountain at sunrise" } })).toBe(
      gptImage2.credits(input),
    );
  });

  it("prices through the tool's schema, so a clamped value cannot be priced at its asking rate", () => {
    const asked = priceToolCall({
      tool: "gpt_image_2",
      input: { prompt: "a mountain", quality: "High" },
    });

    expect(asked).toBe(gptImage2.credits(gptImage2.input.parse({ prompt: "a mountain" })));
  });

  it("refuses a tool that is not in the registry, naming the ones that are", () => {
    expect(() => priceToolCall({ tool: "make_movie", input: {} })).toThrow(/gpt_image_2/);
  });

  it("refuses a tool that asks rather than works, so a plan cannot contain a plan", () => {
    expect(() => priceToolCall({ tool: "submit_plan", input: {} })).toThrow(/not a tool that can run a step/);
    expect(() => priceToolCall({ tool: "ask_questions", input: {} })).toThrow(/not a tool that can run a step/);
  });

  it("refuses arguments the tool would reject, naming the field", () => {
    expect(() => priceToolCall({ tool: "gpt_image_2", input: { prompt: "" } })).toThrow(/prompt/);
  });
});

describe("submit_plan", () => {
  it("is registered as an interaction tool with no execute, which is what parks the turn", () => {
    expect(registry.submit_plan).toBe(submitPlan);
    expect(submitPlan.interaction).toBe("plan_approval");
    expect(submitPlan.execute).toBeUndefined();
    expect(submitPlan.credits({} as never)).toBe(0n);
  });

  it("prices every step through the registry and totals them", () => {
    const one = gptImage2.credits(gptImage2.input.parse({ prompt: "a mountain at sunrise" }));

    const payload = payloadOf(prepare(plan([imageStep(), imageStep({ key: "second" })])));

    expect(payload.steps.map((step) => step.estimatedCredits)).toEqual([
      one.toString(),
      one.toString(),
    ]);
    expect(payload.estimatedTotal).toBe((one * 2n).toString());
  });

  it("ignores a cost the model states, because the card must never show an invented number", () => {
    const step = imageStep({ estimatedCredits: "999999999", cost: "3 credits" });

    const payload = payloadOf(prepare(plan([step])));

    expect(payload.steps[0]?.estimatedCredits).toBe(
      gptImage2.credits(gptImage2.input.parse({ prompt: "a mountain at sunrise" })).toString(),
    );
    expect(JSON.stringify(payload)).not.toContain("999999999");
  });

  it("carries the step key and sub-model through, so step mode has something to target", () => {
    const payload = payloadOf(
      prepare(plan([imageStep({ toolCall: { tool: "crop_image", subModelId: "crop_image", input: {
        image_url: "https://x.test/a.png",
        x_percent: 0,
        y_percent: 0,
        width_percent: 100,
        height_percent: 50,
      } } })])),
    );

    expect(payload.steps[0]).toMatchObject({
      key: "hero_image",
      tool: "crop_image",
      subModelId: "crop_image",
    });
  });

  it("answers an unpriceable step itself, so the model re-plans instead of the turn dying", () => {
    const outcome = prepare(plan([imageStep({ toolCall: { tool: "make_movie", input: {} } })]));
    const resolution = resolutionOf(outcome);

    expect(resolution).toMatchObject({ kind: "plan_approval", approved: false });
    expect(resolution.feedback, "the model must know which step to fix").toMatch(/hero_image/);
  });

  it("answers a step whose arguments that tool would reject", () => {
    const outcome = prepare(plan([imageStep({ toolCall: { tool: "gpt_image_2", input: {} } })]));

    expect(resolutionOf(outcome).feedback).toMatch(/prompt/);
  });

  it("raises LIMIT_EXCEEDED before anything is minted when the plan costs more than the balance", () => {
    const one = gptImage2.credits(gptImage2.input.parse({ prompt: "a mountain at sunrise" }));

    expect(() => prepare(plan([imageStep()]), one - 1n)).toThrow(AppError);

    try {
      prepare(plan([imageStep()]), one - 1n);
    } catch (error) {
      expect((error as AppError).code).toBe("LIMIT_EXCEEDED");
      expect((error as AppError).message, "both figures, so the user can act").toMatch(/0\.00/);
    }
  });

  it("accepts a plan that costs exactly the balance", () => {
    const one = gptImage2.credits(gptImage2.input.parse({ prompt: "a mountain at sunrise" }));

    expect(payloadOf(prepare(plan([imageStep()]), one)).estimatedTotal).toBe(one.toString());
  });

  it("rejects a plan with no steps at all", () => {
    expect(() => submitPlan.input.parse(plan([]))).toThrow();
  });
});

describe("ask_questions", () => {
  it("is the same registry shape as submit_plan, with a different kind", () => {
    expect(registry.ask_questions).toBe(askQuestions);
    expect(askQuestions.interaction).toBe("questions");
    expect(askQuestions.execute).toBeUndefined();
    expect(askQuestions.credits({} as never)).toBe(0n);
  });

  it("parks on the model's input unchanged, because it declares no prepare", () => {
    const input = askQuestions.input.parse({
      message: "Two things before I start",
      questions: [{ id: "city", type: "text", prompt: "Which city?" }],
    });

    const outcome = buildInteractionOutcome({ tool: askQuestions, input, balance: 0n });

    expect(askQuestions.prepare).toBeUndefined();
    expect(outcome).toEqual({ payload: input });
  });

  /**
   * An interaction tool gets no `execute`, so the wrapper that validates every other tool's input
   * never runs. Parking on an unvalidated payload strands the turn: the client cannot parse it, so
   * it renders no panel, and the question waits for an answer nobody can give.
   */
  it("rejects arguments the client would not be able to render", () => {
    const overlong = {
      message: "x".repeat(2_001),
      questions: [{ id: "city", type: "text", prompt: "Which city?" }],
    };

    expect(() =>
      buildInteractionOutcome({ tool: askQuestions, input: overlong, balance: 0n }),
    ).toThrow(/message/);
  });

  it("parks on a paragraph of preamble, which is what a model actually writes", () => {
    const input = {
      message: "To create your poster I need a few details:\n\n".concat("1. Which city?\n".repeat(20)),
      questions: [{ id: "city", type: "text", prompt: "Which city?" }],
    };

    const outcome = buildInteractionOutcome({ tool: askQuestions, input, balance: 0n });

    expect(QuestionsPayload.safeParse("payload" in outcome ? outcome.payload : null).success).toBe(
      true,
    );
  });

  it("defaults a question to optional, an image to one file, and a select to allowing other", () => {
    const parsed = QuestionsPayload.parse({
      message: "A few things",
      questions: [
        { id: "city", type: "text", prompt: "Which city?" },
        { id: "photo", type: "image", prompt: "A reference photo" },
        {
          id: "palette",
          type: "select",
          prompt: "Which palette?",
          options: [
            { value: "warm", label: "Warm" },
            { value: "cool", label: "Cool", recommended: true },
          ],
        },
      ],
    });

    expect(parsed.questions.map((question) => question.required)).toEqual([false, false, false]);
    expect(parsed.questions[1]).toMatchObject({ maxImages: 1 });
    expect(parsed.questions[2]).toMatchObject({ allowOther: true });
  });

  it("rejects a select with nothing to choose between", () => {
    expect(() =>
      askQuestions.input.parse({
        message: "Pick one",
        questions: [
          {
            id: "palette",
            type: "select",
            prompt: "Which palette?",
            options: [{ value: "warm", label: "Warm" }],
          },
        ],
      }),
    ).toThrow();
  });

  it("bounds a round at eight questions, so a panel cannot become a form", () => {
    const questions = Array.from({ length: 9 }, (_, index) => ({
      id: `q${index}`,
      type: "text" as const,
      prompt: "?",
    }));

    expect(() => askQuestions.input.parse({ message: "many", questions })).toThrow();
  });
});
