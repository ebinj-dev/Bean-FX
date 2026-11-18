#!/usr/bin/env bash
# One-command M11 push (persistent credential; plain fast-forward push, never force).
set -euo pipefail
SRC=/home/z/my-project
AUTH="$SRC/scripts/git-cred-helper.sh"
BRANCH=feature/ai-creative-studio
CLONE=/tmp/beanfx-push-m11

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
echo "=== M10 commit present in history ==="
git merge-base --is-ancestor a2659e5354691ecfeac2d6ab30a85f33623c6964 HEAD && echo "M10 a2659e5 IS in history"

bash "$SRC/scripts/overlay-m11.sh" "$CLONE"

if git status --porcelain | grep -q .; then
  echo "=== secret scan (M11 set) ==="
  if git diff --name-only "$BASE" | while read -r f; do
        case "$f" in *.ttf) continue;; esac
        grep -lE "gho_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9]{20,}|BEGIN (RSA|OPENSSH) PRIVATE KEY" "$f" 2>/dev/null
      done | grep -q .; then
    echo "SECRET SCAN FAILED — aborting push"; exit 1
  fi
  echo "(clean)"
  git add -A
  git -c user.name="Z User" -c user.email="z@container" commit -m "M11 (Multimodal Intelligence & Advanced Smart Editing): unified analysis, embedded audio, integrated transcription, cross-modal findings, multi-clip pause surgery, plan preview, analysis versioning

- unified multimodal observations (§2): every record carries project/version/
  asset/clip ids, SOURCE-media time AND timeline time explicitly, method,
  evidence type, confidence and status; frame-exact speed-aware source<->timeline
  mapping (round-trip tested); missing/unsupported/corrupt streams become honest
  observations, never inventions
- embedded audio (§3): ffprobe stream detection (multi-stream, indexes),
  derived extraction via existing media infra (source NEVER modified, provenance
  registered in the existing asset lifecycle), GANGZII inspection on the EXISTING
  worker with dedup (repeat runs re-use the inspection and extract nothing),
  silence mapped back to timeline clips through VIDEO-track placements; no-audio
  and corrupt files reported honestly
- integrated RIISHE transcription (§4): reuses transcribeWithAsr (same provider
  adapters), TranscriptVersion rows with detected language (never assumed),
  chunk-level REAL timestamps, wordsAvailable=false honesty, dependency
  fingerprints + stale detection with reasons, approval flow that creates a NEW
  SRT asset — pre-existing captions are never overwritten (tested)
- cross-modal analysis (§5): REAL local scene analysis via JAZMII's deterministic
  ffmpeg scene/black/freeze detector (model-observed, nothing uploaded) combined
  with measured audio/speech/captions/timeline: speech-across-cut,
  narration-without-visuals, visuals-without-narration, static-visuals,
  caption-mismatch (measured overlap, inferred verdict), av-sync drift, audio
  gaps; without real frame analysis visual findings are insufficient-evidence
  with an explicit no-metadata-claims statement (tested)
- multi-clip pause surgery (§6): deterministic frame-exact planner over M1
  commands — single-clip and CROSS-CLIP junction removals (Trim+Trim+Move chain),
  overlap merging, configurable minPause/minRetainedGap/maxRemovals, locked-track
  and transition refusals, caption warnings, descending-order validity;
  execution ONLY through the M10 approval flow -> applyTimelineEdits as ONE
  versioned batch (atomic, undo/redo intact, stale-rejected); silence is never
  removed automatically
- preview & simulation (§8): in-memory plan simulation (before/after clip lists,
  exact duration delta, cuts, moved clips, cross-track and caption warnings) via
  commands/recommendation/pause-surgery API modes — no writes ever, labeled a
  structural simulation rather than a render
- evidence-linked UI (§9): evidence filter chips (audio/speech/captions/visuals/
  pacing/sync/technical), open-in-timeline seek from findings and
  recommendations, per-rec preview rendering, integrated-transcripts approval
  block, Multimodal scope; all M10 tabs preserved
- analysis versioning (§10): CreativeAnalysisArtifact dependency fingerprints
  (asset mtime/size, timeline contextVersion, thresholds, provider/model) with
  depsHash dedup (reuse instead of recompute — tested), stale invalidation WITH
  reasons, transcript version staleness; two new job types CREATIVE_MULTIMODAL +
  TRANSCRIBE_PROJECT on the EXISTING worker
- privacy (§11): consentVisual gates external visual interpretation; local scene
  analysis uploads nothing; source media never mutated; temp cleanup tested;
  ownership on every path
- additive schema: CreativeAnalysisArtifact + TranscriptVersion; API
  /api/creative/analyze/unified, /analyze/transcripts(+/[id]), /plans/preview;
  tsconfig excludes the untracked user folder BEAN-FX-Source-Export
- tests: multimodal-core 26/26 (REAL cross-clip surgery executed through M2,
  REAL embedded-audio pipeline, REAL local scene analysis, dedup/staleness/
  recovery proven), multimodal-live 5/5 REAL providers (ZAI TTS speech -> REAL
  ASR exact transcript; Tamil handled honestly; GANGZII LUFS -20.3; scene cuts/
  black/freeze/drift; full CREATIVE_MULTIMODAL job); matrix 24 suites / 0
  failures; tsc/eslint/prisma/production build clean; browser E2E: multimodal
  review queued+completed from the UI with honest evidence"
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
