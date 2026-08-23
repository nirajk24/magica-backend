import { z } from "zod";

const flag = (fallback: "true" | "false") =>
  z.enum(["true", "false"]).default(fallback).transform((v) => v === "true");

const EnvShape = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: z.string().url(),
  DATABASE_URL_UNPOOLED: z.string().url(),

  CLERK_SECRET_KEY: z.string().startsWith("sk_"),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().startsWith("pk_"),
  CLERK_WEBHOOK_SIGNING_SECRET: z.string().optional(),

  TRIGGER_SECRET_KEY: z.string().startsWith("tr_"),
  TRIGGER_PROJECT_REF: z.string().startsWith("proj_"),

  OPENROUTER_API_KEY: z.string().startsWith("sk-or-"),

  MAGICA_API_KEY: z.string().startsWith("gx_"),
  MAGICA_BASE_URL: z.string().url().default("https://inference.magica.com"),

  /**
   * Optional: every Trigger.dev task parses this whole schema at boot, and uploads are the one
   * feature these serve. The sign route fails by name when they are absent.
   */
  TRANSLOADIT_KEY: z.string().optional(),
  TRANSLOADIT_SECRET: z.string().optional(),

  /**
   * Hosts a completed upload may claim to be served from, comma-separated. Which one applies is an
   * account-level storage decision at the provider, not something this code can assume — empty
   * accepts any address, which is what §11 documents.
   */
  UPLOAD_RESULT_HOSTS: z.string().default("r2.dev,transloadit.com"),

  FRONTEND_URL: z.string().url(),

  ADMISSION_CREDITS: z.coerce.bigint().default(500_000n),
  SIGNUP_GRANT_CREDITS: z.coerce.bigint().default(30_000_000n),
  OPENROUTER_DAILY_REQUESTS: z.coerce.number().int().min(1).default(50),
  MAX_TURNS: z.coerce.number().int().min(1).max(6).default(3),
  MAX_STEPS: z.coerce.number().int().min(1).max(8).default(4),
  /** Distinct skills one run may load. Each load costs an OpenRouter request from a 50/day budget. */
  MAX_SKILL_LOADS_PER_TURN: z.coerce.number().int().min(0).max(5).default(2),
  SEND_RATE_PER_MINUTE: z.coerce.number().int().default(10),

  DEMO_MODE: flag("false"),
  DISABLE_TITLE_GEN: flag("false"),
});

/**
 * The largest share of a day's model requests one turn is allowed to be able to spend. A runaway
 * loop is the realistic failure, so the ceiling exists to bound it, not to ration normal use — a
 * one-tool turn costs two requests whatever the caps are set to.
 */
const MAX_BUDGET_SHARE_PER_TURN = 0.5;

/**
 * Whether the two loop bounds multiply out to more of the daily request budget than one turn may
 * spend. `MAX_TURNS` bounds our outer loop and `MAX_STEPS` bounds the SDK's inner tool loop, so the
 * worst case is their PRODUCT — which is how a 12 x 8 pair once added up to 96 requests against a
 * cap of 50.
 */
export function exceedsRequestBudget(a: {
  maxTurns: number;
  maxSteps: number;
  dailyRequests: number;
}): boolean {
  return a.maxTurns * a.maxSteps > Math.floor(a.dailyRequests * MAX_BUDGET_SHARE_PER_TURN);
}

/**
 * Validated process.env. Imported for side effect at boot so a missing or malformed
 * variable throws here, naming the variable, instead of surfacing as `undefined`
 * somewhere downstream.
 */
export const env = EnvShape.superRefine((e, ctx) => {
  if (
    exceedsRequestBudget({
      maxTurns: e.MAX_TURNS,
      maxSteps: e.MAX_STEPS,
      dailyRequests: e.OPENROUTER_DAILY_REQUESTS,
    })
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["MAX_TURNS"],
      message:
        `MAX_TURNS x MAX_STEPS = ${e.MAX_TURNS * e.MAX_STEPS} requests, more than half of ` +
        `OPENROUTER_DAILY_REQUESTS (${e.OPENROUTER_DAILY_REQUESTS}). One runaway turn would spend ` +
        `the day. Raise one bound, never both.`,
    });
  }
}).parse(process.env);

export type Env = typeof env;
