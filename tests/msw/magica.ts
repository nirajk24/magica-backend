import { http, HttpResponse } from "msw";

const BASE = "https://inference.magica.com";

type Scripted = {
  /** Poll responses returned in order; the last one repeats. */
  polls: { status: string; output?: unknown; error?: string; userMessage?: string; creditUsed?: number }[];
};

const scripts = new Map<string, Scripted>();
export const submissions: string[] = [];
export const polled: string[] = [];

export function resetMagica() {
  scripts.clear();
  submissions.length = 0;
  polled.length = 0;
}

/**
 * Handlers for the Magica node API. Poll responses are scripted per run id so a test can walk a
 * run through QUEUED → RUNNING → COMPLETED, and `submissions` records every accepted `/run` so a
 * test can assert a resumed attempt did not submit twice.
 */
export function magicaHandlers(opts?: {
  runStatus?: number;
  runId?: string;
  polls?: Scripted["polls"];
  pollStatus?: number;
  retryAfter?: string;
}) {
  const runId = opts?.runId ?? "run_fixture_1";

  return [
    http.post(`${BASE}/v1/nodes/:nodeType/run`, ({ params }) => {
      if (opts?.runStatus && opts.runStatus !== 202) {
        return HttpResponse.json(
          { error: "nope", message: "rejected", code: "X", traceId: "t" },
          {
            status: opts.runStatus,
            headers: opts.retryAfter ? { "Retry-After": opts.retryAfter } : undefined,
          },
        );
      }

      submissions.push(String(params.nodeType));
      scripts.set(runId, {
        polls: opts?.polls ?? [
          { status: "QUEUED" },
          { status: "RUNNING" },
          {
            status: "COMPLETED",
            output: { images: ["https://cdn.magica.com/out/1.png"] },
            creditUsed: 5880,
          },
        ],
      });

      return HttpResponse.json({ runId }, { status: 202 });
    }),

    http.get(`${BASE}/v1/nodes/runs/:runId`, ({ params }) => {
      const id = String(params.runId);
      polled.push(id);

      if (opts?.pollStatus) {
        return HttpResponse.json({ error: "nope" }, { status: opts.pollStatus });
      }

      const script = scripts.get(id) ?? { polls: opts?.polls ?? [{ status: "COMPLETED" }] };
      const index = Math.min(polled.filter((p) => p === id).length - 1, script.polls.length - 1);
      const next = script.polls[index]!;

      return HttpResponse.json({ id, ...next });
    }),
  ];
}
