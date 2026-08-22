import { defineConfig } from "@trigger.dev/sdk";
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";

/**
 * The project ref is an identifier, not a secret — TRIGGER_SECRET_KEY is what authorises
 * anything — so it is committed rather than read from the environment, which is also the only
 * way `trigger.dev deploy` can resolve it without a loaded `.env`.
 *
 * `mode: "modern"` is the Prisma 7 path: it marks the client external and expects
 * `prisma generate` to have run, which `postinstall` handles on the build machine too.
 * Without this extension the tasks build fine and then crash in production only.
 *
 * `maxAttempts: 1` is decision #20 — retries are manual. An automatic retry would replay a
 * turn that already spent credits and already streamed narrative, and regenerated tool ids
 * would never match the persisted ones.
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
    extensions: [prismaExtension({ mode: "modern" })],
  },
});
