import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { audit } from "@/lib/audit";
import { sendMail, hashToken, mailConfigured } from "@/lib/mailer";
import { clientIp, enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

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
    // M19 §13: registration throttle per IP.
    const limited = enforceRateLimit(req as unknown as Request, "auth:register", clientIp(req as unknown as Request), RATE_LIMITS.register);
    if (limited) return limited as unknown as NextResponse;
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

    // M19 §3: email verification — single-use hashed token, 24h TTL. When no
    // mail provider is configured the response surfaces an honest notice (and
    // never fakes a delivery). The raw token is ONLY exposed to the JUST
    // CREATED session in the no-SMTP dev case; in production it travels by mail.
    const verifyRaw = randomBytes(32).toString("hex");
    await db.emailVerificationToken.create({
      data: { userId: user.id, tokenHash: hashToken(verifyRaw), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
    });
    let verification: { delivered: boolean; notice?: string; devToken?: string } = { delivered: false };
    if (mailConfigured()) {
      const origin = process.env.PUBLIC_APP_URL ?? new URL(req.url).origin;
      const mail = await sendMail({
        to: user.email,
        subject: "Verify your BEAN FX email address",
        body: `Welcome to BEAN FX. Confirm this email address within 24 hours:\n${origin}/verify-email?token=${verifyRaw}`,
      });
      verification = { delivered: mail.delivered, ...(mail.delivered ? {} : { notice: "Email delivery failed — the verification link could not be sent." }) };
    } else {
      verification = { delivered: false, notice: "Email delivery is not configured on this deployment — email addresses cannot be verified until an SMTP provider is set up.", devToken: verifyRaw };
    }
    await audit("auth.registered", { userId: user.id, ip: clientIp(req as unknown as Request), detail: `mailConfigured=${mailConfigured()}` });

    const { token, expiresAt } = await createSession(user.id);
    const res = NextResponse.json({
      user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt.toISOString(), emailVerified: false },
      verification,
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
