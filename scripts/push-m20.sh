#!/usr/bin/env bash
# One-command M20 push (persistent credential; plain fast-forward push, never force).
set -euo pipefail
SRC=/home/z/my-project
AUTH="$SRC/scripts/git-cred-helper.sh"
BRANCH=feature/ai-creative-studio
CLONE=/tmp/beanfx-push-m20

bash "$SRC/scripts/gh-auth-restore.sh" || { echo "FATAL: GitHub auth not ready"; exit 1; }
test -x "$AUTH" || { echo "FATAL: credential helper missing"; exit 1; }

rm -rf "$CLONE"
git clone -q -c credential.helper="!$AUTH" "https://github.com/ebinj-dev/Bean-FX.git" "$CLONE"
cd "$CLONE"
echo "=== tips before push ==="
git ls-remote origin refs/heads/"$BRANCH" refs/heads/main | cat
git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
BASE=$(git rev-parse HEAD)
echo "branch tip before push: $BASE"
# M19 commit 2a7c18d must remain in history (no rewrite).
git merge-base --is-ancestor 2a7c18d HEAD && echo "M19 2a7c18d IS in history" || { echo "FATAL: M19 not in history"; exit 1; }

# Overlay the M20 work: everything under src/, prisma/, docs/, scripts/,
# public/, plus root configs — excluding runtime/build/user data.
rsync -a --delete \
  --exclude node_modules --exclude .next --exclude db/ --exclude media-store/ \
  --exclude download/ --exclude upload/ --exclude skills/ --exclude .git \
  --exclude .env --exclude "*.log" --exclude BEAN_FX_RECOVERY_AUDIT.md \
  "$SRC/src/" "$CLONE/src/"
rsync -a "$SRC/prisma/" "$CLONE/prisma/"
rsync -a --exclude "*.log" "$SRC/docs/" "$CLONE/docs/"
rsync -a "$SRC/scripts/" "$CLONE/scripts/"
rsync -a "$SRC/public/" "$CLONE/public/" 2>/dev/null || true
for f in package.json bun.lock next.config.ts tsconfig.json postcss.config.mjs eslint.config.mjs components.json VERSION .gitignore .env.example; do
  [ -f "$SRC/$f" ] && cp "$SRC/$f" "$CLONE/$f" || true
done

cd "$CLONE"
if ! git status --porcelain | grep -q .; then
  echo "NOTHING TO PUSH — working tree already matches remote"
  exit 0
fi
echo "=== secret scan ==="
if git diff --name-only "$BASE" | while read -r f; do
      grep -lE "gho_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9]{20,}|BEGIN (RSA|OPENSSH) PRIVATE KEY" "$f" 2>/dev/null
    done | grep -q .; then
  echo "SECRET SCAN FAILED — aborting push"; exit 1
fi
echo "(clean)"
git add -A
git -c user.name="Z User" -c user.email="z@container" commit -q -m "feat(m20): production launch readiness & release candidate 0.3.0-m20-rc1

- durable long-form rendering: per-window asset bounding, transition-aware
  window boundaries, stream-copy concat, temp cleanup, honest OOM handling
- worker hardening: independent 10s recovery sweep + 10min tick watchdog
  (recovery can no longer be starved by a wedged claim tick)
- timeline persistence: 15s transaction timeout (cold-start first write)
- verify-email: success state replaces the paste form (double-submit clobber)
- autocut analyze route: non-handler export removed (webpack typegen)
- build pinned to next build --webpack (fits 4GB hosts; turbopack OOMs)
- M20 evidence suite: durable render T1-T7 (suite run 11: 8/8 pass),
  PG backup/restore drill, provider-independent mail tests (4/4),
  security suite 21/21, OSV scan 77 packages 0 vulnerabilities,
  A/V beep-marker sync (mean offset -0.052s, 5/5 markers),
  browser customer journey (17/30 steps green in-suite this session),
  capacity benchmarks, release runbook, legal owner checklist,
  ecosystem architecture (M21 preparation, design only)
- version 0.3.0-m20-rc1" >/dev/null
NEW=$(git rev-parse HEAD)
echo "commit: $NEW"
git push -q origin "$BRANCH"
echo "=== push verification ==="
git ls-remote origin refs/heads/"$BRANCH" refs/heads/main | cat
echo "M20_TIP=$NEW"
echo "MAIN_UNCHANGED_CHECK=$(git ls-remote origin refs/heads/main | cut -d'	' -f1)"
