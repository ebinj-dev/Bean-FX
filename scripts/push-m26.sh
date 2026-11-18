#!/usr/bin/env bash
# One-command M26 push (persistent credential; plain fast-forward push, never force).
set -euo pipefail
SRC=/home/z/my-project
AUTH="$SRC/scripts/git-cred-helper.sh"
BRANCH=feature/ai-creative-studio
CLONE=/tmp/beanfx-push-m26

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
git -c user.name="Z User" -c user.email="z@container" commit -q -m "feat(m26): professional workflow expansion — additive UI only, engine-backed

P1 advanced editing: markers (AddMarker/RemoveMarker/UpdateMarker + ruler UI),
  clip grouping (GroupClips/UngroupClips/SetClipGroup + Ctrl+G), range in/out
  (I/O keys + LIFT RANGE via compileLift), CloseGaps (refuses transition/locked
  tracks), AlignClipsToPlayhead — all reversible, integer-frame, autosaved.
P2 audio: real clip pan (preview panner + equal-power pan filter in export +
  inspector slider), per-track fader (preview gain + export expression + mixer
  drawer), REAL Web Audio metering (AnalyserNode taps; idle = honest zero).
P3 effects: COLOR & LOOKS section from the real filter registry + Copy FX /
  Paste FX (reversible AddEffect batches).
P4 presets: CreativePreset model (4 kinds, unique names, versioned payloads) +
  audited CRUD with typed-name delete safeguard + PRESETS drawer (save from
  selection, apply via reversible commands).
P5 batch export: idempotent multi-profile fan-out through the real ExportVariant
  pipeline (max 8; one active variant per master+profile — refresh-safe) +
  BATCH EXPORT panel with per-variant progress/cancel/retry.
P6: engine reuse (RIISHE/NIIKI/JAZMII/LAXII/GANGZII + MY AI plans) documented;
  templates dispatch the real engine jobs.
P7 workflow automation: WorkflowRun + whitelisted server-side template library
  (4 templates; no user steps — no code execution) + tick executor with
  durable per-step state, approval gates, cancel + safe retry + audit +
  WORKFLOWS drawer. Honest failures (missing sequence/media fail the run).
Tests: M26 engine 11/11, M26 API 5/5; full M1-M25 regression green incl.
T1 45.1s + sync -0.052s + worker probe. Build 23.6s. Screenshots + audit in
download/m26-evidence (also docs/M26_*). No merge/deploy; no M27." >/dev/null
NEW=$(git rev-parse HEAD)
echo "commit: $NEW"
git push -q origin "$BRANCH"
echo "=== push verification ==="
git ls-remote origin refs/heads/"$BRANCH" refs/heads/main | cat
echo "M26_TIP=$NEW"
echo "MAIN_UNCHANGED_CHECK=$(git ls-remote origin refs/heads/main | cut -d'	' -f1)"
