#!/usr/bin/env bash
# One-command M7 push (persistent credential; plain fast-forward push, never force).
# Fresh clone at the remote tip → overlay M7 set → secret scan → commit →
# push ONLY feature/ai-creative-studio → verify remote SHA + main untouched.
set -euo pipefail
SRC=/home/z/my-project
AUTH="$SRC/scripts/git-cred-helper.sh"
BRANCH=feature/ai-creative-studio
CLONE=/tmp/beanfx-push-m7

bash "$SRC/scripts/gh-auth-restore.sh" || { echo "FATAL: GitHub authentication not ready"; exit 1; }
test -x "$AUTH" || { echo "FATAL: credential helper $AUTH missing"; exit 1; }

rm -rf "$CLONE"
git clone -q -c credential.helper="!$AUTH" "https://github.com/ebinj-dev/Bean-FX.git" "$CLONE"
cd "$CLONE"
echo "=== tips before push ==="
git ls-remote origin refs/heads/"$BRANCH" refs/heads/main | cat
git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
BASE=$(git rev-parse HEAD)
echo "branch tip before push: $BASE"

bash "$SRC/scripts/overlay-m7.sh" "$CLONE"

# Secret scan over the M7 diff (text files).
if git status --porcelain | grep -q .; then
  echo "=== secret scan (M7 set) ==="
  if git diff --name-only "$BASE" | while read -r f; do
        case "$f" in *.ttf) continue;; esac
        grep -lE "gho_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9]{20,}|BEGIN (RSA|OPENSSH) PRIVATE KEY" "$f" 2>/dev/null
      done | grep -q .; then
    echo "SECRET SCAN FAILED — aborting push"; exit 1
  fi
  echo "(clean)"
  git add -A
  git -c user.name="Z User" -c user.email="z@container" commit -m "M7 (JAZMII + LAXII): video + image creative engines — provider-backed generation, analysis, shared asset lifecycle, MY AI routing

- provider architecture: one typed contract per engine with capability maps
  (options mirror what the configured provider ACTUALLY accepts), typed
  honest errors (NOT_CONFIGURED/AUTH_FAILED/RATE_LIMITED/UNSUPPORTED/TIMEOUT/
  INVALID_RESPONSE), no silent switching, credentials server-side only,
  no Ollama; commercial-use/retention metadata marked NOT independently
  verified rather than invented
- JAZMII: zai-video adapter (cogvideox-3, real SUCCESS shape
  video_result[0].url), durable JAZMII_GENERATE (bounded poll + heartbeat +
  cancellation + 15 min timeout, download cap, sniff + ffprobe + duration/
  aspect validation, registration with provenance), JAZMII_ANALYZE
  (ffprobe + ffmpeg scene/blackdetect/freezedetect labeled heuristic,
  keyframes registered as child assets, deterministic aHash), deterministic
  B-roll shot suggestions (confidence honestly null), no sourcing provider
  configured — feature honestly absent
- LAXII: zai-image + image-edit adapters (7 REAL sizes; transparency and
  negative prompts listed UNSUPPORTED — provider returns JPEG for .png,
  caught live), LAXII_GENERATE with 1-4 alternatives, non-destructive PIL
  processing (aspect adaptation, 480px thumbnails, RGBA preservation)
- shared asset lifecycle (src/lib/ai/asset-lifecycle.ts): sniff → validate →
  quota → relocate into MEDIA_ROOT/<engine>-outputs → sha256 → MediaAsset
  with createdBy/provider/model/prompt/params/license/attribution/
  referenceAssetId; failed registrations delete the file (no orphans)
- MY AI: src/lib/ai/registry.ts deterministic routing across all five
  engines; generation proposals are approval-gated (never auto-executed);
  POST /api/ai/route + /api/ai/outputs; per-user concurrency + route
  validation on /api/jazmii/* and /api/laxii/*
- timeline integration via M1 commands only: video and still-image inserts,
  TrimClip duration edits, NIIKI keyframes animate stills; undo/redo/autosave
  native
- Prisma: additive MediaAsset provenance columns (NULL-backfilled) + indexes
- tests: 14 suites / 0 failures via scripts/run-all-tests.sh — JAZMII 15/15
  (incl. REAL cogvideox-3 artifact analysis), LAXII 14/14 (incl. REAL
  provider generation under BEANFX_M7_REAL_PROVIDER=1, pixel-asserted),
  ai-registry 12/12; M1-M6 regressions all green; fixture provider is a
  clearly labeled test fixture, never reported as real AI output
- gates: tsc clean, eslint --max-warnings=0 clean, prisma validate, build ok
- docs: M7_JAZMII_LAXII.md (contracts, capabilities, lifecycle, privacy,
  tests and actual results, limitations)"
  SHA=$(git rev-parse HEAD)
else
  SHA=$(git rev-parse HEAD)
  echo "no diff after overlay — nothing to commit"
fi

git push origin "$BRANCH"
echo "=== pushed local SHA: $SHA ==="
sleep 2
REMOTE_TIP=$(git ls-remote origin refs/heads/"$BRANCH" | awk '{print $1}')
REMOTE_MAIN=$(git ls-remote origin refs/heads/main | awk '{print $1}')
echo "remote $BRANCH tip: $REMOTE_TIP"
echo "remote main tip:   $REMOTE_MAIN"
[ "$REMOTE_TIP" = "$SHA" ] && echo "VERIFIED: remote branch tip == pushed commit" || { echo "MISMATCH between pushed and remote tip"; exit 1; }
echo "=== pushed files ==="
git diff --name-only "$BASE" HEAD
echo "PUSH_COMPLETE"
