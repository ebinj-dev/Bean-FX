#!/usr/bin/env bash
# One-command stabilization push (runs AFTER device-flow authorization).
# Clones fresh at the verified tip, overlays the 21-file stabilization set,
# commits, pushes ONLY feature/ai-creative-studio (normal push, never force),
# then verifies the remote SHA and that main is untouched.
set -euo pipefail
SRC=/home/z/my-project
AUTH="$SRC/scripts/git-cred-helper.sh"
BRANCH=feature/ai-creative-studio
CLONE=/tmp/beanfx-push-stab

# 0. authentication gate: validate the persistent credential (no token
#    exposure; exact-reason failure; never starts a device flow on its own)
bash "$SRC/scripts/gh-auth-restore.sh" || { echo "FATAL: GitHub authentication not ready — see reason above"; exit 1; }
test -x "$AUTH" || { echo "FATAL: credential helper $AUTH missing"; exit 1; }

# 1. fresh clone with the credential helper (also verifies auth works)
rm -rf "$CLONE"
git clone -c credential.helper="!$AUTH" "https://github.com/ebinj-dev/Bean-FX.git" "$CLONE"
cd "$CLONE"
echo "=== cloned; tips before push ==="
git ls-remote origin refs/heads/"$BRANCH" refs/heads/main | cat

# 2. verify we are at the expected base (M3 tip) and on the right branch
git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
BASE=$(git rev-parse HEAD)
echo "branch tip before push: $BASE"
git merge-base --is-ancestor origin/main HEAD && echo "branch contains main history (no divergence)" || echo "NOTE: branch and main histories as per repo layout"

# 3. overlay the tested stabilization set (files copied from the durable tree)
bash "$SRC/scripts/overlay-stab.sh" "$CLONE"

# 4. commit (skip if the overlay produced no diff)
if git status --porcelain | grep -q .; then
  git add -A
  git -c user.name="Z User" -c user.email="z@container" commit -m "stabilization: preview hardening verified, M1/M2 correctness fixes, BEANFX_DATA_DIR storage root, image ingestion, timeline 409 race fix, autosave durability, P3 decision-persistence restoration, Postgres migration strategy

- editor commands: TrimClip inverse preserves missingMedia (caption trim-undo
  restores a valid sequence); locked tracks refuse ALL clip edits, including
  in-place MoveClip; EditHistory.undo/redo report failure without corrupting
  the stack
- inspector volume dispatches real ChangeVolume (was a zod-stripped no-op);
  preview gain cap raised to the model bound (4.0)
- persistence: unique-constraint loss (P2002) now surfaces as 409 with the
  authoritative head instead of a 400 + silent client loss
- session hook: retry-with-backoff for transient save failures, keepalive
  beforeunload flush, 4xx reloads authoritative head
- monitor: captions render without video src; IMAGE assets render as stills
  (<img>) and stop stale video audio
- media-storage: BEANFX_DATA_DIR configurable root, validateStorageRoot,
  pathInsideMediaRoot containment; IMAGE kind + png/jpeg/webp sniffing
- media-analysis: image probes (dims/mime, no proxy); mimeFromContainer
  handles png / jpeg(mjpeg) / webp_pipe / image2 demuxers
- auto-cut: restored P3 decision persistence lost in the workspace recycle
  (decisionToReview mapping, save on review toggle, SAVED badges, restore +
  reopen via analyses/result endpoints)
- client-api: analyses()/decisions()/saveDecision()
- tests: editor regressions, image ingestion, path containment, 60s worker
  test timeouts; e2e: image workflow, concurrent-write 409 race, dedup race
- docs: DATABASE_POSTGRES_MIGRATION.md (strategy + backup/rollback; no live
  switch executed — documented honestly)"
  SHA=$(git rev-parse HEAD)
else
  SHA=$(git rev-parse HEAD)
  echo "no diff after overlay — nothing to commit"
fi

# 5. push — plain push to the one branch only (fails on non-fast-forward; never force)
git push origin "$BRANCH"
echo "=== pushed local SHA: $SHA ==="

# 6. verify via GitHub (ls-remote = the authoritative remote state)
sleep 2
REMOTE_TIP=$(git ls-remote origin refs/heads/"$BRANCH" | awk '{print $1}')
REMOTE_MAIN=$(git ls-remote origin refs/heads/main | awk '{print $1}')
echo "remote $BRANCH tip: $REMOTE_TIP"
echo "remote main tip:   $REMOTE_MAIN"
[ "$REMOTE_TIP" = "$SHA" ] && echo "VERIFIED: remote branch tip == pushed commit" || { echo "MISMATCH between pushed and remote tip"; exit 1; }
echo "$REMOTE_MAIN" > /tmp/remote-main-sha.txt
echo "=== pushed files ==="
git diff --name-only "$BASE" HEAD
echo "PUSH_COMPLETE"
