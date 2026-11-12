import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyPassword, createSession, sessionCookieHeaders } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const { email, password } = (body ?? {}) as { email?: string; password?: string };
    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
    }

    const user = await db.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    // Generic message: do not reveal whether the account exists.
    const genericError = NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
    if (!user) return genericError;

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) return genericError;

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
