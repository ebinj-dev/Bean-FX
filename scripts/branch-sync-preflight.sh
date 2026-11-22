#!/usr/bin/env bash
# =============================================================================
# Bean FX — Branch Synchronization Preflight Guard
# =============================================================================
#
# READ-ONLY GUARD: verifies that the working branch is the primary BEAN FX
# development branch and that it contains the complete latest remote `main`
# history BEFORE a milestone is started or a publication is pushed.
#
# This script NEVER modifies files, NEVER merges, NEVER rebases, NEVER
# commits, and NEVER pushes. The only repository state it touches is remote-
# tracking refs via `git fetch` (explicitly required to get current SHAs).
#
# Usage:
#   bash scripts/branch-sync-preflight.sh [--no-fetch]
#
#   --no-fetch   Skip `git fetch` (uses the last fetched remote-tracking
#                refs). Only for offline inspection; always run a full check
#                (with fetch) before starting a milestone or publishing.
#
# Exit codes:
#   0  Synchronized — branch is up to date with origin/main (safe to proceed)
#   1  Remote/fetch failure — cannot verify synchronization (do not proceed)
#   2  Wrong branch or detached HEAD
#   3  Uncommitted tracked changes in the working tree
#   4  Behind origin/main (main has commits this branch lacks; clean merge)
#   5  Diverged from origin/main (main advanced AND branch has own commits)
#   6  Local branch is behind its own upstream origin/feature/ai-creative-studio
#
# Policy: docs/GIT_BRANCH_SYNC_POLICY.md
# Run before starting any milestone work and immediately before every push.
# =============================================================================

set -u

EXPECTED_BRANCH="feature/ai-creative-studio"
EXPECTED_REPO_MARK="ebinj-dev/Bean-FX"
MAX_COMMIT_LIST=100

NO_FETCH=0
[ "${1:-}" = "--no-fetch" ] && NO_FETCH=1

say()  { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }

# --- 0. Locate the repository -------------------------------------------------
REPO="$(git rev-parse --show-toplevel 2>/dev/null)" \
  || die "Not inside a Git work tree. cd into the Bean FX clone and retry."
G() { git -C "$REPO" "$@"; }

say "=============================================================="
say "BEAN FX branch-sync preflight ($(date -u '+%Y-%m-%dT%H:%M:%SZ'))"
say "repo: $REPO"
say "=============================================================="

# --- 1. Verify the expected remote -------------------------------------------
REMOTE_URL="$(G remote get-url origin 2>/dev/null)" \
  || die "No 'origin' remote configured. Add origin (github.com/ebinj-dev/Bean-FX.git) first."
case "$REMOTE_URL" in
  *"$EXPECTED_REPO_MARK"*)
    say "[ok] origin -> $REMOTE_URL"
    ;;
  *)
    die "origin ('$REMOTE_URL') is not the BEAN FX repository ($EXPECTED_REPO_MARK). Refusing to evaluate an unknown remote."
    ;;
esac

# --- 2. Verify the current branch ---------------------------------------------
BRANCH="$(G symbolic-ref --short -q HEAD 2>/dev/null)"
if [ -z "$BRANCH" ]; then
  printf '\nFAIL: HEAD is detached (no branch checked out), expected "%s".\n' "$EXPECTED_BRANCH" >&2
  say "Corrective action:  git checkout $EXPECTED_BRANCH" >&2
  say "Do not run milestone work or publish from a detached HEAD." >&2
  exit 2
fi
if [ "$BRANCH" != "$EXPECTED_BRANCH" ]; then
  printf '\nFAIL: current branch is "%s", expected "%s".\n' "$BRANCH" "$EXPECTED_BRANCH" >&2
  say  "Never switch to a different feature branch silently and never mix branches." >&2
  say  "Corrective action:  git checkout $EXPECTED_BRANCH" >&2
  say  "(If you have local work on this branch, commit or move it deliberately first.)" >&2
  exit 2
fi
say "[ok] current branch: $BRANCH"

# --- 3. Detect uncommitted changes --------------------------------------------
# Tracked modifications (staged or unstaged) are a hard stop. Untracked files
# are only a warning (they are not overwritten by a merge unless they collide).
DIRTY_TRACKED="$(G status --porcelain --untracked-files=no | wc -l | tr -d ' ')"
UNTRACKED="$(G status --porcelain | grep -c '^??' || true)"
if [ "$DIRTY_TRACKED" != "0" ]; then
  printf '\nFAIL: %s uncommitted tracked change(s) in the working tree:\n' "$DIRTY_TRACKED" >&2
  G status --short --untracked-files=no >&2
  say "Resolve them deliberately (commit on $EXPECTED_BRANCH, or move them away)." >&2
  say "This guard never stashes, discards, or commits on your behalf." >&2
  exit 3
fi
if [ "${UNTRACKED:-0}" != "0" ]; then
  warn "$UNTRACKED untracked file(s) present (not blocking, but review before merging/pushing)."
fi

# --- 4. Fetch latest remote references (the ONLY state this script updates) ----
if [ "$NO_FETCH" = "1" ]; then
  warn "--no-fetch: evaluating STALE remote-tracking refs (offline mode)."
else
  say "[..] fetching origin (--prune) ..."
  if ! G fetch origin --prune >/dev/null 2>&1; then
    G fetch origin --prune 2>&1 | head -5 >&2 || true
    die "git fetch origin failed. Check network/credentials, fix access, and re-run. Do not start milestone work or push while fetch fails (exit 1)."
  fi
  say "[ok] fetched latest remote refs"
fi

MAIN_SHA="$(G rev-parse origin/main 2>/dev/null)" \
  || die "origin/main not found after fetch (exit 1)."
FEATURE_UPSTREAM_SHA="$(G rev-parse "origin/$EXPECTED_BRANCH" 2>/dev/null)" \
  || die "origin/$EXPECTED_BRANCH not found after fetch (exit 1)."
LOCAL_SHA="$(G rev-parse HEAD)"

say ""
say "local $EXPECTED_BRANCH      : $LOCAL_SHA"
say "origin/$EXPECTED_BRANCH : $FEATURE_UPSTREAM_SHA"
say "origin/main             : $MAIN_SHA"

# --- 5. Local branch vs its own upstream ---------------------------------------
BEHIND_UPSTREAM="$(G rev-list --count "HEAD..origin/$EXPECTED_BRANCH")"
if [ "$BEHIND_UPSTREAM" != "0" ]; then
  printf '\nFAIL: local %s is %s commit(s) BEHIND origin/%s.\n' "$EXPECTED_BRANCH" "$BEHIND_UPSTREAM" "$EXPECTED_BRANCH" >&2
  say "Another contributor advanced the remote feature branch. Integrate before working:" >&2
  say "  git merge --ff-only origin/$EXPECTED_BRANCH   # if you have no local commits yet" >&2
  say "  git merge origin/$EXPECTED_BRANCH             # normal merge if you do (never rebase)" >&2
  exit 6
fi
say "[ok] local branch is in sync with its upstream"

# --- 6. Ahead / behind vs origin/main ------------------------------------------
# `rev-list --left-right --count A...B` prints "<only-in-A><TAB><only-in-B>",
# i.e. LEFT = commits only in HEAD (= ahead), RIGHT = commits only in
# origin/main (= behind). Verified against a known-ahead clone before publish.
COUNTS="$(G rev-list --left-right --count "HEAD...origin/main")"
AHEAD="${COUNTS%%	*}"
BEHIND="${COUNTS##*	}"
say ""
say "vs origin/main: behind = $BEHIND commit(s), ahead = $AHEAD commit(s)"

if [ "$BEHIND" != "0" ]; then
  say ""
  say "Commits present in origin/main but MISSING from this branch:"
  G log --oneline --no-decorate "HEAD..origin/main" | head -"$MAX_COMMIT_LIST"
  LEFT="$(G rev-list --count "HEAD..origin/main")"
  if [ "$LEFT" -gt "$MAX_COMMIT_LIST" ]; then
    say "(... $((LEFT - MAX_COMMIT_LIST)) more)"
  fi
  say ""
  if [ "$AHEAD" = "0" ]; then
    printf 'FAIL: branch is %s commit(s) BEHIND origin/main (no local-only commits).\n' "$BEHIND" >&2
    say "A safe fast-forward exists. Corrective action:" >&2
    say "  git merge --ff-only origin/main" >&2
    say "Then re-run this script; it must exit 0 before any milestone work or push." >&2
    exit 4
  else
    printf 'FAIL: branch DIVERGED from origin/main (behind %s, ahead %s).\n' "$BEHIND" "$AHEAD" >&2
    say "Integration requires a NORMAL MERGE COMMIT. Corrective action:" >&2
    say "  git merge origin/main          # regular merge; NEVER rebase, NEVER reset --hard" >&2
    say "  # resolve conflicts file by file after reading BOTH implementations;" >&2
    say "  # never take 'ours'/'theirs' wholesale; never delete tests to pass." >&2
    say "  # then re-run affected regression tests and this script." >&2
    exit 5
  fi
fi

# --- 7. Synchronized ------------------------------------------------------------
say ""
say "[ok] SYNCHRONIZED: this branch contains the complete origin/main history."
say "     (ahead of origin/main by $AHEAD local commit(s) — normal development state)"
say ""
say "Reminder: fetch + re-run this check again immediately before committing/pushing;"
say "main may have advanced while you worked (docs/GIT_BRANCH_SYNC_POLICY.md, section 3)."
say ""
say "This script modified nothing (read-only; only remote-tracking refs via fetch)."
exit 0
