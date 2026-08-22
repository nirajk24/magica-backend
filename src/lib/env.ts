import { z } from "zod";

const flag = (fallback: "true" | "false") =>
  z.enum(["true", "false"]).default(fallback).transform((v) => v === "true");

const Env = z.object({
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

  FRONTEND_URL: z.string().url(),

  ADMISSION_CREDITS: z.coerce.bigint().default(500_000n),
  SIGNUP_GRANT_CREDITS: z.coerce.bigint().default(30_000_000n),
  MAX_STEPS: z.coerce.number().int().min(1).max(24).default(6),
  SEND_RATE_PER_MINUTE: z.coerce.number().int().default(10),

  DEMO_MODE: flag("false"),
  DISABLE_TITLE_GEN: flag("false"),
});

/**
 * Validated process.env. Imported for side effect at boot so a missing or malformed
 * variable throws here, naming the variable, instead of surfacing as `undefined`
 * somewhere downstream.
 */
export const env = Env.parse(process.env);

export type Env = typeof env;
