import { defineConfig } from "@trigger.dev/sdk";
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";
import { additionalFiles } from "@trigger.dev/build/extensions/core";

/**
 * `project` is committed because `deploy` resolves it without a loaded `.env`. It is an
 * identifier, not a secret.
 *
 * `mode: "modern"` is the Prisma 7 path — it marks the client external and expects
 * `prisma generate` to have run, which `postinstall` covers. Omitting the extension builds fine
 * and crashes in production only.
 *
 * `maxAttempts: 1` because retries are manual: an automatic one replays a turn that already spent
 * credits, and regenerated tool ids would not match the persisted ones.
 *
 * `agent-skills/` is shipped explicitly. Nothing imports those files, so the bundler cannot see
 * them — without this the skill registry is empty in a deployed task while working perfectly in
 * local dev, and the model is simply never told the skills exist.
 */
export default defineConfig({
  project: "proj_mjuwxfvzechgbshfifzv",
  runtime: "node",
  logLevel: "info",
  maxDuration: 900,
  dirs: ["./src/trigger"],
  retries: {
    enabledInDev: false,
    default: { maxAttempts: 1 },
  },
  build: {
    extensions: [
      prismaExtension({ mode: "modern" }),
      additionalFiles({ files: ["agent-skills/**"] }),
    ],
  },
});
