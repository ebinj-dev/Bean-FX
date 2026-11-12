import { db } from "../src/lib/db";
import { randomBytes } from "crypto";

(async () => {
  const user = await db.user.findUnique({ where: { email: "gateway-audit@beanfx.test" }, select: { id: true } });
  if (!user) throw new Error("user not found");
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);
  await db.session.create({ data: { token, userId: user.id, expiresAt } });
  console.log(`SESSION_TOKEN=${token}`);
  process.exit(0);
})();
