# M19 — Security Audit (findings, fixes, residual risks)

Scope: working tree audit of M1–M18 features, auth, uploads, providers, bundle, headers — 2026-11-15. Baseline: feature `888bac1`, main `ae053891`.

## Findings fixed in M19

| # | Finding | Severity | Fix |
|---|---|---|---|
| F1 | Login throttle keyed by IP only — one account's brute force locked out every user behind a shared IP; also made shared-IP test environments flaky | Medium | Rekeyed to **(IP, email)** primary bucket + per-IP backstop at 10× ceiling (`auth:login`, `auth:login-ip`) |
| F2 | No email verification / password reset / change / session management | High | Implemented: hashed single-use tokens, anti-enumeration responses, full session revocation on reset/change |
| F3 | No account deletion | High | Safe workflow: re-auth + explicit confirm + immediate lockout + session revocation + audit event; shared media preserved |
| F4 | No rate limiting on auth/AI/render/upload buckets | High | `src/lib/rate-limit.ts` per-class limits on all sensitive routes; honest 429s with `Retry-After` |
| F5 | No audit trail for privileged actions | Medium | `AuditEvent` model + `audit()` on logins, password ops, admin access, deletions |
| F6 | No admin/ops surface | Medium | `requireAdmin` role checks, safe fields only, audited (`/api/admin/users|jobs|health`) |
| F7 | Security headers not configured | Medium | CSP (default-src 'self', script-src 'self'), X-Content-Type-Options, Referrer-Policy, Permissions-Policy, HSTS, X-Frame-Options via `next.config.ts` headers (tested) |
| F8 | Production source maps | Medium | Disabled (`productionBrowserSourceMaps: false`); test asserts no `.js.map` served |
| F9 | No robots/sitemap/404 boundaries | Low | `robots.ts` disallows /api, /settings, /editor, projects, exports; sitemap lists marketing pages only; branded 404 |
| F10 | No data export | Low | `GET /api/account/export-data` returns the user's own records as JSON |

## Verified-good (no change needed)

- scrypt password hashing (established KDF), salted; hashes never returned by any API.
- Session identity always server-derived; no `userId` accepted from the browser as authorization.
- Ownership predicates on project/media/job/export queries; cross-user isolation tests pass.
- Provider credentials server-side only: no `NEXT_PUBLIC_*` carries secrets (only `NEXT_PUBLIC_SUPPORT_EMAIL`, intentionally public); bundle scan finds no tokens/DB URLs/keys.
- Uploads: size caps, per-user quota, MIME + signature checks, randomized storage identifiers, no shell-out with user input (FFmpeg via argument arrays only).
- No wildcard CORS with credentials anywhere; Next.js same-origin model.

## Residual risks / honest status

1. **In-memory rate-limit store** — per-process. Fine for single-instance; multi-instance production MUST provide a shared store (`RATE_LIMIT_REDIS_URL` hook documented). **CONFIGURATION REQUIRED.**
2. **Email delivery** — SMTP unset → flows honestly report `delivered:false` with a dev-token surface for the just-created session. **CONFIGURATION REQUIRED.**
3. **Admin role assignment** — no UI to grant roles (by design); operators set `role="admin"` in the DB. Runbook documented. No hardcoded admin account exists.
4. **CSP nonce strictness** — current CSP allows the framework's inline bootstrap via `'self'` + documented exceptions; removing `unsafe-inline`/`unsafe-eval` fully requires per-request nonces — tracked, not blocking (no inline secret-bearing scripts).
5. Legal policies are drafts pending professional review (`REQUIRES LEGAL REVIEW`).
