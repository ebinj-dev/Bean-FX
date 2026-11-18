#!/usr/bin/env bash
# One-command M8.1 push (persistent credential; plain fast-forward push, never force).
set -euo pipefail
SRC=/home/z/my-project
AUTH="$SRC/scripts/git-cred-helper.sh"
BRANCH=feature/ai-creative-studio
CLONE=/tmp/beanfx-push-m81

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

bash "$SRC/scripts/overlay-m81.sh" "$CLONE"

if git status --porcelain | grep -q .; then
  echo "=== secret scan (M8.1 set) ==="
  if git diff --name-only "$BASE" | while read -r f; do
        case "$f" in *.ttf) continue;; esac
        grep -lE "gho_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9]{20,}|BEGIN (RSA|OPENSSH) PRIVATE KEY" "$f" 2>/dev/null
      done | grep -q .; then
    echo "SECRET SCAN FAILED — aborting push"; exit 1
  fi
  echo "(clean)"
  git add -A
  git -c user.name="Z User" -c user.email="z@container" commit -m "M8.1 (Social Video Studio): topic-to-editable-video workflow — production planner, TTS narration, scene assets, assembly, batch

- MoneyPrinterTurbo-inspired, independently implemented (MIT licence studied;
  no code/assets/algorithms copied — mapping documented in docs/
  M8_1_SOCIAL_VIDEO_STUDIO.md); no publishing integrations represented
- brief + platform profiles (YouTube Shorts/Reels/TikTok/landscape/square)
  validated against real sequence bounds and per-platform caps; EN + TA
- production planner on the M8 LLM gateway: ProductionPlanSchema v1
  (hook/intro/scenes/narration/visuals/footage/on-screen text/captions/music/
  transitions/CTA/sources), deterministic normalization + informed repair,
  labeled deterministic fallback, NO fabricated citations; per-scene
  regeneration verified live to touch only the target scene
- narration: NEW zai-tts adapter (verified live: WAV 24kHz, voice tongtong),
  registered as probe-READY MediaAsset with provenance; Tamil TTS honestly
  refused (not verified on this provider) with upload path
- scene assets: JAZMII/LAXII durable jobs (platform-correct sizes) + owned-
  asset assignment with provenance; stock search honestly unavailable
- assembly through the M1 command engine + M2 versioned persistence:
  integer-frame timing, locked tracks respected, scene-labeled clips,
  RIISHE ASR caption timing (measured chunk windows; word timing stays the
  documented M4 estimate), M1 transition overlap semantics, assemblyJson
- pipeline fix: buildNikkiRenderPlan emits split=N for shared inputs —
  multi-scene renders reusing one asset previously produced an invalid
  filter graph
- batch: STUDIO_TOPIC durable jobs on the EXISTING queue (validate-before-
  dispatch, per-topic status, cancellation via job cancel, concurrency 1)
- studio panel in the editor (Create/Script/Storyboard/Voice/Assemble) with
  external-processing disclosures; publishing absent by design
- additive Prisma models StudioPlan/StudioScene/StudioBatch
- tests: studio-core 16/16 (fixture/engine), studio-live 5/5 (REAL LLM plan,
  REAL TTS asset, REAL RIISHE captions on TTS audio, live regen, real
  worker batch); full matrix 19 suites / 0 failures; tsc/eslint/prisma/
  build clean"
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
[ "$REMOTE_TIP" = "$SHA" ] && echo "VERIFIED: remote branch tip == pushed commit" || { echo "MISMATCH"; exit 1; }
echo "=== pushed files ==="
git diff --name-only "$BASE" HEAD
echo "PUSH_COMPLETE"
