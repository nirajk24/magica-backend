import { it } from "vitest";
it("probe: how long before timeout", async () => {
  await new Promise((r) => setTimeout(r, 20_000));
});
