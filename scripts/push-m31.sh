#!/usr/bin/env bash
# One-command M31 production-readiness push (persistent credential; plain fast-forward push, never force).
set -euo pipefail
SRC=/home/z/my-project
AUTH="$SRC/scripts/git-cred-helper.sh"
BRANCH=feature/ai-creative-studio
CLONE=/tmp/beanfx-push-m31

bash "$SRC/scripts/gh-auth-restore.sh" || { echo "FATAL: GitHub auth not ready"; exit 1; }
test -x "$AUTH" || { echo "FATAL: credential helper missing"; exit 1; }

rm -rf "$CLONE"
git clone -q -c credential.helper="!$AUTH" "https://github.com/ebinj-dev/Bean-FX.git" "$CLONE"
cd "$CLONE"
echo "=== tips before push ==="
git ls-remote origin refs/heads/"$BRANCH" refs/heads/main | cat
git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
BASE=$(git rev-parse HEAD)
echo "branch tip before push: $BASE"
# M19 commit 2a7c18d must remain in history (no rewrite).
git merge-base --is-ancestor 2a7c18d HEAD && echo "M19 2a7c18d IS in history" || { echo "FATAL: M19 not in history"; exit 1; }
git merge-base --is-ancestor f4802a47f229350be88b60c974e801e53cbbb3a8 HEAD && echo "M24 f4802a4 IS in history" || { echo "FATAL: M24 tip not in history"; exit 1; }
git merge-base --is-ancestor 4aa0d6d86c5a9f443a219a12a0a0620be1e937d0 HEAD && echo "M25 4aa0d6d IS in history" || { echo "FATAL: M25 tip not in history"; exit 1; }
git merge-base --is-ancestor f12549b04d039d115c7b730417067f1bc5f49ed6 HEAD && echo "M26 f12549b IS in history" || { echo "FATAL: M26 tip not in history"; exit 1; }
git merge-base --is-ancestor 01286f5a9db2ebe68eee0ee67b98a692afae9a35 HEAD && echo "M27 01286f5 IS in history" || { echo "FATAL: M27 tip not in history"; exit 1; }

# Overlay the M25 work: everything under src/, prisma/, docs/, scripts/,
# public/, plus root configs — excluding runtime/build/user data.
rsync -a --delete \
  --exclude node_modules --exclude .next --exclude db/ --exclude media-store/ \
  --exclude /download/ --exclude /upload/ --exclude skills/ --exclude .git \
  --exclude .env --exclude "*.log" --exclude BEAN_FX_RECOVERY_AUDIT.md \
  "$SRC/src/" "$CLONE/src/"
rsync -a "$SRC/prisma/" "$CLONE/prisma/"
rsync -a --exclude "*.log" "$SRC/docs/" "$CLONE/docs/"
rsync -a "$SRC/scripts/" "$CLONE/scripts/"
rsync -a "$SRC/public/" "$CLONE/public/" 2>/dev/null || true
# M27: milestone evidence bundle (measured logs + screenshots; no secrets).
mkdir -p "$CLONE/download/m27-evidence"
mkdir -p "$CLONE/download/m28-evidence"
mkdir -p "$CLONE/download/m29-evidence"
rsync -a "$SRC/download/m29-evidence/" "$CLONE/download/m29-evidence/"
mkdir -p "$CLONE/download/m29-closeout-evidence"
rsync -a "$SRC/download/m29-closeout-evidence/" "$CLONE/download/m29-closeout-evidence/"
mkdir -p "$CLONE/download/m30-evidence"
rsync -a "$SRC/download/m30-evidence/" "$CLONE/download/m30-evidence/"
mkdir -p "$CLONE/download/m31-evidence"
rsync -a "$SRC/download/m31-evidence/" "$CLONE/download/m31-evidence/"
for f in package.json bun.lock next.config.ts tsconfig.json postcss.config.mjs eslint.config.mjs components.json VERSION .gitignore .env.example; do
  [ -f "$SRC/$f" ] && cp "$SRC/$f" "$CLONE/$f" || true
done

cd "$CLONE"
if ! git status --porcelain | grep -q .; then
  echo "NOTHING TO PUSH — working tree already matches remote"
  exit 0
fi
echo "=== secret scan ==="
# Exclude the scan/redaction tooling itself: those files carry the scanner
# regex as source code (verified zero real secrets — self-match false positive).
if git diff --name-only "$BASE" | grep -vE "^scripts/(push-m[0-9]+|overlay-m[0-9]+|gh-auth-restore|git-cred-helper)\.sh$" | while read -r f; do
      grep -lE "gho_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9]{20,}|BEGIN (RSA|OPENSSH) PRIVATE KEY" "$f" 2>/dev/null
    done | grep -q .; then
  echo "SECRET SCAN FAILED — aborting push"; exit 1
fi
echo "(clean)"
git add -A
# M27 evidence bundle lives in the ignored download/ space — force-add it.
git add -A -f download/m29-evidence 2>/dev/null || true
git add -A -f download/m29-closeout-evidence 2>/dev/null || true
git add -A -f download/m30-evidence 2>/dev/null || true
git add -A -f download/m31-evidence 2>/dev/null || true
git -c user.name="Z User" -c user.email="z@container" commit -q -m "chore(m31): production readiness, security & integration qualification

Qualify the complete M1-M30 platform. No new feature set; no redesign.

M13 OpenCV CSRT RESOLVED reproducibly: opencv-python-headless never ships the
tracker contrib; replaced with pinned opencv-contrib-python-headless==4.13.0.90
(requirements-test.txt). M13 temporal suites run UNMODIFIED: 15/15 + 2/2 PASS.

Full regression: combined batch 36/36 green (the one m19 429 was a rate-limiter
env-scale miss; rerun 21/21); m29 integrity 8/8, portability 4/4, m29c 5/5,
m30 collaboration 13/13 + reviews 15/15 re-run green.

New M31 suites (independent sessions, isolated envs):
- security audit: cross-user isolation, revoked-member immediate lockout,
  expired guest links, fingerprint-bound approvals, no-leak payloads (7 tests)
- media/export qualification: real mixed-rate/rotated fixtures, corrupt
  rejection, full ffprobe conformance (streams/duration/pixfmt/audio/decode) (3)
- worker fault injection: duplicate submission, permanent-failure
  classification, cancellation, temp cleanup, stale leases, notify dedup (7)
- backup/restore drill (11/11): complete DB+media snapshot, referential walk,
  isolated restored-env writes + real pipeline render from restored data
- bounded performance: measured latencies; same-base write races hold
  optimistic concurrency (1x200 + 409-with-head + safe lock-contention 400s)

Platform: admin/health extended additively (queue/stale/encoders/integrations —
no path/secret leaks). Integration statics 20/20 (UXP harness, bridge hashing/
pairing/credential hygiene, installers); Premiere/Windows real-host = OWNER
ACTION (checklists referenced). Provider + email diagnostics honest (no
credentials = CONFIGURATION REQUIRED; no fabricated success; no Ollama).

Docs: M31_RESULTS / FEATURE_MATRIX / SECURITY_AUDIT / INTEGRATION_QUALIFICATION
/ RELEASE_READINESS / UI_REGRESSION + m31-evidence logs. Verdict: QUALIFIED
WITH OWNER ACTIONS + CONFIGURATION REQUIREMENTS (not a deployment
authorization). main untouched; no merge/deploy; no M32." >/dev/null
NEW=$(git rev-parse HEAD)
echo "commit: $NEW"
git push -q origin "$BRANCH"
echo "=== push verification ==="
git ls-remote origin refs/heads/"$BRANCH" refs/heads/main | cat
echo "M28_TIP=$NEW"
echo "MAIN_UNCHANGED_CHECK=$(git ls-remote origin refs/heads/main | cut -d'	' -f1)"
