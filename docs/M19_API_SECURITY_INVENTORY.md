# M19 — API Route Security Inventory

Total route files: **106** (`find src/app/api -name route.ts`). Classification below is by group; every route inherits the same server-side session model: identity derives from the `beanfx_session` HTTP-only cookie via `getSessionUser()` — **never** from client-supplied user IDs.

## Access model

- **Public (anonymous)** — no session required.
- **Auth** — any valid, non-deleted session.
- **Owner** — session user must own the referenced resource (checked in every query `where userId`).
- **Admin** — `requireAdmin()` (role from the DB row) + audited.
- **Worker** — internal worker functions invoked in-process by the durable job system; no HTTP surface.

| Group | Routes | Class | Auth | Rate limit (identity) | Notes |
|---|---|---|---|---|---|
| Auth | `/api/auth/login` | Public | — | `auth:login` per **IP+email** 10/300s + `auth:login-ip` IP×10 backstop | generic 401 (anti-enumeration); deleted accounts rejected; audit rows |
| Auth | `/api/auth/register` | Public | — | `auth:register` per IP 5/3600s | issues verification token; devToken only to the just-created session when SMTP unset |
| Auth | `/api/auth/forgot-password` | Public | — | `auth:forgot` per IP 10/300s | identical response for known/unknown email |
| Auth | `/api/auth/reset-password` | Public | — | `auth:reset` per IP 10/300s | SHA-256-stored single-use token; consumes + revokes all sessions |
| Auth | `/api/auth/verify-email` | Auth (token) | token | `auth` | single-use hashed token |
| Auth | `/api/auth/change-password` | Auth | ✓ | `auth:chpass` per IP 10/300s | re-authenticates with current password; revokes other sessions |
| Auth | `/api/auth/sessions` | Auth | ✓ | `api` per user | list flags current; DELETE revokes (cannot revoke current) |
| Auth | `/api/auth/me`, `/api/auth/logout` | Auth/Public | ✓ | — | me returns null user for anonymous |
| Account | `/api/account` (GET/PATCH), `/storage`, `/export-data`, `/delete` | Auth | ✓ | `api` per user | PATCH = display name only; export returns own data; delete re-authenticates + confirms + locks out |
| Admin | `/api/admin/users`, `/api/admin/jobs`, `/api/admin/health` | **Admin** | ✓ | — | safe fields only; every access audited; ordinary users 403 (tested) |
| Projects | `/api/projects…`, `/api/editor/projects/{id}/timeline` | Owner | ✓ | `api` | ownership enforced in every query; version conflict protection |
| Media | `/api/media`, `/api/media/upload/*`, `/api/media/[id]` | Owner | ✓ | `upload` per user 60/3600s | size/quota/MIME/signature checks; randomized storage ids |
| AI (RIISHE/GANGZII/NIIKI/JAZMII/LAXII/COMPOSE/creative/multimodal/visual/temporal/studio) | `/api/ai/*`, `/api/creative/*`, `/api/gangzii/*`, `/api/jazmii/*`, `/api/nikki/*`, `/api/laxii/*`, `/api/studio/*`, `/api/autocut/*` | Owner | ✓ | `ai` per user 40/3600s | provider calls server-side only; consent + metering preserved |
| Renders/exports | `/api/editor/projects/{id}/render`, `/api/exports/*` | Owner | ✓ | `render` per user 10/3600s | durable jobs; per-user concurrency; cancellation ownership |
| Automation/MCP | `/api/automation/mcp`, `/api/automation/rpc`, `/api/automation/tokens` | Auth | ✓ | `BEANFX_MCP_RATE_PER_MIN` | token-based tool calls, audited |
| Health | `/api/health` (root-level if present) | Health | minimal | — | minimal fields only; internal metrics stay in admin |

## Cross-cutting protections (implemented)

1. Session cookie: HttpOnly, Secure, SameSite=None (partitioned preview support), server-side expiry.
2. Zod schema validation on mutation bodies (400 without internals).
3. Payload size limits; upload caps ≤2 GB per file; per-user quota `USER_STORAGE_QUOTA_BYTES`.
4. Ownership on every read/mutation; cross-user isolation tested (project/media/export/admin/worker).
5. Rate limiting per operation class (see `RATE_LIMITS`), documented scale for tests (`RATE_LIMIT_SCALE`, prod = 1).
6. Safe errors: no stack traces, no Prisma/SQL text, no fs paths in any 4xx/5xx body (tested).
7. Audit trail (`AuditEvent`) for privileged actions: logins, password ops, admin access, deletions.
8. CORS: same-origin by default (Next.js server routes); no wildcard CORS-with-credentials is configured anywhere (`grep` audited).

## Verified by `scripts/test-m19-security.test.ts` (21 tests)

anonymous 401s · invalid token fail-closed · enumeration-safe flows · token single-use · cross-user isolation · admin rejection · invalid/oversized payloads <500 · error-leak scan · headers/CSP/HSTS/XFO · cookie attributes · bundle secret scan · source-map absence · session list/revoke · public pages · robots · 404 · login rate limit.
