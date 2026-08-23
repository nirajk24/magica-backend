import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MONTHLY_QUOTA_BYTES, usagePeriod } from "@/lib/transloadit";

const clerk = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => Promise.resolve({ userId: clerk.userId }),
  currentUser: () =>
    Promise.resolve(
      clerk.userId ? { primaryEmailAddress: { emailAddress: `${clerk.userId}@clerk.test` } } : null,
    ),
}));

const { db } = await import("@/lib/db");
const { env } = await import("@/lib/env");
const { uuidv7 } = await import("@/lib/ids");

const signRoute = await import("@/app/api/v1/uploads/sign/route");
const attachmentsRoute = await import("@/app/api/v1/attachments/route");
const attachmentRoute = await import("@/app/api/v1/attachments/[attachmentId]/route");

const created: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `test_${uuidv7()}`;
  created.push(userId);
  await db.user.create({ data: { id: userId, email: `${userId}@test.local` } });

  return userId;
}

const sign = (body: unknown) =>
  signRoute.POST(
    new Request("http://localhost/api/v1/uploads/sign", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );

const report = (body: unknown) =>
  attachmentsRoute.POST(
    new Request("http://localhost/api/v1/attachments", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );

const list = (query = "") =>
  attachmentsRoute.GET(new Request(`http://localhost/api/v1/attachments${query}`), {
    params: Promise.resolve({}),
  });

const rename = (attachmentId: string, body: unknown) =>
  attachmentRoute.PATCH(
    new Request(`http://localhost/api/v1/attachments/${attachmentId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ attachmentId }) },
  );

const remove = (attachmentId: string) =>
  attachmentRoute.DELETE(
    new Request(`http://localhost/api/v1/attachments/${attachmentId}`, { method: "DELETE" }),
    { params: Promise.resolve({ attachmentId }) },
  );

async function envelope<T>(res: Response) {
  return (await res.json()) as { data?: T; error?: { code: string; message: string } };
}

const pngFile = (over?: Record<string, unknown>) => ({
  name: "photo.png",
  contentType: "image/png",
  size: 1_352_915,
  ...over,
});

const readyReport = (over?: Record<string, unknown>) => ({
  assemblyId: `asm_${uuidv7()}`,
  status: "ready",
  file: { ...pngFile(), url: "https://tmp.transloadit.com/view/photo.png", metadata: { width: 800 } },
  ...over,
});

type AttachmentBody = {
  attachment: {
    id: string;
    status: string;
    url: string | null;
    name: string;
    source: string;
    expiresAt: string | null;
    createdAt: string;
  };
};

const bytesUsed = async (userId: string) =>
  (
    await db.uploadUsage.findUnique({
      where: { userId_period: { userId, period: usagePeriod(new Date()) } },
      select: { bytesUsed: true },
    })
  )?.bytesUsed ?? 0n;

beforeEach(() => {
  clerk.userId = null;
});

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
});

describe("POST /uploads/sign", () => {
  it("answers one signed assembly per file, in order", async () => {
    clerk.userId = await seedUser();

    const res = await sign({ files: [pngFile(), pngFile({ name: "b.mp4", contentType: "video/mp4" })] });
    const body = await envelope<{ assemblies: { params: string; signature: string }[] }>(res);

    expect(res.status).toBe(200);
    expect(body.data?.assemblies).toHaveLength(2);

    for (const assembly of body.data?.assemblies ?? []) {
      expect(assembly.signature).toMatch(/^sha384:[0-9a-f]{96}$/);
      const params = JSON.parse(assembly.params) as { num_expected_upload_files: number };
      expect(params.num_expected_upload_files).toBe(1);
    }
  });

  it("rejects a non-media MIME type at the boundary", async () => {
    clerk.userId = await seedUser();

    const res = await sign({ files: [pngFile({ contentType: "application/pdf" })] });
    const body = await envelope(res);

    expect(res.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a file over 0.5 GB with a field-specific QUOTA_EXCEEDED before signing", async () => {
    clerk.userId = await seedUser();

    const res = await sign({ files: [pngFile(), pngFile({ name: "big.mp4", contentType: "video/mp4", size: 536_870_913 })] });
    const body = await envelope(res);

    expect(res.status).toBe(413);
    expect(body.error?.code).toBe("QUOTA_EXCEEDED");
    expect(body.error?.message).toContain("big.mp4");
  });

  it("rejects a request that would cross the 5 GB monthly allowance", async () => {
    clerk.userId = await seedUser();
    await db.uploadUsage.create({
      data: {
        userId: clerk.userId,
        period: usagePeriod(new Date()),
        bytesUsed: MONTHLY_QUOTA_BYTES - 1000n,
      },
    });

    const res = await sign({ files: [pngFile({ size: 2000 })] });
    const body = await envelope(res);

    expect(res.status).toBe(413);
    expect(body.error?.code).toBe("QUOTA_EXCEEDED");
    expect(body.error?.message).toContain("5 GB");
  });

  it("fails by name when the Transloadit credentials are absent", async () => {
    clerk.userId = await seedUser();

    const key = env.TRANSLOADIT_KEY;
    env.TRANSLOADIT_KEY = undefined;
    try {
      const res = await sign({ files: [pngFile()] });
      const body = await envelope(res);

      expect(res.status).toBe(500);
      expect(body.error?.message).toContain("TRANSLOADIT_KEY");
    } finally {
      env.TRANSLOADIT_KEY = key;
    }
  });
});

describe("POST /attachments", () => {
  it("persists a ready assembly and counts its bytes toward the month", async () => {
    clerk.userId = await seedUser();

    const res = await report(readyReport());
    const body = await envelope<AttachmentBody>(res);

    expect(res.status).toBe(200);
    expect(body.data?.attachment.status).toBe("ready");
    expect(body.data?.attachment.source).toBe("uploaded");
    expect(body.data?.attachment.url).toContain("transloadit.com");
    expect(body.data?.attachment.expiresAt).not.toBeNull();
    expect(await bytesUsed(clerk.userId)).toBe(1_352_915n);
  });

  it("upserts a duplicate completion onto the same row and never double-counts usage", async () => {
    clerk.userId = await seedUser();
    const payload = readyReport();

    const first = await envelope<AttachmentBody>(await report(payload));
    const second = await envelope<AttachmentBody>(await report(payload));

    expect(second.data?.attachment.id).toBe(first.data?.attachment.id);
    expect(await bytesUsed(clerk.userId)).toBe(1_352_915n);
  });

  it("moves uploading to ready, counting usage only on the transition", async () => {
    clerk.userId = await seedUser();
    const assemblyId = `asm_${uuidv7()}`;

    const pending = await envelope<AttachmentBody>(
      await report({ assemblyId, status: "uploading", file: pngFile() }),
    );
    expect(pending.data?.attachment.status).toBe("uploading");
    expect(pending.data?.attachment.expiresAt).toBeNull();
    expect(await bytesUsed(clerk.userId)).toBe(0n);

    const done = await envelope<AttachmentBody>(await report(readyReport({ assemblyId })));
    expect(done.data?.attachment.id).toBe(pending.data?.attachment.id);
    expect(done.data?.attachment.status).toBe("ready");
    expect(await bytesUsed(clerk.userId)).toBe(1_352_915n);
  });

  it("never downgrades a ready row on a late failure report", async () => {
    clerk.userId = await seedUser();
    const payload = readyReport();

    await report(payload);
    const late = await envelope<AttachmentBody>(
      await report({ assemblyId: payload.assemblyId, status: "failed", file: pngFile() }),
    );

    expect(late.data?.attachment.status).toBe("ready");
  });

  it("answers NOT_FOUND for another user's assemblyId", async () => {
    clerk.userId = await seedUser();
    const payload = readyReport();
    await report(payload);

    clerk.userId = await seedUser();
    const res = await report(payload);
    const body = await envelope(res);

    expect(res.status).toBe(404);
    expect(body.error?.code).toBe("NOT_FOUND");
  });

  it("rejects a ready report that carries no result URL", async () => {
    clerk.userId = await seedUser();

    const res = await report({ assemblyId: `asm_${uuidv7()}`, status: "ready", file: pngFile() });

    expect(res.status).toBe(400);
  });
});

describe("GET /attachments", () => {
  it("pages newest-first without repeating across the cursor, and filters by source", async () => {
    clerk.userId = await seedUser();
    for (let i = 0; i < 3; i++) await report(readyReport());

    const pageOne = await envelope<{ attachments: { id: string }[]; nextCursor: string | null }>(
      await list("?limit=2"),
    );
    expect(pageOne.data?.attachments).toHaveLength(2);
    expect(pageOne.data?.nextCursor).not.toBeNull();

    const pageTwo = await envelope<{ attachments: { id: string }[]; nextCursor: string | null }>(
      await list(`?limit=2&cursor=${pageOne.data?.nextCursor}`),
    );
    expect(pageTwo.data?.attachments).toHaveLength(1);
    expect(pageTwo.data?.nextCursor).toBeNull();

    const ids = [...(pageOne.data?.attachments ?? []), ...(pageTwo.data?.attachments ?? [])].map(
      (a) => a.id,
    );
    expect(new Set(ids).size).toBe(3);

    const generated = await envelope<{ attachments: unknown[] }>(await list("?source=generated"));
    expect(generated.data?.attachments).toHaveLength(0);
  });

  it("only ever lists the caller's rows", async () => {
    clerk.userId = await seedUser();
    await report(readyReport());

    clerk.userId = await seedUser();
    const body = await envelope<{ attachments: unknown[] }>(await list());

    expect(body.data?.attachments).toHaveLength(0);
  });
});

describe("PATCH and DELETE /attachments/:id", () => {
  it("renames a row the caller owns and 404s a stranger", async () => {
    clerk.userId = await seedUser();
    const owner = clerk.userId;
    const createdRow = await envelope<AttachmentBody>(await report(readyReport()));
    const id = createdRow.data?.attachment.id ?? "";

    const renamed = await envelope<AttachmentBody>(await rename(id, { name: "poster-final.png" }));
    expect(renamed.data?.attachment.name).toBe("poster-final.png");

    clerk.userId = await seedUser();
    expect((await rename(id, { name: "mine-now.png" })).status).toBe(404);

    clerk.userId = owner;
  });

  it("deletes a row the caller owns; a second delete is NOT_FOUND", async () => {
    clerk.userId = await seedUser();
    const createdRow = await envelope<AttachmentBody>(await report(readyReport()));
    const id = createdRow.data?.attachment.id ?? "";

    expect((await remove(id)).status).toBe(200);
    expect((await remove(id)).status).toBe(404);
  });
});
