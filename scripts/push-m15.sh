#!/usr/bin/env bash
# One-command M15 push (persistent credential; plain fast-forward push, never force).
set -euo pipefail
SRC=/home/z/my-project
AUTH="$SRC/scripts/git-cred-helper.sh"
BRANCH=feature/ai-creative-studio
CLONE=/tmp/beanfx-push-m15

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
echo "=== M14 commit present in history ==="
git merge-base --is-ancestor 03d2778639e37f1feea4db795110f8b91d8abeb9 HEAD && echo "M14 03d2778 IS in history"

bash "$SRC/scripts/overlay-m15.sh" "$CLONE"

if git status --porcelain | grep -q .; then
  echo "=== secret scan (M15 set) ==="
  if git diff --name-only "$BASE" | while read -r f; do
        case "$f" in *.ttf) continue;; esac
        grep -lE "gho_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9]{20,}|BEGIN (RSA|OPENSSH) PRIVATE KEY" "$f" 2>/dev/null
      done | grep -q .; then
    echo "SECRET SCAN FAILED — aborting push"; exit 1
  fi
  echo "(clean)"
  git add -A
  git -c user.name="Z User" -c user.email="z@container" commit -m "feat(m15): professional editing studio transformation

Root cause (docs/M15_WORKSPACE_AUDIT.md): the editing application already
existed — M1 command engine, multitrack sequence model, session hook, real
monitor/timeline/inspector and every AI panel — but the landing page sold
AI tools, the editor was buried as a tool route with flat tool-page chrome,
and import/canvas/AI-context were missing. M15 re-organizes and completes
it; no second engine, no replaced architecture.

- workspace shell: the editor becomes the PRIMARY experience — professional
  desktop layout with application header (brand, project rename, save
  badge, undo/redo, AI STUDIO/EXPORT/settings drawers), resizable MEDIA/
  EFFECTS left dock, PROGRAM MONITOR with transport + guides, PROPERTIES
  INSPECTOR, editing-tool toolbar and the multitrack timeline; authed
  default route and dashboard project cards now open the editor
  (#/editor?project=<id>); hash router parses query params
- editing tools (lib/editor/tools.ts, all compiled to validated M1
  commands): select, track-select (forward multi-select + atomic group
  delete/move), razor (split at click), SLIP (one TrimClip pinning position
  while shifting the source window), SLIDE (clip moves, neighbors trim to
  absorb — sequence duration preserved, honest refusals at source bounds),
  hand (pan), zoom (zoom-at-point), text (caption at click), transform
  (monitor canvas); snapping to clip edges/playhead; tool shortcuts V/A/C/
  Y/U/H/Z/T/R; copy/paste; right-click context menu; per-track heights;
  add track; audio waveforms from the real waveform API; keyframe markers
- interactive composition canvas (Phase C): a transparent overlay computing
  REAL layer geometry from the same sequence/preview evaluators the export
  path uses — bounding boxes for video/graphic/caption layers active at the
  playhead (NIIKI text metrics), selection + corner scale + rotate handles,
  thirds/center guides with snap, live ghost during gesture, committed as
  ONE UpdateClipProperties command per gesture; gesture state is
  ref-driven (no lost events during re-renders); setPointerCapture hardened
  for synthetic pointers; E2E proves a real drag commits transform.x
- unified AI STUDIO (Phase D): one drawer hosting MY AI + RIISHE +
  GANGZII + NIIKI + JAZMII + LAXII + COMPOSE (M14) panels unchanged, with
  a CONTEXT bar (selected clip, playhead, sequence shape) injected into MY
  AI plan requests
- media browser with REAL in-editor import (resumable upload pipeline —
  the worktree upload route deleted by an environment auto-commit was
  restored from the remote branch), search/kind filters, probe-aware
  placement
- effects browser: only REAL implementations (opacity/volume/flipH/flipV/
  grayscale/blur via AddEffect; CUT/CROSS_DISSOLVE/FADE_TO_BLACK/
  FADE_FROM_BLACK/WIPE_LEFT/WIPE_RIGHT/SLIDE_LEFT/SLIDE_RIGHT via
  AddTransition; fades + playback speed) — no fake tiles
- project management: /api/projects/[id] GET/PATCH/POST (detail+version
  history, rename, duplicate carrying the latest sequence version); export
  via the existing M9 publishing workspace in a drawer
- tests: m15-core 8/8 (slip/slide/razor/group/keyframe/duplicate/evaluator
  parity/round-trip against the REAL engine); E2E 10-step browser run on
  the production build — real ffmpeg-generated media imported through the
  resumable pipeline, placed, razor-split, undone, canvas-dragged
  (transform.x committed), AI Studio verified, reload persistence; 8
  screenshots as evidence; full matrix 31 suites / 0 failures; build clean"
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
git merge-base --is-ancestor 03d2778639e37f1feea4db795110f8b91d8abeb9 "$REMOTE_TIP" && echo "M14 remains in remote history"
echo "=== pushed files ==="
git diff --name-only "$BASE" HEAD
echo "PUSH_COMPLETE"
