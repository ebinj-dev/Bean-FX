import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyPassword, createSession, sessionCookieHeaders } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { clientIp, enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const { email, password } = (body ?? {}) as { email?: string; password?: string };
    // M19 §13: brute-force throttle. Primary key is (IP, email): hammering ONE
    // account trips its own bucket without locking every other user behind the
    // same NAT/proxy IP (also keeps shared-IP test environments stable). A
    // wider per-IP bucket (10× the per-account ceiling) backstops distributed
    // attacks across many accounts from one host.
    const ip = clientIp(req as unknown as Request);
    const accountLimited = enforceRateLimit(
      req as unknown as Request, "auth:login",
      `${ip}:${(email ?? "").trim().toLowerCase() || "-"}`, RATE_LIMITS.auth,
    );
    if (accountLimited) return accountLimited as unknown as NextResponse;
    const ipLimited = enforceRateLimit(
      req as unknown as Request, "auth:login-ip", ip,
      { limit: RATE_LIMITS.auth.limit * 10, windowSec: RATE_LIMITS.auth.windowSec },
    );
    if (ipLimited) return ipLimited as unknown as NextResponse;
    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
    }

    const user = await db.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    // Generic message: do not reveal whether the account exists.
    const genericError = NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
    if (!user) {
      await audit("auth.login_failed", { ip: clientIp(req as unknown as Request), detail: "unknown-email" });
      return genericError;
    }
    // M19 §10: deleted accounts never authenticate again.
    if (user.deletedAt) return genericError;

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      await audit("auth.login_failed", { userId: user.id, ip: clientIp(req as unknown as Request) });
      return genericError;
    }
    await audit("auth.login", { userId: user.id, ip: clientIp(req as unknown as Request) });

    const { token, expiresAt } = await createSession(user.id);
    const res = NextResponse.json({
      user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt.toISOString() },
    });
    // Raw headers: one fresh partitioned cookie + one legacy-cookie expiry.
    for (const cookie of sessionCookieHeaders(token, expiresAt)) {
      res.headers.append("set-cookie", cookie);
    }
    return res;
  } catch (err) {
    console.error("[login]", err);
    return NextResponse.json({ error: "Login failed. Please try again." }, { status: 500 });
  }
}
