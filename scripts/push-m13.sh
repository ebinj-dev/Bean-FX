#!/usr/bin/env bash
# One-command M13 push (persistent credential; plain fast-forward push, never force).
set -euo pipefail
SRC=/home/z/my-project
AUTH="$SRC/scripts/git-cred-helper.sh"
BRANCH=feature/ai-creative-studio
CLONE=/tmp/beanfx-push-m13

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
echo "=== M12 commit present in history ==="
git merge-base --is-ancestor dcf875f3f49d9da78df338aa45c760db2b4fcba4 HEAD && echo "M12 dcf875f IS in history"

bash "$SRC/scripts/overlay-m13.sh" "$CLONE"

if git status --porcelain | grep -q .; then
  echo "=== secret scan (M13 set) ==="
  if git diff --name-only "$BASE" | while read -r f; do
        case "$f" in *.ttf) continue;; esac
        grep -lE "gho_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9]{20,}|BEGIN (RSA|OPENSSH) PRIVATE KEY" "$f" 2>/dev/null
      done | grep -q .; then
    echo "SECRET SCAN FAILED — aborting push"; exit 1
  fi
  echo "(clean)"
  git add -A
  git -c user.name="Z User" -c user.email="z@container" commit -m "M13 (Temporal Visual Intelligence & Motion Tracking): real multi-frame CSRT tracking, motion and camera intelligence, temporal events, temporal search, tracking-assisted NIIKI motion graphics

- temporal sampling (§2): scene-aware consecutive-frame windows at
  configurable sampleFps (1-15) — VFR inputs are CFR-ized by the ffmpeg fps
  filter with exact showinfo pts timestamps; every frame carries asset, clip,
  SOURCE seconds AND TIMELINE seconds (speed-aware shared mappers, tested at
  playbackSpeed 2), dimensions, sampling interval, window index; budgeted
  per-window spread; temp frames always cleaned (finally, test-proven);
  corrupt media refuses honestly
- REAL tracking (§3): detector-assisted OpenCV CSRT tracking across
  consecutive decoded frames (NOT per-frame descriptions) — registered
  consecutive-frame-difference detection with near-whole-frame rejection,
  one CSRT tracker per subject updated every sampled frame, appearance-
  consistency NCC check (a subject that STOPS keeps tracking; a subject that
  LEAVES collapses NCC → honest tracker-lost, no drift-following), occlusion
  intervals (sustained IoU > 0.55), left-frame exits, DUPLICATE detection
  (sustained center proximity → merged with mergedInto provenance), and
  re-appearance links labeled INFERRED (continuity candidates, never
  identity; no real-person identification, no sensitive attributes)
- motion intelligence (§4): per-track measurements with documented coordinate
  systems — direction, PIXEL-space speed (never real-world, stated on every
  record), acceleration trends, onset/stop, sudden position changes (scene-
  cut-adjacent excluded), repeated patterns (autocorrelation), foreground
  px/frame AFTER global-motion subtraction
- camera intelligence (§5): global registration separated from foreground —
  masked-ECC authority rule when background is visible (a bright moving
  subject cannot fake camera motion), phase correlation for full-frame
  motion, WINDOW-CUMULATIVE multiscale zoom estimation (log-polar variant
  honestly rejected and documented), static/pan/tilt/zoom/pan-tilt/
  handheld-like/uncertain classification with confidence and magnitude
  evidence; 'handheld-like' explicitly NOT a cinematography classification
- temporal events (§6): entry/exit/loss/occlusion/onset/stop/sudden-change/
  repeated/camera-move/static-span/continuity-candidates/speech-over-motion
  combined from tracks + motion + camera + M12 scenes + M11 speech, with
  method, evidence label and confidence on every record
- temporal search (§7): project-scoped search over REAL temporal records —
  deterministic local predicates (direction, entry/exit, categories,
  static/motion, repeats, camera classes, time/track filters, honest misses,
  Tamil note) + consent-gated provider ranking (validated, TEXT-only);
  results carry kind, both clocks, evidence and previews with timeline seek
- motion graphics (§8): validated tracks → NIIKI proposals via the M6
  evaluator's anchor-offset % keyframe space (clip-relative, ≤40 sampled
  keyframes); tracking gaps HOLD the last measured position — nothing
  extrapolated; sparse tracks refused honestly; real-frame preview overlays
  registered as IMAGE assets; payload = M1 AddTrack(GRAPHIC)+AddGraphic
  executed ONLY through the approval flow into applyTimelineEdits (versioned,
  undo/redo intact — test-proven)
- temporal workspace (§10): Motion tab in the Creative Director — Object
  Tracks with Track Inspector (per-sample boxes, both clocks, seek),
  Camera Movement, Temporal Events, Temporal Search, Motion Graphics
  Proposals with real-frame previews; all M10-M12 tabs preserved
- jobs (§11): TEMPORAL_INTELLIGENCE on the EXISTING worker (45 min, per-user
  1) — whole-run dedup (identical deps ⇒ stored index REUSED, tested),
  fingerprint invalidation with reasons (asset mtime, timeline version,
  settings, tracking model), M12 scene/summary reuse, cancellation, recovery,
  temp cleanup; artifacts on the EXISTING CreativeAnalysisArtifact — ZERO
  schema changes
- privacy (§12): local tracking/camera/motion/search upload NOTHING and need
  no consent; the ONLY external call is optional subject-category labeling of
  ≤4 crops (explicit consent, exact disclosure, AIUsage + audit); OpenCV
  Apache-2.0 + numpy BSD-3 reviewed before integration; no Ollama
- API: /api/creative/temporal/{index,search,mograph} — auth, ownership, zod,
  version checks, audit rows
- tests: temporal-core 15/15 (REAL OpenCV over KNOWN-motion fixtures: 35 px/s
  box → 35.02 px/s measured, duplicate ghost merged, pan measured globally
  and NOT misattributed to subjects, zoom via window-cumulative multiscale,
  gap → tracker-loss + inferred continuity candidate, REAL M1/M2 AddGraphic
  insertion, FULL job with reuse/invalidation/cleanup); temporal-live 2/2
  REAL providers (consented glm-4.5v labeling of a real tracked crop;
  provider-ranked temporal search citing 38 samples at 32.99 px/s); full
  matrix 28 suites / 0 failures; tsc/eslint clean; prisma valid (no schema
  change); production build ✓; production E2E 11/11 (enqueue→worker→index→
  search→proposal→Motion tab shipped)"
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
