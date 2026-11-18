#!/usr/bin/env bash
# One-command M9 push (persistent credential; plain fast-forward push, never force).
set -euo pipefail
SRC=/home/z/my-project
AUTH="$SRC/scripts/git-cred-helper.sh"
BRANCH=feature/ai-creative-studio
CLONE=/tmp/beanfx-push-m9

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
echo "=== M8.1 commit present in history ==="
git log --oneline -5 | cat

bash "$SRC/scripts/overlay-m9.sh" "$CLONE"

if git status --porcelain | grep -q .; then
  echo "=== secret scan (M9 set) ==="
  if git diff --name-only "$BASE" | while read -r f; do
        case "$f" in *.ttf) continue;; esac
        grep -lE "gho_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9]{20,}|BEGIN (RSA|OPENSSH) PRIVATE KEY" "$f" 2>/dev/null
      done | grep -q .; then
    echo "SECRET SCAN FAILED — aborting push"; exit 1
  fi
  echo "(clean)"
  git add -A
  git -c user.name="Z User" -c user.email="z@container" commit -m "M9 (Professional Publishing & Creator Workflow): publishing workspace — thumbnails, metadata, brand presets, export variants, packages

- publishing panel in the editor (Exports / Thumbnail / Metadata / Brand /
  Package) on the existing design language; no publishing buttons anywhere —
  integrations investigated and reported honestly as not-configured
  (YouTube Data API / Instagram Content Publishing / TikTok Content Posting
  requirements documented in docs/M9_PROFESSIONAL_PUBLISHING.md §9)
- export profiles registry v2026.11.13: YouTube landscape/Shorts (official
  SDR bitrates, AAC-LC 48kHz, Shorts 180s cap from official help), Instagram
  Reels, TikTok, square + custom — constraints encoded ONLY from verified
  platform docs, sources recorded per profile; no-cap platforms encode NO cap;
  versioned + configurable (BEANFX_EXPORT_PROFILES_JSON full override,
  schema-validated)
- multi-platform export variants: server-side ffmpeg args (scale+pad, no
  crop), real ffprobe pre-flight (422 with typed failures) + post-encode
  conformance checks (dims/codec/pixfmt/sample-rate/fps/duration); durable
  EXPORT_VARIANT jobs on the EXISTING M3 worker (progress, cancel, retry,
  history); masters untouched; result = ExportFile + validationJson
- Thumbnail Studio via LAXII: alternatives at closest supported provider size,
  full provenance, selection preserved; editable title overlay composited
  server-side (PIL+raqm, Tamil shaping via bundled Noto Sans Tamil) into NEW
  assets at exact platform dims; per-layer image editing honestly unsupported
- AI metadata via MY AI: validated structured output (title, description,
  keywords, hashtags, chapters, summary, platform description, CTA) from real
  project context; EN + TA; chapters ONLY from verified scene timings
  (fabricated timestamps stripped — tested); per-field regeneration;
  AI suggestions (draft) vs USER-APPROVED stored separately; honest
  unavailable-provider state (503, never placeholder text)
- brand presets: CRUD + duplicate + additive-merge apply with preview and
  explicit confirm; audit-backed revert; approved content never silently
  modified
- publication packages: deterministic zip (stored, fixed timestamps, sorted)
  + manifest with per-file sha256 and exclusions policy; USER-APPROVED
  metadata only; no private source media/credentials; independently verified
  with python zipfile in tests and E2E
- additive Prisma models BrandPreset / ThumbnailDraft / PublishMetadata /
  ExportVariant / PublishPackage; chatValidated gained an additive optional
  provider seam (default behavior unchanged)
- tests: publish-core 27/27 (fixture/engine, injected stubs labeled),
  publish-live 5/5 (REAL glm-4-plus EN+TA metadata, real scene-timing
  chapters, REAL LAXII thumbnail asset); full matrix 20 suites / 0 failures;
  E2E over HTTP 28/28 with real providers (preset apply/revert, LAXII
  thumbnail, LLM metadata, variant conformance, package manifest integrity);
  tsc / eslint(src) / prisma / production build clean"
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
echo "=== pushed files ==="
git diff --name-only "$BASE" HEAD
echo "PUSH_COMPLETE"
