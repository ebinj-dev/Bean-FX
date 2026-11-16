# M19 — Privacy Data Map (source of truth for the Privacy Policy)

Status: **IMPLEMENTED, CONFIGURATION REQUIRED** (SMTP) — audited from actual code, 2026-11-15.

## What the application stores (Postgres/SQLite via Prisma — 47 models)

| Category | Data | Where | Retention |
|---|---|---|---|
| Account | email, display name, scrypt password hash (never plaintext), role, emailVerified, deletedAt, timestamps | `User` | until account deletion |
| Sessions | random session tokens (hashed), expiry, timestamps | `Session` | revoked on password change/deletion/logout |
| Auth tokens | SHA-256 hashes of single-use email-verification & password-reset tokens + expiry | `EmailVerificationToken`, `PasswordResetToken` | short expiry; consumed on use |
| Projects | project metadata, timeline versions (sequence JSON: clips, edits, captions, effects, automation), version history | `Project`, `TimelineVersion` | until account deletion |
| Media | uploaded video/audio/image files, thumbnails, probes; storage paths & sizes | `MediaAsset` + files on disk under media root | until deletion |
| AI jobs & outputs | generation/transcription/analysis job records, provider usage metering (tokens, cost estimates where provider reports), generated asset records | `Job`, `AiOutput`, engine tables | until account deletion |
| Renders/exports | durable render jobs, export files + sizes | `Job`, `ExportFile` | until deletion |
| Audit | privileged-action events (action, userId, ip, detail) — logins, password ops, admin access, deletions | `AuditEvent` | operational log |

## Browser storage

- One cookie: `beanfx_session` (HttpOnly, Secure, SameSite=None) — essential authentication. No analytics, marketing, or third-party cookies. No credentials in localStorage.

## Processing model (honest distinction)

1. **Local deterministic processing** — decoding/probing (FFmpeg/FFprobe), timeline rendering, previews, captions rendering, exports: executed on the BEAN FX server only.
2. **Server-side AI coordination** — MY AI planning/executor runs on the server.
3. **External AI provider processing** — only when the user invokes an AI feature and explicitly approves the payload. Sent data categories (audited from provider modules): text prompts/plans; small subject crops for visual labeling; generated assets for review. Providers are configured via environment (`BEANFX_*_PROVIDER`, `BEANFX_ZAI_BIN`) — the deployment operator's provider terms govern retention on provider side; this application stores only the outputs/metering listed above.
4. **Email delivery** — only if `SMTP_URL` is configured; otherwise flows report `delivered: false` and never pretend to send.

## Logging & diagnostics

- Server-side application logs (no request logging of secrets); audit events as above. No third-party analytics, no tracking pixels, no crash-reporting service configured.

## User rights (implemented endpoints)

- Access/export: `GET /api/account/export-data` (JSON download) + `/settings` → "Export my data".
- Correction: display name via `PATCH /api/account`; email changes → contact support.
- Deletion: `POST /api/account/delete` (password + explicit confirm) → immediate lockout, session revocation, deferred cleanup; shared media referenced by others is preserved. External-provider retention follows provider terms (disclosed in policy).
- Contact: environment-configured support address (`NEXT_PUBLIC_SUPPORT_EMAIL`/`SUPPORT_EMAIL`); honest notice when unset.

## Policy

`/privacy` renders this map in user-readable form, with an effective date and change-process note. **Status: REQUIRES LEGAL REVIEW** before public launch (see `M19_LEGAL_REVIEW_CHECKLIST.md`).
