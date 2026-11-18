process.env.NODE_ENV = "production";
const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();
const users = await db.user.count();
const projects = await db.project.count();
const anyDb = db as unknown as { subscription?: { count(): Promise<number> } };
const subs = anyDb.subscription ? await anyDb.subscription.count() : "missing";
console.log("users:", users, "projects:", projects, "subscriptions:", subs);
await db.$disconnect();
