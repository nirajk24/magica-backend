import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";

const cors = {
  "Access-Control-Allow-Origin": env.FRONTEND_URL,
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type,Idempotency-Key",
  "Access-Control-Max-Age": "86400",
};

/**
 * Clerk verifies the `Authorization: Bearer` token the frontend attaches — the two repos
 * are separate origins, so no session cookie is ever sent. It enforces nothing here:
 * `defineRoute` checks auth where the data is read, which is Clerk's current guidance.
 *
 * Named `proxy.ts` because Next 16 deprecated the `middleware` file convention.
 *
 * The OPTIONS short-circuit must run before auth: a preflight carries no Authorization
 * header, so authenticating first would 401 it and the browser would never send the real
 * request.
 */
export default clerkMiddleware(
  async (_auth, req) => {
    if (req.method === "OPTIONS") {
      return new NextResponse(null, { status: 204, headers: cors });
    }
    return NextResponse.next();
  },
  { authorizedParties: [env.FRONTEND_URL] },
);

export const config = {
  matcher: ["/api/(.*)"],
};
