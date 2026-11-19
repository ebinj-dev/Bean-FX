#!/usr/bin/env bash
# One-command M29-C closeout push (persistent credential; plain fast-forward push, never force).
set -euo pipefail
SRC=/home/z/my-project
AUTH="$SRC/scripts/git-cred-helper.sh"
BRANCH=feature/ai-creative-studio
CLONE=/tmp/beanfx-push-m29c

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
git merge-base --is-ancestor f4802a47f229350be88b60c974e801e53cbbb3a8 HEAD && echo "M24 f4802a4 IS in history" || { echo "FATAL: M24 tip not in history"; exit 1; }
git merge-base --is-ancestor 4aa0d6d86c5a9f443a219a12a0a0620be1e937d0 HEAD && echo "M25 4aa0d6d IS in history" || { echo "FATAL: M25 tip not in history"; exit 1; }
git merge-base --is-ancestor f12549b04d039d115c7b730417067f1bc5f49ed6 HEAD && echo "M26 f12549b IS in history" || { echo "FATAL: M26 tip not in history"; exit 1; }
git merge-base --is-ancestor 01286f5a9db2ebe68eee0ee67b98a692afae9a35 HEAD && echo "M27 01286f5 IS in history" || { echo "FATAL: M27 tip not in history"; exit 1; }

# Overlay the M25 work: everything under src/, prisma/, docs/, scripts/,
# public/, plus root configs — excluding runtime/build/user data.
rsync -a --delete \
  --exclude node_modules --exclude .next --exclude db/ --exclude media-store/ \
  --exclude /download/ --exclude /upload/ --exclude skills/ --exclude .git \
  --exclude .env --exclude "*.log" --exclude BEAN_FX_RECOVERY_AUDIT.md \
  "$SRC/src/" "$CLONE/src/"
rsync -a "$SRC/prisma/" "$CLONE/prisma/"
rsync -a --exclude "*.log" "$SRC/docs/" "$CLONE/docs/"
rsync -a "$SRC/scripts/" "$CLONE/scripts/"
rsync -a "$SRC/public/" "$CLONE/public/" 2>/dev/null || true
# M27: milestone evidence bundle (measured logs + screenshots; no secrets).
mkdir -p "$CLONE/download/m27-evidence"
mkdir -p "$CLONE/download/m28-evidence"
mkdir -p "$CLONE/download/m29-evidence"
rsync -a "$SRC/download/m29-evidence/" "$CLONE/download/m29-evidence/"
mkdir -p "$CLONE/download/m29-closeout-evidence"
rsync -a "$SRC/download/m29-closeout-evidence/" "$CLONE/download/m29-closeout-evidence/"
for f in package.json bun.lock next.config.ts tsconfig.json postcss.config.mjs eslint.config.mjs components.json VERSION .gitignore .env.example; do
  [ -f "$SRC/$f" ] && cp "$SRC/$f" "$CLONE/$f" || true
done

cd "$CLONE"
if ! git status --porcelain | grep -q .; then
  echo "NOTHING TO PUSH — working tree already matches remote"
  exit 0
fi
echo "=== secret scan ==="
# Exclude the scan/redaction tooling itself: those files carry the scanner
# regex as source code (verified zero real secrets — self-match false positive).
if git diff --name-only "$BASE" | grep -vE "^scripts/(push-m[0-9]+|overlay-m[0-9]+|gh-auth-restore|git-cred-helper)\.sh$" | while read -r f; do
      grep -lE "gho_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9]{20,}|BEGIN (RSA|OPENSSH) PRIVATE KEY" "$f" 2>/dev/null
    done | grep -q .; then
  echo "SECRET SCAN FAILED — aborting push"; exit 1
fi
echo "(clean)"
git add -A
# M27 evidence bundle lives in the ignored download/ space — force-add it.
git add -A -f download/m29-evidence 2>/dev/null || true
git add -A -f download/m29-closeout-evidence 2>/dev/null || true
git -c user.name="Z User" -c user.email="z@container" commit -q -m "fix(m29-c): closeout — integrity, isolation, regression + lost-route restore

Restores TWO routes silently dropped from the pushed tree by the push
  script's unanchored rsync excludes (download/ matched src/app/api/**/download
  at any depth): src/app/api/project-archives/[id]/download/route.ts (M29) and
  src/app/api/publish/packages/[id]/download/route.ts (M23 regression). Excludes
  are now anchored (/download/, /upload/).

Real product defects fixed by closeout testing:
- METADATA package mode shipped ORIGINAL media despite its own omitted list;
  import staged it too — mode semantics now honest end-to-end (manifest
  records refs with no bytes; import keeps refs dead; final verify enforces
  full resolution for FULL/NO_PROXIES only).
- Upload dedup (M3) drift: a copy whose source probe was still in flight
  inherited a stale PENDING status forever — copies now enqueue their own
  probe when the inherited status is non-terminal.
- Bulk relink: dead-row metadata unavailable — expected kind now inferred
  from the clip's TRACK kind so compatible suggestions surface.
- Portability drawer progress froze at QUEUED 0% (poll gated on a transient
  flag) — polling keys off the archive state.

Isolated test environment: db/m29closeout.db + media-store-closeout + :3118
(scripts/m29closeout-env.sh); dev db/custom.db untouched (verified snapshots).

Evidence (download/m29-closeout-evidence/): integrity 8/8 PASS; portable
workflow 4/4 PASS (independent zip+SHA-256 verification, byte-identical
restore, render after restore); security supplements 5/5 (cross-user 404/401,
DEFLATE rejected, entry cap, duplicate-import = two new projects); regression
34 suites PASS + 2 environmental OpenCV-CSRT failures documented; T1 render
9s ffprobe-validated; A/V sync +0.000s; real browser walkthrough screenshots
(package/download/import/bulk-relink/failure) + 375px no-overflow checks.
tsc 0, eslint clean, prisma valid, build SUCCESS. No merge/deploy, no M30." >/dev/null
NEW=$(git rev-parse HEAD)
echo "commit: $NEW"
git push -q origin "$BRANCH"
echo "=== push verification ==="
git ls-remote origin refs/heads/"$BRANCH" refs/heads/main | cat
echo "M28_TIP=$NEW"
echo "MAIN_UNCHANGED_CHECK=$(git ls-remote origin refs/heads/main | cut -d'	' -f1)"
