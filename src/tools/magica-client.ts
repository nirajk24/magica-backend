import { z } from "zod";
import { env } from "@/lib/env";
import { ToolError } from "@/lib/errors";

const TERMINAL = ["COMPLETED", "FAILED", "CANCELED"] as const;

const NodeRunStatus = z.enum([
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELED",
]);

const RunAccepted = z.object({ runId: z.string().min(1) });

const NodeRun = z.object({
  id: z.string(),
  status: NodeRunStatus,
  output: z.json().nullable().optional(),
  error: z.string().nullable().optional(),
  userMessage: z.string().nullable().optional(),
  creditUsed: z.number().nullable().optional(),
});
export type NodeRun = z.infer<typeof NodeRun>;

type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Above Trigger.dev's 5s wait-charge threshold on purpose. A shorter wait does not suspend the
 * machine — the SDK sleeps in process and bills it — so a two-minute node run would cost two
 * minutes of compute spent doing nothing. The cost is up to one interval of extra latency after the
 * provider finishes.
 */
const POLL_INTERVAL_MS = 6_000;

/** Long enough for an image; a slower node type passes its own budget. */
const DEFAULT_POLL_TIMEOUT_MS = 120_000;

function headers() {
  return {
    Authorization: `Bearer ${env.MAGICA_API_KEY}`,
    "Content-Type": "application/json",
  };
}

/**
 * Maps a transport failure to a message the model can act on. 403 is Magica's documented signal
 * for exhausted credits, not a permissions problem.
 */
function transportError(status: number, retryAfter: string | null): ToolError {
  if (status === 401) return new ToolError("Magica rejected our API key.");
  if (status === 403) return new ToolError("The Magica account is out of credits.");
  if (status === 429) {
    return new ToolError(
      `Magica is rate limiting us${retryAfter ? `; retry in ${retryAfter}s` : ""}.`,
      true,
    );
  }
  if (status >= 500) return new ToolError("Magica is temporarily unavailable.", true);
  return new ToolError(`Magica did not accept the run (${status}).`);
}

/**
 * Polls one already-submitted run to a terminal state and returns its output.
 *
 * `timeoutMs` is a budget, not a deadline the provider knows about: giving up here abandons the
 * poll, it does not cancel the run, so a resumed attempt can still collect the same result.
 */
export async function pollUntilTerminal(
  runId: string,
  sleep: Sleep = defaultSleep,
  timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
): Promise<{ output: unknown; creditUsed: bigint }> {
  const attempts = Math.max(1, Math.ceil(timeoutMs / POLL_INTERVAL_MS));

  for (let attempt = 0; attempt < attempts; attempt++) {
    const res = await fetch(`${env.MAGICA_BASE_URL}/v1/nodes/runs/${runId}`, {
      headers: headers(),
    });

    if (!res.ok) throw transportError(res.status, res.headers.get("Retry-After"));

    const run = NodeRun.parse(await res.json());

    if (TERMINAL.includes(run.status as (typeof TERMINAL)[number])) {
      if (run.status === "COMPLETED") {
        return { output: run.output ?? null, creditUsed: BigInt(run.creditUsed ?? 0) };
      }
      throw new ToolError(
        run.userMessage ?? run.error ?? `The Magica run ${run.status.toLowerCase()}.`,
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new ToolError("The Magica run did not finish in time.", true);
}

/**
 * Submits a node run, checkpoints the returned id, then polls it to a terminal state.
 *
 * INVARIANT: `onRunId` is awaited before the first poll, so a restarted attempt resumes the same
 * run. Persisting after polling leaves a window where a restart pays for the work twice.
 *
 * Requires a `202` specifically — any other 2xx means the contract moved.
 *
 * Pass `wait.for` as `sleep` from a Trigger.dev task so the machine suspends between polls; see
 * `POLL_INTERVAL_MS` for why the interval cannot be short.
 */
export async function runMagicaNode(a: {
  nodeType: string;
  subModelId?: string;
  input: unknown;
  onRunId: (runId: string) => Promise<void>;
  sleep?: Sleep;
  timeoutMs?: number;
}): Promise<{ output: unknown; creditUsed: bigint }> {
  const res = await fetch(`${env.MAGICA_BASE_URL}/v1/nodes/${a.nodeType}/run`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ input: a.input, subModelId: a.subModelId }),
  });

  if (res.status !== 202) throw transportError(res.status, res.headers.get("Retry-After"));

  const { runId } = RunAccepted.parse(await res.json());
  await a.onRunId(runId);

  return pollUntilTerminal(runId, a.sleep ?? defaultSleep, a.timeoutMs);
}
