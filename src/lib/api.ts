import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { AppError, statusFor } from "@/lib/errors";
import { bindContext, logger, type Logger } from "@/lib/logger";
import { env } from "@/lib/env";

type RouteContext<TBody, TQuery> = {
  userId: string;
  body: TBody;
  query: TQuery;
  params: Record<string, string>;
  traceId: string;
  log: Logger;
};

type RouteOptions<TBody, TQuery, TOut> = {
  body?: z.ZodType<TBody>;
  query?: z.ZodType<TQuery>;
  handler: (ctx: RouteContext<TBody, TQuery>) => Promise<TOut>;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": env.FRONTEND_URL,
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type,Idempotency-Key",
  "Access-Control-Max-Age": "86400",
};

function respond(body: unknown, status: number, extra?: HeadersInit): Response {
  return Response.json(body, { status, headers: { ...corsHeaders, ...extra } });
}

function fail(e: AppError, traceId: string): Response {
  return respond(
    { error: { code: e.code, message: e.message, details: e.details, traceId } },
    e.status,
    e.retryAfterSeconds ? { "Retry-After": String(e.retryAfterSeconds) } : undefined,
  );
}

/**
 * Wraps a route handler with auth, Zod parsing of body and query, the shared `{ data }` /
 * `{ error }` envelope, CORS headers and a traceId bound into the logger.
 *
 * Handlers receive a guaranteed `userId` and already-parsed input, so they contain no
 * validation or error-mapping code. Throw an AppError to produce a specific status;
 * anything else becomes INTERNAL with a generic message.
 */
export function defineRoute<TBody = undefined, TQuery = undefined, TOut = unknown>(
  opts: RouteOptions<TBody, TQuery, TOut>,
) {
  return async (
    req: Request,
    segment: { params: Promise<Record<string, string>> },
  ): Promise<Response> => {
    const traceId = `req_${crypto.randomUUID()}`;
    const log = bindContext(logger, { traceId });

    try {
      const { userId } = await auth();
      if (!userId) throw new AppError("UNAUTHENTICATED", "Sign in to continue.");

      const body = opts.body ? opts.body.parse(await req.json()) : (undefined as TBody);
      const query = opts.query
        ? opts.query.parse(Object.fromEntries(new URL(req.url).searchParams))
        : (undefined as TQuery);

      const data = await opts.handler({
        userId,
        body,
        query,
        params: await segment.params,
        traceId,
        log,
      });

      return respond({ data }, 200);
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
        {
          error: {
            code: "INTERNAL",
            message: "Something went wrong on our side.",
            traceId,
          },
        },
        statusFor("INTERNAL"),
      );
    }
  };
}

/** Preflight responder. Exported so a route can satisfy CORS without touching auth. */
export function preflight(): Response {
  return new Response(null, { status: 204, headers: corsHeaders });
}
