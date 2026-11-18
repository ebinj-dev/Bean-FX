process.env.NODE_ENV = "production";
process.env.DATABASE_URL = "file:/home/z/my-project/db/custom.db";
const { db } = await import("@/lib/db");
const email = process.argv[2] ?? "";
await db.user.update({ where: { email }, data: { role: "admin" } });
console.log("admin set:", email);
await db.$disconnect();
