#!/usr/bin/env bash
# One-command M14 push (persistent credential; plain fast-forward push, never force).
set -euo pipefail
SRC=/home/z/my-project
AUTH="$SRC/scripts/git-cred-helper.sh"
BRANCH=feature/ai-creative-studio
CLONE=/tmp/beanfx-push-m14

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
echo "=== M13 commit present in history ==="
git merge-base --is-ancestor 1174da46987631e952763607d15517ce2252043c HEAD && echo "M13 1174da4 IS in history"

bash "$SRC/scripts/overlay-m14.sh" "$CLONE"

if git status --porcelain | grep -q .; then
  echo "=== secret scan (M14 set) ==="
  if git diff --name-only "$BASE" | while read -r f; do
        case "$f" in *.ttf) continue;; esac
        grep -lE "gho_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9]{20,}|BEGIN (RSA|OPENSSH) PRIVATE KEY" "$f" 2>/dev/null
      done | grep -q .; then
    echo "SECRET SCAN FAILED — aborting push"; exit 1
  fi
  echo "(clean)"
  git add -A
  git -c user.name="Z User" -c user.email="z@container" commit -m "feat(m14): add AI art direction and motion composition

- reference audit (docs/M14_REFERENCE_AUDIT.md): bang-motion, vox-director,
  huashu-art-motion, claude-drawing-skill studied; MIT licenses verified per
  repo (incl. huashu's Arphic strokes.js + demo-only artwork exceptions);
  principles adopted as inspiration only — zero code/artwork copied
- M14.1 AI Motion Art Director: 3 distinct validated directions per brief
  with per-swatch palette provenance, anti-homogenization fingerprints,
  approval gate (assets refuse without an APPROVED direction), honest
  provider failures; ArtDirection model
- M14.2 narration-to-visual scene composer: DETERMINISTIC segmentation over
  RIISHE segments with VERBATIM timestamps (never invented), explicit
  ESTIMATE labels without a transcript, AI concept enrichment with timings
  as fixed input, per-scene approval/regeneration preserving approved
  scenes, manual reorder/duration edits (verbatim → REVISED + estimate
  relabel), Tamil-safe text storage, contiguity reporting; ScenePlan model
- M14.3 LAXII visual asset studio: style-profile prompts from the approved
  direction, format-mapped sizes, alternatives, existing lifecycle
  registration with provenance, ACTUAL-pixel alpha verification (live:
  provider returns opaque pixels — transparency NOT claimed), temp cleanup,
  non-destructive originals
- M14.4 NIIKI motion composition: 9 deterministic preset keyframe
  generators (soft-reveal, push-in, float, bounce, kinetic, transition,
  parallax, track-following, emphasis-pulse with RIISHE beat frames) in the
  NIIKI easing family, integer frames, stable ids; evalKeyframes mirrors the
  evaluator (spot-tested)
- M14.5 REAL layered compositing foundation: ONE canonical CompositionDoc +
  deterministic evaluator consumed by BOTH preview and export; PIL
  frame-by-frame compositor (source-over with off-canvas clipping,
  multiply/screen with documented conventions, alpha masks with
  invert/opacity, anchor-based transforms) + FFmpeg encode + optional audio
  mux through the EXISTING COMPOSITION_RENDER durable job; pixel-tested
  parity (multiply/screen/bg within documented ±6 tolerance on decoded
  H.264); limits (≤24 layers, ≤1920px, ≤3600 frames), cancellation between
  frames, temp cleanup, progress, provenance; Composition +
  CompositionVersion models (optimistic concurrency, immutable version
  history = undo/redo)
- M14.6 M13 tracking-aware compositing: attach/detach via real temporal
  index samples, HOLD-last-visible gap policy (occluded samples never
  trusted, gaps flagged honestly), honest refusals without a completed
  index, undoable version commits, no identity claims
- M14.7 Compose workspace tab (ART DIRECTION / SCENE PLAN / VISUAL ASSETS /
  COMPOSITION / MOTION / REVIEW) — every control performs a real action;
  existing tabs and editor interactions preserved
- MY AI planner/executor extended with typed M14 operations routed to the
  real endpoints (approval-gated, no model-generated execution)
- M13 hardening: temporal tracking worker gains an LK feature-point fallback
  (base OpenCV) so CSRT-contrib absence degrades honestly instead of
  crashing — full matrix stays green across environments
- tests: m14-core 16/16 (stub-LLM seam + REAL PIL/FFmpeg rendering with
  decoded-pixel parity), m14-live 3/3 REAL providers (glm-4-plus directions;
  real 1344x768 LAXII asset with verified opaque pixels), full matrix 30
  suites / 0 failures, production build, E2E 10/10 (3 real directions →
  approval → scene plan → real asset → composition create/commit/undo →
  honest M13 refusal → REAL render → Compose tab shipped)"
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
git merge-base --is-ancestor 1174da46987631e952763607d15517ce2252043c "$REMOTE_TIP" && echo "M13 remains in remote history"
echo "=== pushed files ==="
git diff --name-only "$BASE" HEAD
echo "PUSH_COMPLETE"
