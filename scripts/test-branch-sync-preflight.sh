#!/usr/bin/env bash
# =============================================================================
# Test harness for scripts/branch-sync-preflight.sh
# Simulates all guard scenarios against a LOCAL bare origin — never touches
# the real GitHub remote. Scratch dirs live under /tmp/pf-* and are cleaned.
#
# NOTE: `git reset`-style operations below run ONLY inside throwaway fixture
# clones created by this script; the Bean FX repo itself is never touched.
# =============================================================================
set -u

GUARD_SRC="/tmp/beanfx-sync/scripts/branch-sync-preflight.sh"
MIRROR="/tmp/pf/ebinj-dev/Bean-FX.git"   # path contains the repo mark on purpose
WORK="/tmp/pf-work"          # helper clone used to advance the bare origin
TEST="/tmp/pf-test"          # clone under test
PASS=0; FAIL=0

expect() { # expect <expected_code> <label>
  local want="$1" label="$2" got="$3"
  if [ "$got" = "$want" ]; then
    printf 'PASS  %-22s exit=%s (expected %s)\n' "$label" "$got" "$want"; PASS=$((PASS+1))
  else
    printf 'FAIL  %-22s exit=%s (expected %s)\n' "$label" "$got" "$want"; FAIL=$((FAIL+1))
  fi
}
run_guard() { (cd "$TEST" && bash "$GUARD_SRC") >/tmp/pf-last-output.txt 2>&1; echo $?; }
# NOTE: full mode (fetch enabled). The fixture origin is a local file://
# mirror, so fetch exercises the real code path without touching GitHub.
show_tail() { echo "--- last guard output (tail) ---"; tail -n "${1:-8}" /tmp/pf-last-output.txt; echo "--------------------------------"; }

cleanup() { rm -rf /tmp/pf "$WORK" "$TEST"; }
trap cleanup EXIT

echo "== setup: local bare origin + clones (all file:// local) =="
cleanup
git clone --mirror -q /tmp/beanfx-sync "$MIRROR"
git clone -q "$MIRROR" "$WORK"
git -C "$WORK" config user.email "test@example.com"
git -C "$WORK" config user.name "Preflight Test"
git clone -q "$MIRROR" "$TEST"
git -C "$TEST" config user.email "test@example.com"
git -C "$TEST" config user.name "Preflight Test"
# the fixture origin path already contains "ebinj-dev/Bean-FX", so the guard's
# URL check passes while all transport stays local (file://) — no real remote.
git -C "$TEST" checkout -q feature/ai-creative-studio 2>/dev/null || git -C "$TEST" checkout -q -b feature/ai-creative-studio origin/feature/ai-creative-studio

echo "== scenario 1: synchronized (feature == origin/feature, contains main) =="
code=$(run_guard); expect 0 "synchronized" "$code"
grep -q "SYNCHRONIZED" /tmp/pf-last-output.txt && echo "PASS  synchronized-message" && PASS=$((PASS+1)) || { echo "FAIL  synchronized-message"; FAIL=$((FAIL+1)); show_tail; }

echo "== scenario 2: behind (GitHub merged the PR: main advanced, feature has no NEW commits) =="
# simulate GitHub's merge queue: main receives a MERGE COMMIT of the feature
# branch — exactly the pattern that leaves feature strictly behind main:
git -C "$WORK" checkout -q main
git -C "$WORK" merge -q --no-ff feature/ai-creative-studio \
  -m "chore(sim): GitHub merged PR — main advanced independently"
git -C "$WORK" push -q origin main
code=$(run_guard); expect 4 "behind" "$code"
grep -q "GitHub merged PR" /tmp/pf-last-output.txt && echo "PASS  behind-lists-commits" && PASS=$((PASS+1)) || { echo "FAIL  behind-lists-commits"; FAIL=$((FAIL+1)); show_tail 14; }
grep -q "merge --ff-only origin/main" /tmp/pf-last-output.txt && echo "PASS  behind-ff-advice" && PASS=$((PASS+1)) || { echo "FAIL  behind-ff-advice"; FAIL=$((FAIL+1)); show_tail 14; }

echo "== scenario 3: divergent (feature AND main both advanced on origin) =="
git -C "$WORK" checkout -q feature/ai-creative-studio
echo "# simulated feature advance on origin" > "$WORK/docs/REHEARSAL_SIM.txt"
git -C "$WORK" add -A && git -C "$WORK" commit -q -m "feat(sim): origin feature advanced"
git -C "$WORK" push -q origin feature/ai-creative-studio
# local developer absorbs origin/feature first (so the upstream check passes),
# leaving local commits of its own while main also moved -> true divergence:
git -C "$TEST" fetch -q origin   # refresh remote-tracking refs first
git -C "$TEST" merge -q --no-edit origin/feature/ai-creative-studio
code=$(run_guard); expect 5 "divergent" "$code"
grep -q "DIVERGED" /tmp/pf-last-output.txt && echo "PASS  divergent-message" && PASS=$((PASS+1)) || { echo "FAIL  divergent-message"; FAIL=$((FAIL+1)); show_tail 12; }
grep -q "git merge origin/main" /tmp/pf-last-output.txt && echo "PASS  divergent-merge-advice" && PASS=$((PASS+1)) || { echo "FAIL  divergent-merge-advice"; FAIL=$((FAIL+1)); show_tail 12; }
grep -q "NEVER rebase" /tmp/pf-last-output.txt && echo "PASS  divergent-no-rebase" && PASS=$((PASS+1)) || { echo "FAIL  divergent-no-rebase"; FAIL=$((FAIL+1)); show_tail 12; }

echo "== scenario 4: local branch behind its own upstream (exit 6) =="
# park the test clone exactly at origin/main (scratch clone only):
git -C "$TEST" checkout -q -B feature/ai-creative-studio origin/main
code=$(run_guard); expect 6 "behind-upstream" "$code"

echo "== scenario 5: wrong branch (checkout main) =="
git -C "$TEST" checkout -q -B main origin/main
code=$(run_guard); expect 2 "wrong-branch" "$code"
grep -q 'expected "feature/ai-creative-studio"' /tmp/pf-last-output.txt && echo "PASS  wrong-branch-message" && PASS=$((PASS+1)) || { echo "FAIL  wrong-branch-message"; FAIL=$((FAIL+1)); show_tail 8; }

echo "== scenario 6: dirty working tree (tracked modification) =="
git -C "$TEST" checkout -q feature/ai-creative-studio
echo "dirty" >> "$TEST/docs/M35_DEPLOYMENT_ARCHITECTURE.md"
code=$(run_guard); expect 3 "dirty-tree" "$code"
git -C "$TEST" checkout -q -- docs/M35_DEPLOYMENT_ARCHITECTURE.md

echo "== scenario 7: detached HEAD =="
git -C "$TEST" checkout -q --detach origin/main
code=$(run_guard); expect 2 "detached-head" "$code"
git -C "$TEST" checkout -q feature/ai-creative-studio

echo "== scenario 8: wrong remote (origin points elsewhere) =="
git -C "$TEST" remote set-url origin https://github.com/someone/other-repo.git
code=$(run_guard); expect 1 "wrong-remote" "$code"
git -C "$TEST" remote set-url origin https://github.com/ebinj-dev/Bean-FX.git

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
