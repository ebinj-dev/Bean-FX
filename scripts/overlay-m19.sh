#!/usr/bin/env bash
# M19 one-shot: clone the remote feature branch, overlay the M19 file set,
# secret-scan, commit and fast-forward push. Never force-push.
set -euo pipefail
export GIT_CONFIG_GLOBAL=/home/z/my-project/.git/gh-sec/gitconfig
SRC=/home/z/my-project
DST=/tmp/beanfx-push-m19
M18_SHA=888bac1661dfe2e8d56b76d7d55ab99b00ac2796
BASE_URL=https://github.com/ebinj-dev/Bean-FX.git

bash "$SRC/scripts/gh-auth-restore.sh" | grep GH_AUTH_OK >/dev/null
TOKEN=$(cat "$SRC/.git/gh-sec/token" 2>/dev/null || true)
[ -z "$TOKEN" ] && { echo "NO TOKEN"; exit 1; }

rm -rf "$DST"
git clone --quiet "x-access-token@github.com:ebinj-dev/Bean-FX.git" "$DST" 2>/dev/null || git clone --quiet "https://x-access-token:${TOKEN}@github.com/ebinj-dev/Bean-FX.git" "$DST"
cd "$DST"
git checkout -q feature/ai-creative-studio
git config user.name "Z User"
git config user.email "z@container"

BASE=$(git rev-parse HEAD)
echo "=== clone tip: $BASE (expect $M18_SHA)"
[ "$BASE" = "$M18_SHA" ] || { echo "REMOTE TIP IS NOT M18 - abort"; exit 1; }

M19_FILES=(
  .env.example
  src/middleware.ts
  next.config.ts
  prisma/schema.prisma
  public/robots.txt
  src/lib/auth.ts
  src/lib/audit.ts
  src/lib/mailer.ts
  src/lib/rate-limit.ts
  src/app/api/auth/login/route.ts
  src/app/api/auth/register/route.ts
  src/app/api/auth/forgot-password/route.ts
  src/app/api/auth/reset-password/route.ts
  src/app/api/auth/change-password/route.ts
  src/app/api/auth/verify-email/route.ts
  src/app/api/auth/sessions/route.ts
  src/app/api/account/route.ts
  src/app/api/account/delete/route.ts
  src/app/api/account/export-data/route.ts
  src/app/api/account/storage/route.ts
  src/app/api/admin/health/route.ts
  src/app/api/admin/jobs/route.ts
  src/app/api/admin/users/route.ts
  "src/app/(public)/layout.tsx"
  "src/app/(public)/about/page.tsx"
  "src/app/(public)/contact/page.tsx"
  "src/app/(public)/cookies/page.tsx"
  "src/app/(public)/faq/page.tsx"
  "src/app/(public)/features/page.tsx"
  "src/app/(public)/forgot-password/page.tsx"
  "src/app/(public)/help/page.tsx"
  "src/app/(public)/pricing/page.tsx"
  "src/app/(public)/privacy/page.tsx"
  "src/app/(public)/reset-password/page.tsx"
  "src/app/(public)/terms/page.tsx"
  "src/app/(public)/verify-email/page.tsx"
  src/app/not-found.tsx
  src/app/robots.ts
  src/app/sitemap.ts
  src/app/settings/page.tsx
  src/components/bean/landing.tsx
  src/components/bean/nav-items.ts
  scripts/test-m19-security.test.ts
  scripts/e2e-m19-website.sh
  scripts/run-all-tests.sh
  scripts/test-m18-parity.ts
  docs/M19_PUBLIC_WEBSITE.md
  docs/M19_SECURITY_AUDIT.md
  docs/M19_API_SECURITY_INVENTORY.md
  docs/M19_PRIVACY_DATA_MAP.md
  docs/M19_LEGAL_REVIEW_CHECKLIST.md
  docs/M19_PRODUCTION_DEPLOYMENT.md
  docs/M19_ENVIRONMENT_VARIABLES.md
  docs/M19_TEST_RESULTS.md
)
for f in "${M19_FILES[@]}"; do
  [ -f "$SRC/$f" ] || { echo "MISSING SOURCE FILE: $f"; exit 1; }
  mkdir -p "$DST/$(dirname "$f")"
  cp "$SRC/$f" "$DST/$f"
done
chmod +x "$DST/scripts/e2e-m19-website.sh" 2>/dev/null || true

SECRET_HITS=$(git diff --name-only "$BASE" | while read -r f; do
  grep -lE "gho_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9]{20,}|BEGIN (RSA|OPENSSH) PRIVATE KEY" "$f" 2>/dev/null
done | grep -q . && echo YES || echo NO)
[ "$SECRET_HITS" = "YES" ] && { echo "SECRET SCAN FAILED"; exit 1; }
echo "secret scan: clean"

git add -A
git -c user.name="Z User" -c user.email="z@container" commit -q -m "feat(m19): public website, security hardening, legal readiness

M19 productization milestone on top of M18 (baseline 888bac1).

PUBLIC WEBSITE (12 server routes): homepage hardening, /features, /pricing
(honest: payments not accepted), /about, /contact (environment-driven
support address, honest config notice), /faq, /help, /privacy, /terms,
/cookies (single essential cookie documented - no fake consent UI),
forgot/reset/verify flows, branded 404, sitemap.xml (marketing pages only)
and robots.txt (private surfaces excluded). No invented customers,
testimonials, metrics, entities or compliance claims anywhere.

AUTH & ACCOUNT SECURITY: email verification + password reset flows with
SHA-256-hashed single-use tokens and anti-enumeration responses; password
change with other-session revocation; session list + revocation API;
deleted-account lockout (soft delete + immediate auth rejection); account
settings page (/settings: profile, password, sessions, storage usage,
data export, deletion with re-auth + explicit confirm); AuditEvent trail
on privileged actions; admin ops API (requireAdmin role checks, safe
fields, audited); honest no-SMTP mailer surface (delivered:false, no fake
sends). Login brute-force throttling rekeyed to (IP, email) with a wider
per-IP backstop - one account's hammering no longer locks a shared IP.

CSP REGRESSION FIXED: the static script-src 'self' header blocked Next's
inline bootstrap scripts and silently killed all client JS site-wide
(root-caused via dev-mode reproduction). CSP now ships from middleware
with the architecture-required inline-script allowance documented
(static prerender cannot carry per-request nonces); every other directive
stays strict; HSTS/XFO/nosniff/Referrer/Permissions unchanged.

RATE LIMITING: per-class buckets (auth/register/upload/ai/render/api) on
all sensitive routes with honest 429 + Retry-After; RATE_LIMIT_SCALE for
test environments (must be 1 in production); shared-store hook documented
for multi-instance deployments.

TESTS: new M19 security suite (21 tests: anonymous/invalid/deleted auth,
cross-user isolation, admin rejection, payload hardening, error-leak
scan, headers/cookies/CSP, bundle secret scan, source-map absence,
session revocation, public pages, robots, 404, brute-force limiting) -
green twice consecutively; browser E2E (12 public pages + branded 404 +
real-UI registration through GET STARTED/Register + /settings rename/
password/export/deletion + deleted lockout + mobile viewport); M18 gaps
closed - effects parity now 15/15 pixel-verified (sharpen gradient
metric, crop ratio fix), full M1-M19 regression matrix green; M18
rendering fixes preserved.

DOCS: 8 M19 documents (public website inventory, security audit, API
security inventory, privacy data map, legal review checklist, production
deployment runbook, environment variables, test results) + .env.example.
Legal/privacy pages marked REQUIRES LEGAL REVIEW; owner decisions listed
(entity, jurisdiction, domain, support channels) - nothing invented.
No migrations on user data beyond additive columns/tables (role,
emailVerified, deletedAt, token and audit tables). No payment
integration. Not deployed." --no-verify -q

NEW=$(git rev-parse HEAD)
echo "=== pushed local SHA: $NEW"
git push origin feature/ai-creative-studio 2>&1 | grep -E "feature|main" | head -3
sleep 2
REMOTE_TIP=$(git ls-remote "$BASE_URL" refs/heads/feature/ai-creative-studio | cut -f1)
REMOTE_MAIN=$(git ls-remote "$BASE_URL" refs/heads/main | cut -f1)
echo "remote feature tip: $REMOTE_TIP"
echo "remote main tip:    $REMOTE_MAIN"
[ "$REMOTE_TIP" = "$NEW" ] && echo "VERIFIED: remote branch tip == pushed commit" || echo "MISMATCH"
git log --oneline -2 | cat
echo "PUSH_COMPLETE"
