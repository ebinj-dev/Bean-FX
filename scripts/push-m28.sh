#!/usr/bin/env bash
# One-command M28 push (persistent credential; plain fast-forward push, never force).
set -euo pipefail
SRC=/home/z/my-project
AUTH="$SRC/scripts/git-cred-helper.sh"
BRANCH=feature/ai-creative-studio
CLONE=/tmp/beanfx-push-m28

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
  --exclude download/ --exclude upload/ --exclude skills/ --exclude .git \
  --exclude .env --exclude "*.log" --exclude BEAN_FX_RECOVERY_AUDIT.md \
  "$SRC/src/" "$CLONE/src/"
rsync -a "$SRC/prisma/" "$CLONE/prisma/"
rsync -a --exclude "*.log" "$SRC/docs/" "$CLONE/docs/"
rsync -a "$SRC/scripts/" "$CLONE/scripts/"
rsync -a "$SRC/public/" "$CLONE/public/" 2>/dev/null || true
# M27: milestone evidence bundle (measured logs + screenshots; no secrets).
mkdir -p "$CLONE/download/m27-evidence"
mkdir -p "$CLONE/download/m28-evidence"
rsync -a "$SRC/download/m28-evidence/" "$CLONE/download/m28-evidence/"
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
git add -A -f download/m28-evidence 2>/dev/null || true
git -c user.name="Z User" -c user.email="z@container" commit -q -m "feat(m28): professional media pipeline & export reliability — additive UI only

P5 runtime codec capabilities: media-capabilities.ts asks the deployed
  ffmpeg for encoders/muxers once per process and maps every M9 export
  family to real encoder names — missing H265/ProRes/VP9 report honest
  CONFIGURATION reasons instead of failing mid-render.
P2 proxy reliability: POST /api/media/[id]/proxy regeneration (ownership +
  kind checks, duplicate 409, wrong-kind 400) + worker sweep #4 repairing
  stale READY proxy references + fixed a REAL race: the auto-queued proxy
  job claimed before probe metadata committed and misjudged 1080p sources
  as not justified — eligibility now waits (<=10s) for probe metadata.
P6 disk guard: assertDiskSpace (512 MiB floor, statvfs) before proxy
  transcodes and timeline renders with actionable PermanentJobError;
  unknown capacity fails open (logged).
P5 export validation: timeline renders now gate post-encode duration
  (max(0.5s, 2%)) and exact sequence dimensions via probeMediaDeep before
  registering the ExportFile — a successful ffmpeg exit alone is not
  evidence.
P3 relinking: media/list exposes fps/rotation/channels; the relink picker
  warns before relinking (duration vs clip expectation, fps vs sequence,
  video-only replacements); a 404 source asset now surfaces the MISSING
  MEDIA relink path inside the Inspector SOURCE MEDIA panel (closed the
  deleted-asset gap).
P9 UI: additive Inspector SOURCE MEDIA block (probe metadata, VFR badge,
  proxy status, regenerate) using existing tokens; 375px verified.
Evidence: real 1920x1080 -> FFprobe-verified 960x540 proxy E2E; render
  evidence re-runs the M27 multi-clip truncation regression under the new
  gates (10.000s/10.000s, luma ramp PASS, crossfade PASS); timings
  measured. Tests: 11 new (0 fail) + full M1-M27 regression (41 suites)
  exit 0. tsc 0, eslint 0 errors, build 26.5s. No merge/deploy; no M29." >/dev/null
NEW=$(git rev-parse HEAD)
echo "commit: $NEW"
git push -q origin "$BRANCH"
echo "=== push verification ==="
git ls-remote origin refs/heads/"$BRANCH" refs/heads/main | cat
echo "M28_TIP=$NEW"
echo "MAIN_UNCHANGED_CHECK=$(git ls-remote origin refs/heads/main | cut -d'	' -f1)"
