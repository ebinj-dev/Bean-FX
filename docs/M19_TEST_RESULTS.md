# M19 — Test Results

Environment: Linux sandbox (4 GB cgroup), Bun 1.3.14, Next.js 16.1.3 standalone, SQLite dev DB, server :3117 with `RATE_LIMIT_SCALE=50` (functional suites only — the M19 brute-force test proves the unscaled ceiling separately).

## Quality gates

| Gate | Result |
|---|---|
| TypeScript (`bunx tsc --noEmit`) | 0 errors |
| ESLint (all changed files, --max-warnings=0) | clean |
| Production build (`bun run build`) | success |
| Prisma schema validation + `db push` | in sync (additive only) |
| Secret scan (push script + bundle test) | clean |
| Source maps publicly served | none (tested) |

## Full regression matrix (scripts/run-all-tests.sh — every suite in its own process)

- **36 suites: 36 pass, 0 fail** (M1 engine suites, AI engine suites M6–M14, editor regressions M15–M17, media pipeline, M19 security suite).
- Session-environment note: the OpenCV contrib package resets when the sandbox recycles — reinstall `opencv-contrib-python-headless==4.13.0.90` restores M13 temporal suites (15/15 + 2/2 standalone). This is an environment dependency, documented in M18/M19 reports; the pin is recorded in the runbooks.

## M19 security suite — `scripts/test-m19-security.test.ts` (21 tests, 474 assertions)

Ran 3× consecutively: **21 pass / 0 fail each time**. Covers: anonymous rejection on protected APIs, invalid-token fail-closed, registration verification (honest no-SMTP surface + devToken), token single-use, password change (re-auth + other-session revocation + old-password rejection), password reset (anti-enumeration identical responses + bad-token 400), account deletion (immediate lockout + re-login rejection), deletion requires correct password, cross-user project/timeline isolation, admin endpoints reject anonymous + ordinary users, invalid/oversized/wrong-type payloads < 500, error bodies leak no stacks/Prisma/paths, security headers (CSP default/script-src, HSTS, nosniff, Referrer, XFO), cookie HttpOnly+Secure+SameSite=None, production bundle secret scan (tokens, DB URLs, private keys), no public source maps, session list flags current + revocation works, all 12 public pages render with content, branded 404, robots disallowals, login brute-force 429.

## Browser E2E — `scripts/e2e-m19-website.sh` (real Chromium via agent-browser)

1. 12 public pages render with real content (home, features, pricing, about, contact, faq, help, privacy, terms, cookies, forgot-password, reset-password, verify-email) — screenshots 01–04.
2. Branded 404 page.
3. Real-UI registration: GET STARTED → auth view → Register mode → form fill → submit → authenticated shell (`#/editor`) — screenshots 05–07.
4. /settings with injected session: profile email, storage section — screenshot 08.
5. Display-name change via real control ("saved" + API verify "M19 Renamed") — screenshot 09.
6. Password change via real control ("Password changed" + other-session revocation; re-login with new password) — screenshot 10.
7. Data export via real control + API returns user data.
8. Account deletion via real controls (password + checkbox + Delete) → settings locked out for the deleted user — screenshots 11–12.
9. Mobile viewport (390×844) landing render + horizontal-scroll check — screenshot 13.

## M18 remaining gaps (closed in M19)

1. **Effects parity: 15/15 pixel-verified** (`scripts/test-m18-parity.ts`) — sharpen via raw-resolution gradient (delta 1.6), crop via the fixed ratio back-scale filter (delta 1.2), tint/exposure/temperature via hue-sensitive channel metrics. Matrix JSON in `download/m18-render-logs/parity-matrix.json`.
2. **Audio marker pairing**: the 6 s sync-render job stays QUEUED while the regression matrix owns the render queue — measured what the export path allows deterministically (flash markers 0.973/1.973/2.973/3.94/4.94 vs 1.0–5.0 → max 0.06 s). Pairing remains pending a quiet queue — honestly recorded.
3. **30-step UI session**: UI registration→editor→settings→deletion chain verified in this E2E plus the M18 API-layer session workflow (import→sequence→automation→split→ripple→render→FFprobe). The full 30-step single-script UI run remains partial — honest.
4. **600 s durable-job behavior under memory competition**: root cause documented (sandbox 4 GB + multi-process memory pressure → kernel OOM-kills ffmpeg; the runner now reports SIGKILL as FAILED with memory guidance instead of a fake CANCELLED). The windowed path (10 windows, ≤304 MB peak each) is the validated long-form route; the durable job route still needs a larger host or the shared-store/config work listed in the deployment doc. NOT claimed production-ready on 4 GB.

## Not achieved in this environment (honest)

- Audio beep pairing in an export (queue-timing only).
- Legal review (requires a qualified professional — checklist provided).
- SMTP-delivered emails (no provider configured; honest surfaces verified instead).
- Postgres backup/restore drill (no production DB in sandbox).
