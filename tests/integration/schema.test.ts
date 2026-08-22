import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { DEFAULT_MODEL_ID } from "@/contracts";

afterAll(() => db.$disconnect());

async function indexDefinition(name: string): Promise<string | null> {
  const rows = await db.$queryRaw<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${name}`;

  return rows[0]?.indexdef ?? null;
}

/**
 * These assertions exist because `prisma migrate dev` generates SQL from the schema and drops
 * anything in the database it cannot see there. Hand-written indexes have already been reverted
 * once that way, and a silently missing one is a correctness bug, not a performance one.
 */
describe("hand-written indexes survive migrate dev", () => {
  it("keeps one_active_run_per_chat, which IS the send concurrency lock", async () => {
    const definition = await indexDefinition("one_active_run_per_chat");

    expect(definition, "a duplicate send would race in application code without this").toContain(
      "UNIQUE",
    );
    expect(definition).toContain("AgentRun");
    expect(definition).toMatch(/WHERE .*queued.*running.*waiting/s);
  });

  it("keeps one_assistant_message_per_run, which makes the turn bootstrap idempotent", async () => {
    const definition = await indexDefinition("one_assistant_message_per_run");

    expect(definition).toContain("UNIQUE");
    expect(definition).toMatch(/WHERE .*assistant/s);
  });

  it("keeps both pg_trgm search indexes", async () => {
    const rows = await db.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexdef LIKE '%gin_trgm_ops%'`;

    expect(rows.map((r) => r.indexname).sort()).toHaveLength(2);
  });
});

describe("column state the application depends on", () => {
  it("has dropped Message.sequence, so pagination has one ordering only", async () => {
    const rows = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'Message' AND column_name = 'sequence'`;

    expect(rows, "messages are ordered by (chatId, createdAt, id) alone").toHaveLength(0);
  });

  it("defaults Chat.modelId to the same id the contract calls default", async () => {
    const rows = await db.$queryRaw<{ column_default: string | null }[]>`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'Chat' AND column_name = 'modelId'`;

    const applied = rows[0]?.column_default?.replace(/^'(.*)'::text$/, "$1");

    expect(applied, "a database default outside ALLOWED_MODELS fails ModelId.parse on read").toBe(
      DEFAULT_MODEL_ID,
    );
  });

  it("gives every updatedAt a database-level default, because raw inserts skip Prisma", async () => {
    const rows = await db.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'updatedAt' AND column_default IS NULL`;

    expect(rows.map((r) => r.table_name)).toEqual([]);
  });
});
