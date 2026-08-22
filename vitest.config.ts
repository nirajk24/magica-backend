import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * The alias is declared per project, not once at the root: Vitest does not inherit a root-level
 * `resolve` into `projects`, so a shared block silently fails to apply and every `@/` import
 * resolves as a missing package.
 *
 * Integration tests get a 30s timeout because they hit a real Neon database in us-east-1: a
 * transaction costs several round trips at roughly 270ms each from here, so a test doing half a
 * dozen of them blows the 5s default on latency alone rather than on anything being wrong.
 */
const resolve = {
  alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
};

/**
 * Integration tests talk to Neon in us-east-1 over a ~270 ms round trip (measured, decision #46),
 * and a transaction costs several of them. The 5 s default fails healthy tests on latency alone.
 */
const SLOW_DB = { testTimeout: 60_000, hookTimeout: 60_000 };

export default defineConfig({
  test: {
    ...SLOW_DB,
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
          testTimeout: 30_000,
        },
      },
    ],
  },
  resolve,
});
