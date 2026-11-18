#!/usr/bin/env bash
# One-command M6 push (persistent credential; plain push, never force).
# Fresh clone at the remote tip → overlay M6 set → commit → push ONLY
# feature/ai-creative-studio → verify the exact remote SHA + main untouched.
set -euo pipefail
SRC=/home/z/my-project
AUTH="$SRC/scripts/git-cred-helper.sh"
BRANCH=feature/ai-creative-studio
CLONE=/tmp/beanfx-push-m6

bash "$SRC/scripts/gh-auth-restore.sh" || { echo "FATAL: GitHub authentication not ready — see reason above"; exit 1; }
test -x "$AUTH" || { echo "FATAL: credential helper $AUTH missing"; exit 1; }

rm -rf "$CLONE"
git clone -q -c credential.helper="!$AUTH" "https://github.com/ebinj-dev/Bean-FX.git" "$CLONE"
cd "$CLONE"
echo "=== tips before push ==="
git ls-remote origin refs/heads/"$BRANCH" refs/heads/main | cat
git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
BASE=$(git rev-parse HEAD)
echo "branch tip before push: $BASE"

bash "$SRC/scripts/overlay-m6.sh" "$CLONE"

if git status --porcelain | grep -q .; then
  git add -A
  git -c user.name="Z User" -c user.email="z@container" commit -m "M6 (NIIKI): motion graphics & animation engine — keyframes, kinetic typography, lower thirds, titles, transitions, preview + FFmpeg render

- animation core (src/lib/nikki/animation.ts): one deterministic evaluator
  shared by preview and export — LINEAR/HOLD/EASE family + cubic-Bézier
  (Newton+ bisection), frame-accurate integer-frame evaluation, new keyframe
  properties scaleX/scaleY/blur/letterSpacing (additive to the M1 model);
  ffmpegExprFor emits closed-form polynomials and frame-time-exact Bézier
  ladders — parity vs the TS evaluator verified at EVERY frame by tests
- kinetic typography (typography.ts): Intl.Segmenter graphemes (Tamil
  combining marks stay intact; mixed-language tested), word-by-word reveals,
  character/typewriter reveals (bounded, honest degradation), highlights,
  entrance/exit windows, animated tracking (constant in export — documented)
- templates (templates.ts): 9 versioned, structured assets (lower thirds,
  titles, captions, news banner, section heading, logo pulse) seeded as fully
  editable NikkiGraphicStyle on graphic clips; bundled Noto Sans + Noto Sans
  Tamil fonts (SIL OFL 1.1, NOTICE.txt included)
- timeline integration: AddGraphic/UpdateClipProperties(graphicStyle),
  SetKeyframe/RemoveKeyframe, Split/Trim/Move/Remove all work on graphics via
  the M1 command engine (one history — native undo/redo/autosave/persistence);
  6 new transition kinds (slide/push/zoom) mapped 1:1 to FFmpeg xfade
- real-time preview: program monitor canvas layer redrawn per playhead frame
  from activeGraphicsAt/graphicStateAt (same evaluator as export); FontFace
  Noto loading with documented fallback; measured 0.14 ms/frame at 4 graphics
- final rendering: buildNikkiRenderPlan → drawbox/drawtext chains (animated
  x/y/alpha/enable, FreeType+raqm text metrics on the SAME fonts) + xfade
  transition joins; NIKKI_RENDER durable worker job (progress/cancel/timeout,
  A/V sync guard ±max(0.15s, 2 frames)) → ExportFile; POST /api/nikki/render
  validates the snapshot (parseSequence) + ownership-checks every asset —
  no client FFmpeg arguments anywhere
- MY AI: proposeNikki deterministic intents → command proposals applied
  through the session (re-validated); honest 422 on no-match; NIKKI_ENGINE
  descriptor (usesLLM:false) as M8 groundwork; POST /api/nikki/proposal
- tests: 11 suites / 0 failures via scripts/run-all-tests.sh — NIIKI core
  31/31 (easing anchors, CSS ease reference, FPS awareness, parity at every
  frame, Tamil graphemes, templates→commands→undo/redo→persistence, perf)
  and render 6/6 (real FFmpeg pixels: title position, fade ramp, word order,
  xfade red→purple→blue, lower-third parity, duration guards); M1–M5
  regressions all green
- gates: tsc clean, eslint --max-warnings=0 clean, prisma validate, build ok
- docs: M6_NIIKI.md (architecture, model, rendering pipeline, measured
  performance, limitations)"
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
echo "$REMOTE_MAIN" > /tmp/remote-main-sha-m6.txt
echo "=== pushed files ==="
git diff --name-only "$BASE" HEAD
echo "PUSH_COMPLETE"
