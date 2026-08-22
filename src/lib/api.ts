import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { AppError, statusFor } from "@/lib/errors";
import { bindContext, logger, type Logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { ensureUserWithGrant } from "@/lib/users";

type RouteContext<TBody, TQuery> = {
  userId: string;
  body: TBody;
  query: TQuery;
  params: Record<string, string>;
  headers: Headers;
  traceId: string;
  log: Logger;
};

type Segment = { params: Promise<Record<string, string>> };

type RouteOptions<TBody, TQuery, TOut> = {
  body?: z.ZodType<TBody>;
  query?: z.ZodType<TQuery>;
  handler: (ctx: RouteContext<TBody, TQuery>) => Promise<TOut>;
};

type PublicRouteOptions<TQuery, TOut> = {
  query?: z.ZodType<TQuery>;
  handler: (ctx: Omit<RouteContext<undefined, TQuery>, "userId">) => Promise<TOut>;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": env.FRONTEND_URL,
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type,Idempotency-Key",
  "Access-Control-Max-Age": "86400",
};

/**
 * Credits are `BigInt` in Prisma and strings on the wire, which `JSON.stringify` cannot do on its
 * own — it throws on a BigInt. Converting here means a service that forgets to stringify emits the
 * documented wire value instead of a 500.
 */
function serialize(body: unknown): string {
  return JSON.stringify(body, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

function respond(body: unknown, status: number, extra?: HeadersInit): Response {
  return new Response(serialize(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders, ...extra },
  });
}

function fail(e: AppError, traceId: string): Response {
  return respond(
    { error: { code: e.code, message: e.message, details: e.details, traceId } },
    e.status,
    e.retryAfterSeconds ? { "Retry-After": String(e.retryAfterSeconds) } : undefined,
  );
}

/** A body that is not JSON at all is a client mistake, so it maps to 400 and never to 500. */
async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;

  try {
    raw = await req.json();
  } catch {
    throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON.");
  }

  return schema.parse(raw);
}

function parseQuery<T>(req: Request, schema: z.ZodType<T>): T {
  return schema.parse(Object.fromEntries(new URL(req.url).searchParams));
}

/**
 * The one place a route's outcome becomes a response: the shared `{ data }` / `{ error }` envelope,
 * CORS headers, and a traceId bound into the logger and echoed to the client.
 *
 * INVARIANT: an error that is not an `AppError` or a `ZodError` is reported as INTERNAL with a
 * generic message, so provider text and stack traces can never reach a client.
 */
async function runRoute<TOut>(
  work: (ctx: { traceId: string; log: Logger }) => Promise<TOut>,
): Promise<Response> {
  const traceId = `req_${crypto.randomUUID()}`;
  const log = bindContext(logger, { traceId });

  try {
    return respond({ data: await work({ traceId, log }) }, 200);
  } catch (e) {
    if (e instanceof AppError) {
      log.warn({ code: e.code, msg: e.message }, "request failed");
      return fail(e, traceId);
    }
    if (e instanceof z.ZodError) {
      log.warn({ issues: e.issues }, "validation failed");
      return fail(
        new AppError("VALIDATION_ERROR", "Some fields are invalid.", z.flattenError(e)),
        traceId,
      );
    }

    log.error({ err: e }, "unhandled route error");
    return respond(
      { error: { code: "INTERNAL", message: "Something went wrong on our side.", traceId } },
      statusFor("INTERNAL"),
    );
  }
}

/**
 * Wraps a route handler with auth, the account bootstrap, Zod parsing of body and query, and
 * everything `runRoute` provides.
 *
 * Handlers receive a guaranteed `userId` whose `User` row exists, plus already-parsed input, so
 * they contain no validation or error-mapping code. Throw an `AppError` for a specific status.
 */
export function defineRoute<TBody = undefined, TQuery = undefined, TOut = unknown>(
  opts: RouteOptions<TBody, TQuery, TOut>,
) {
  return (req: Request, segment?: Segment): Promise<Response> =>
    runRoute(async ({ traceId, log }) => {
      const { userId } = await auth();
      if (!userId) throw new AppError("UNAUTHENTICATED", "Sign in to continue.");

      await ensureUserWithGrant(userId);

      return opts.handler({
        userId,
        body: opts.body ? await parseBody(req, opts.body) : (undefined as TBody),
        query: opts.query ? parseQuery(req, opts.query) : (undefined as TQuery),
        params: (await segment?.params) ?? {},
        headers: req.headers,
        traceId,
        log,
      });
    });
}

/**
 * `defineRoute` without auth, for an unauthenticated probe. Shares the envelope, the CORS headers
 * and the error mapping, so no route has to assemble a response by hand.
 */
export function definePublicRoute<TQuery = undefined, TOut = unknown>(
  opts: PublicRouteOptions<TQuery, TOut>,
) {
  return (req: Request, segment?: Segment): Promise<Response> =>
    runRoute(async ({ traceId, log }) =>
      opts.handler({
        body: undefined,
        query: opts.query ? parseQuery(req, opts.query) : (undefined as TQuery),
        params: (await segment?.params) ?? {},
        headers: req.headers,
        traceId,
        log,
      }),
    );
}

/** Preflight responder. Exported so a route can satisfy CORS without touching auth. */
export function preflight(): Response {
  return new Response(null, { status: 204, headers: corsHeaders });
}
