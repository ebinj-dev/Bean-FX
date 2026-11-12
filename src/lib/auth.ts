import { randomBytes, scrypt as _scrypt, timingSafeEqual, createHash } from "crypto";
import { promisify } from "util";
import { cookies, headers } from "next/headers";
import { db } from "@/lib/db";

const scrypt = promisify(_scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number
) => Promise<Buffer>;

export const SESSION_COOKIE = "beanfx_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

/**
 * The app is served inside the platform's cross-site preview frame, so
 * SameSite=Lax cookies are not attached to XHR/fetch requests at all and the
 * session silently dies between sign-in and upload. None+Secure keeps the
 * cookie flowing; Partitioned (CHIPS) keeps it working where third-party
 * cookies are blocked, scoped to the (top-site, preview-site) pair. CSRF
 * surface is unchanged: every mutating endpoint requires a preflighted JSON
 * body or custom headers and no CORS headers are ever emitted.
 */
const SESSION_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "none",
  secure: true,
  partitioned: true,
  path: "/",
} as const;

/** Short fingerprint for diagnostics — never log the raw token. */
function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

/**
 * Extract EVERY value sent for the session cookie from the raw Cookie header.
 * Next's cookie jar keeps only the last occurrence of a duplicate name, which
 * would hide the fresh partitioned token behind a stale unpartitioned one
 * (or vice versa) depending on the browser's header ordering.
 */
function tokensFromCookieHeader(raw: string | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    if (value) out.push(value);
  }
  return [...new Set(out)];
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, hex] = parts;
  const derived = await scrypt(password, salt, 64);
  const expected = Buffer.from(hex, "hex");
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(derived, expected);
}

export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validatePassword(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (password.length > 128) return "Password must be at most 128 characters.";
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password))
    return "Password must contain at least one letter and one number.";
  return null;
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.session.create({ data: { token, userId, expiresAt } });
  return { token, expiresAt };
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, { ...SESSION_COOKIE_OPTS, expires: expiresAt });
}

const EXPIRED = "Thu, 01 Jan 1970 00:00:00 GMT";

/**
 * Raw Set-Cookie header for a fresh sign-in. Partitioned (CHIPS) keeps the
 * session working inside the platform's cross-site preview frame even where
 * third-party cookies are blocked; browsers without CHIPS ignore the
 * attribute and treat it as None+Secure. A legacy unpartitioned cookie that
 * may still sit in the browser's default jar is NOT expired with a second
 * same-name header: in non-CHIPS browsers that would delete the fresh cookie
 * (single jar, same key). Instead getCurrentUser tolerates the stale sibling
 * by trying every sent value.
 */
export function sessionCookieHeaders(token: string, expiresAt: Date): string[] {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return [
    `${SESSION_COOKIE}=${token}; Path=/; Expires=${expiresAt.toUTCString()}; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=None; Partitioned`,
  ];
}

/** Raw Set-Cookie headers that clear every jar the session cookie may live in. */
export function clearSessionCookieHeaders(): string[] {
  return [
    `${SESSION_COOKIE}=; Path=/; Expires=${EXPIRED}; Secure; HttpOnly; SameSite=None; Partitioned`,
    `${SESSION_COOKIE}=; Path=/; Expires=${EXPIRED}; Secure; HttpOnly; SameSite=Lax`,
  ];
}

export async function clearSession() {
  const reqHeaders = await headers();
  const tokens = tokensFromCookieHeader(reqHeaders.get("cookie"));
  for (const token of tokens) {
    await db.session.deleteMany({ where: { token } }).catch(() => undefined);
  }
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", { ...SESSION_COOKIE_OPTS, expires: new Date(0) });
}

export interface SafeUser {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
}

export async function getCurrentUser(): Promise<SafeUser | null> {
  try {
    // Read the raw Cookie header — see tokensFromCookieHeader for why the
    // parsed jar cannot be used here.
    const reqHeaders = await headers();
    const tokens = tokensFromCookieHeader(reqHeaders.get("cookie"));
    if (tokens.length === 0) return null;

    const unmatched: string[] = [];
    for (const token of tokens) {
      const session = await db.session.findUnique({
        where: { token },
        include: { user: true },
      });
      if (!session) {
        // Fail closed, but never silently: a token that matches no row means
        // the browser holds a cookie this server never issued (stale jar,
        // wiped DB) — distinct from "no cookie" and from a real expiry.
        unmatched.push(tokenFingerprint(token));
        continue;
      }
      if (session.expiresAt.getTime() < Date.now()) {
        await db.session.delete({ where: { id: session.id } }).catch(() => undefined);
        unmatched.push(tokenFingerprint(token));
        continue;
      }

      // Sliding renewal: once more than half the TTL is consumed, extend the
      // session and re-issue the cookie so active users are never logged out
      // mid-work. Token is unchanged; only the expiry moves.
      const remaining = session.expiresAt.getTime() - Date.now();
      if (remaining < SESSION_TTL_MS / 2) {
        const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
        await db.session
          .update({ where: { id: session.id }, data: { expiresAt } })
          .catch(() => undefined);
        try {
          const jarWrite = await cookies();
          jarWrite.set(SESSION_COOKIE, token, { ...SESSION_COOKIE_OPTS, expires: expiresAt });
        } catch {
          // Cookie writes are only allowed in route handlers; the DB expiry
          // already moved, so the session stays valid regardless.
        }
      }

      return {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        createdAt: session.user.createdAt.toISOString(),
      };
    }
    // Only log when the whole lookup failed — a stale sibling cookie that is
    // shadowed by a valid one must not spam the log on every request.
    console.error(`[auth] no valid session for sent token(s): ${unmatched.join(", ")}`);
    return null;
  } catch (err) {
    // Fail closed, but never silently: a swallowed DB error here is
    // indistinguishable from an expired session and masks real incidents.
    console.error("[auth] session lookup failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function requireUser(): Promise<SafeUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new AuthError("Authentication required.");
  }
  return user;
}

export class AuthError extends Error {}
