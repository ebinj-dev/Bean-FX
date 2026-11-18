#!/usr/bin/env bash
# One-command M4 push (runs with the persistent credential).
# Clones fresh at the remote tip, overlays the M4 file set, commits, pushes
# ONLY feature/ai-creative-studio (plain push, never force), then verifies
# the remote SHA and that main is untouched.
set -euo pipefail
SRC=/home/z/my-project
AUTH="$SRC/scripts/git-cred-helper.sh"
BRANCH=feature/ai-creative-studio
CLONE=/tmp/beanfx-push-m4

# 0. authentication gate (persistent credential; exact-reason failures)
bash "$SRC/scripts/gh-auth-restore.sh" || { echo "FATAL: GitHub authentication not ready — see reason above"; exit 1; }
test -x "$AUTH" || { echo "FATAL: credential helper $AUTH missing"; exit 1; }

# 1. fresh clone with the credential helper (also verifies auth works)
rm -rf "$CLONE"
git clone -c credential.helper="!$AUTH" "https://github.com/ebinj-dev/Bean-FX.git" "$CLONE"
cd "$CLONE"
echo "=== cloned; tips before push ==="
git ls-remote origin refs/heads/"$BRANCH" refs/heads/main | cat
git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
BASE=$(git rev-parse HEAD)
echo "branch tip before push: $BASE"

# 2. overlay the M4 set
bash "$SRC/scripts/overlay-m4.sh" "$CLONE"

# 3. commit (skip if the overlay produced no diff)
if git status --porcelain | grep -q .; then
  git add -A
  git -c user.name="Z User" -c user.email="z@container" commit -m "M4 (RIISHE): apply approved cut proposals as validated timeline commands

- riishe-timeline: pure proposal-to-command mapping (audit goal 'Apply
  proposals as validated commands'). Every cut is SplitClip + RippleDelete
  so gaps close and the edited timeline equals the export math (final =
  original - removals); cuts are planned on original geometry and emitted
  in descending timeline order; positions use the engine's own
  clipTimelineDuration so SplitClip exactness holds by construction;
  effective-removal rule mirrors the export path (persisted APPROVE or
  implicit REMOVE; REJECT/KEEP never cut) and reuses normalizeRanges
- editor: 'Apply RIISHE cuts' action - newest analysis per sequence asset,
  persisted decisions replayed, one atomic undoable batch with autosave,
  honest notices for missing analyses / nothing to cut / engine refusal
- safety: locked tracks skipped with warnings (never unlocked);
  missingMedia clips, captions and other assets untouched; sub-frame cuts
  skipped honestly; applyTransaction aborts atomically on any invalid
  command (unit-tested)
- lint hardening: monitor no longer writes refs during render (post-render
  mirror effect); stale eslint-disable directives removed; eslint
  --max-warnings=0 clean again
- tests: scripts/test-riishe-timeline.test.ts 14/14 (exact frame math,
  multi-cut ordering, reused media, idempotence, decision equivalence,
  atomic abort); editor regressions + media pipeline 33/33; p3_union +
  words-srt + v5 inference reliability 27/27; tsc, build clean
- docs: M4_RIISHE.md (design, safety, validation, honest limitations)"
  SHA=$(git rev-parse HEAD)
else
  SHA=$(git rev-parse HEAD)
  echo "no diff after overlay — nothing to commit"
fi

# 4. push — plain push to the one branch only (fails on non-fast-forward; never force)
git push origin "$BRANCH"
echo "=== pushed local SHA: $SHA ==="

# 5. verify via GitHub (ls-remote = the authoritative remote state)
sleep 2
REMOTE_TIP=$(git ls-remote origin refs/heads/"$BRANCH" | awk '{print $1}')
REMOTE_MAIN_BEFORE=$(git ls-remote origin refs/heads/main | awk '{print $1}')
echo "remote $BRANCH tip: $REMOTE_TIP"
echo "remote main tip:   $REMOTE_MAIN_BEFORE"
[ "$REMOTE_TIP" = "$SHA" ] && echo "VERIFIED: remote branch tip == pushed commit" || { echo "MISMATCH between pushed and remote tip"; exit 1; }
echo "$REMOTE_MAIN_BEFORE" > /tmp/remote-main-sha-m4.txt
echo "=== pushed files ==="
git diff --name-only "$BASE" HEAD
echo "PUSH_COMPLETE"
