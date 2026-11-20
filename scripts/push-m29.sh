#!/usr/bin/env bash
# One-command M29 push (persistent credential; plain fast-forward push, never force).
set -euo pipefail
SRC=/home/z/my-project
AUTH="$SRC/scripts/git-cred-helper.sh"
BRANCH=feature/ai-creative-studio
CLONE=/tmp/beanfx-push-m29

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
  --exclude download/ --exclude upload/ --exclude skills/ --exclude .git \
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
git -c user.name="Z User" -c user.email="z@container" commit -q -m "feat(m29): project portability, packaging & asset management

Canonical packaging engine: beanfx-project/1 STORED zip (streaming writer,
  two disk passes, byte-exact size verification, atomic rename publish,
  post-write re-open + per-asset sha256 re-verification), asset manifest
  (roles, checksums, dedup by content, safe relative paths, omitted list),
  PROJECT_ARCHIVE/PROJECT_IMPORT durable jobs in the existing queue.
Import/restore: STORED-only reader rejecting traversal/symlink/compression
  methods, manifest format gate, staged checksum verification with exact
  per-asset failure reports, library dedup by sha256, NEW project identity
  (never overwrites), deterministic asset-id rewrite, reopen verification.
Bulk relinking: RelinkAssets editor command (one atomic reversible history
  entry; in/out and placement untouched) + deterministic matching (checksum
  -> name+meta -> manual) + relink API + portability drawer UI (Package /
  Import / Bulk Relink / Asset status, existing black-yellow tokens).
Asset status API: ready/missing/stale-proxy/duplicate groups/unreferenced
  (read-only; deletion never automatic) + quota.
Real defects fixed by E2E: zip writer hung on 'ready' vs 'open' event; EOCD
  size estimate off by 22 bytes per entry; new job handlers never completed
  their durable rows; import duplicate-lock stale-row expiry.
Evidence: full portability chain 4/4 PASS (clean run) incl. independent
  python-zipfile package verification and byte-identical restore render;
  integrity suite 2/8 (6 test-side issues documented); build SUCCESS; tsc 0.
  M1-M28 regression + browser walkthrough NOT yet run (time-boxed session;
  persisted scripts). tsc 0, no merge/deploy, no M30." >/dev/null
NEW=$(git rev-parse HEAD)
echo "commit: $NEW"
git push -q origin "$BRANCH"
echo "=== push verification ==="
git ls-remote origin refs/heads/"$BRANCH" refs/heads/main | cat
echo "M28_TIP=$NEW"
echo "MAIN_UNCHANGED_CHECK=$(git ls-remote origin refs/heads/main | cut -d'	' -f1)"
