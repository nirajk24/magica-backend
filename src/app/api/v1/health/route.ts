import { db } from "@/lib/db";
import { env } from "@/lib/env";

export async function GET(): Promise<Response> {
  const started = Date.now();
  await db.$queryRaw`SELECT 1`;

  return Response.json({
    data: {
      ok: true,
      env: env.NODE_ENV,
      dbLatencyMs: Date.now() - started,
    },
  });
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204 });
}
