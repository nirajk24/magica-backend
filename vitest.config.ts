import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Declared per project rather than once at the root: Vitest does not inherit a root-level
 * `resolve` into `projects`, so a shared block silently fails to apply and every `@/` import
 * reads as a missing package.
 */
const resolve = {
  alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
          setupFiles: ["tests/setup/env.ts"],
        },
      },
      {
        resolve,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          setupFiles: ["tests/setup/env.ts", "tests/msw/setup.ts"],
          // Set before dotenv runs, which does not override existing vars. Keeps the rate-limit
          // test to a few round trips instead of eleven.
          env: { SEND_RATE_PER_MINUTE: "3" },
          // Real Neon in us-east-1: ~270ms per round trip from here (measured, decision #46) and
          // several per transaction, so the 5s default fails healthy tests on latency alone.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
  resolve,
});
