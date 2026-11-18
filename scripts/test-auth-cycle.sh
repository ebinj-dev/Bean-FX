#!/usr/bin/env bash
# Auth persistence smoke test: full git cycle against Bean-FX using ONLY the
# persisted credential helper (no env setup). Creates a dedicated test branch,
# pushes an empty commit, verifies the remote SHA, then deletes the branch.
# main is never modified. Designed to run under `env -i` (pristine shell).
set -euo pipefail
GH_URL=https://github.com/ebinj-dev/Bean-FX.git
WORK=/tmp/beanfx-auth-test
BRANCH=test/auth-persistence
HELPER='!/home/z/my-project/.tools/git-cred.sh'

echo "=== 1. fresh clone with persisted helper ==="
rm -rf "$WORK"
git -c credential.helper="$HELPER" clone --quiet "$GH_URL" "$WORK"
echo "clone OK"

cd "$WORK"
git config user.name "ebinj-dev"
git config user.email "ebinj-dev@users.noreply.github.com"

echo "=== 2. fetch + pull (read path) ==="
git -c credential.helper="$HELPER" fetch origin --quiet && echo "fetch OK"
git -c credential.helper="$HELPER" pull origin main --quiet --ff-only && echo "pull OK"
MAIN_BEFORE=$(git rev-parse origin/main)
echo "main before test: $MAIN_BEFORE"

echo "=== 3. commit (empty, zero file residue) ==="
git checkout --quiet -b "$BRANCH"
git commit --quiet --allow-empty -m "test: auth persistence smoke test (safe to delete)"
LOCAL_SHA=$(git rev-parse HEAD)
echo "test commit SHA: $LOCAL_SHA"

echo "=== 4. push test branch (write path, no force) ==="
git -c credential.helper="$HELPER" push origin "$BRANCH" 2>&1 | tail -1
echo "push OK"

echo "=== 5. verify remote SHA == local commit ==="
REMOTE_SHA=$(git -c credential.helper="$HELPER" ls-remote origin "refs/heads/$BRANCH" | cut -f1)
echo "remote SHA: $REMOTE_SHA"
[ "$REMOTE_SHA" = "$LOCAL_SHA" ] && echo "REMOTE-SHA-MATCH ✓" || { echo "SHA MISMATCH ✗"; exit 1; }

echo "=== 6. main untouched? ==="
MAIN_AFTER=$(git -c credential.helper="$HELPER" ls-remote origin refs/heads/main | cut -f1)
echo "main after test: $MAIN_AFTER"
[ "$MAIN_AFTER" = "$MAIN_BEFORE" ] && echo "MAIN-UNTOUCHED ✓" || { echo "MAIN MOVED ✗"; exit 1; }

echo "=== 7. delete test branch (clean residue) ==="
git -c credential.helper="$HELPER" push origin --delete "$BRANCH" 2>&1 | tail -1
LEFT=$(git -c credential.helper="$HELPER" ls-remote origin "refs/heads/$BRANCH" | wc -l)
[ "$LEFT" -eq 0 ] && echo "TEST-BRANCH-DELETED ✓" || { echo "BRANCH REMAINS ✗"; exit 1; }
cd / && rm -rf "$WORK"
echo "ALL-AUTH-CHECKS-PASSED"
