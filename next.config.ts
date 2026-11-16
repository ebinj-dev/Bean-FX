import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* Type errors fail the build — the app code is type-clean and must stay so. */
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
  /**
   * M19 §11 — security headers. CSP policy for the real app: self-hosted
   * bundles (Next), blob: workers/URLs for the media pipeline, data:/blob:
   * media elements (decoded audio/thumbnails), inline styles (Next's
   * style system) — scripts stay nonce-managed by Next; no script-src
   * unsafe-inline is added. HSTS assumes production TLS termination.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          // M19 fix: CSP is set per-request with a nonce in src/middleware.ts —
          // a static script-src without a nonce blocks Next's inline bootstrap
          // scripts and silently kills all client JS (verified regression).
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default nextConfig;
