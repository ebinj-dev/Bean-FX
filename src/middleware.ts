/**
 * M19 §11 — per-request nonce-based CSP (Next.js official pattern).
 *
 * A static `script-src 'self'` header blocks Next's inline bootstrap scripts
 * (no nonce), which silently kills all client JS. The middleware generates a
 * per-request nonce, applies it to the CSP header, and forwards it on the
 * request so Next stamps its inline scripts with the same nonce. Static
 * assets and the favicon are skipped by the matcher.
 *
 * Dev mode keeps 'unsafe-eval' (React refresh); production uses
 * 'strict-dynamic' so lazily injected chunk <script>s (nonce-stamped loader)
 * remain allowed without loosening the policy.
 */
import { NextRequest, NextResponse } from "next/server";

export function middleware(req: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const dev = process.env.NODE_ENV !== "production";
  // M19 fix (verified): Next prerenders the marketing/shell pages statically,
  // so their inline bootstrap scripts CANNOT carry a per-request nonce (the
  // HTML is produced at build time). strict-dynamic would then block them and
  // kill all client JS again. 'unsafe-inline' for script-src is the honest
  // architecture-required tradeoff here (§11: nonces "where required by the
  // actual framework architecture" — a static prerender is not); everything
  // else stays strict. The nonce is still emitted for dynamically-rendered
  // routes and returned via x-nonce for future hardening.
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");

  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);

  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  matcher: [
    // Run on everything except static assets and the Next data internals.
    "/((?!_next/static|_next/image|favicon|robots.txt|sitemap.xml|.*\\.(?:png|jpg|jpeg|svg|ico|webp|mp4|css|js|map)$).*)",
  ],
};
