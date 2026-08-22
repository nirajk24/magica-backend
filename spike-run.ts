import "dotenv/config";
import { runs, tasks } from "@trigger.dev/sdk";

const handle = await tasks.trigger("metadata-cap-spike", {});
console.log("triggered:", handle.id);

for (let i = 0; i < 60; i++) {
  const run = await runs.retrieve(handle.id);
  if (run.status === "COMPLETED" || run.status === "FAILED" || run.status === "CANCELED") {
    console.log("status:", run.status);
    console.log(JSON.stringify(run.output ?? run.error, null, 2));
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 1500));
}
console.log("timed out waiting for the run");
