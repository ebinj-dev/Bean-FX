import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  hashPassword,
  validateEmail,
  validatePassword,
  createSession,
  sessionCookieHeaders,
} from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
    }
    const { email, password, name } = body as { email?: string; password?: string; name?: string };

    if (!email || !validateEmail(email.trim())) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }
    if (!password) {
      return NextResponse.json({ error: "Password is required." }, { status: 400 });
    }
    const pwError = validatePassword(password);
    if (pwError) {
      return NextResponse.json({ error: pwError }, { status: 400 });
    }

    const normalized = email.trim().toLowerCase();
    const existing = await db.user.findUnique({ where: { email: normalized } });
    if (existing) {
      return NextResponse.json(
        { error: "An account with this email already exists. Try logging in." },
        { status: 409 }
      );
    }

    const passwordHash = await hashPassword(password);
    const user = await db.user.create({
      data: { email: normalized, passwordHash, name: typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : null },
    });

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
    console.error("[register]", err);
    return NextResponse.json({ error: "Registration failed. Please try again." }, { status: 500 });
  }
}
