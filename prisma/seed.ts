import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";

const DEMO_USER_ID = "user_demo_seed";
const GRANT = 30_000_000n;

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

async function main(): Promise<void> {
  const user = await db.user.upsert({
    where: { id: DEMO_USER_ID },
    update: {},
    create: {
      id: DEMO_USER_ID,
      email: "demo@magica.local",
      name: "Demo User",
      creditBalance: GRANT,
    },
  });

  await db.creditLedgerEntry.upsert({
    where: { idempotencyKey: `signup_grant:${user.id}` },
    update: {},
    create: {
      userId: user.id,
      type: "signup_grant",
      amount: GRANT,
      idempotencyKey: `signup_grant:${user.id}`,
    },
  });

  for (const title of ["Casual Greeting", "Premium Scandinavian Stamp Sheet"]) {
    const existing = await db.chat.findFirst({ where: { userId: user.id, title } });
    if (!existing) await db.chat.create({ data: { userId: user.id, title } });
  }

  const balance = await db.creditLedgerEntry.aggregate({
    where: { userId: user.id },
    _sum: { amount: true },
  });

  console.log(
    `seeded ${user.email} · balance ${user.creditBalance} · ledger sum ${balance._sum.amount}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
