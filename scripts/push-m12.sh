#!/usr/bin/env bash
# One-command M12 push (persistent credential; plain fast-forward push, never force).
set -euo pipefail
SRC=/home/z/my-project
AUTH="$SRC/scripts/git-cred-helper.sh"
BRANCH=feature/ai-creative-studio
CLONE=/tmp/beanfx-push-m12

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
echo "=== M11 commit present in history ==="
git merge-base --is-ancestor 076e0aa9dfaf0cf7f8f63cb1a4af5adfd27b72cf HEAD && echo "M11 076e0aa IS in history"

bash "$SRC/scripts/overlay-m12.sh" "$CLONE"

if git status --porcelain | grep -q .; then
  echo "=== secret scan (M12 set) ==="
  if git diff --name-only "$BASE" | while read -r f; do
        case "$f" in *.ttf) continue;; esac
        grep -lE "gho_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9]{20,}|BEGIN (RSA|OPENSSH) PRIVATE KEY" "$f" 2>/dev/null
      done | grep -q .; then
    echo "SECRET SCAN FAILED — aborting push"; exit 1
  fi
  echo "(clean)"
  git add -A
  git -c user.name="Z User" -c user.email="z@container" commit -m "M12 (Visual Intelligence & Semantic Video Understanding): real frame extraction, consent-gated vision understanding, scene indexing, NL footage search, narration-to-visual matching, visual B-roll, continuity intelligence

- frame extraction engine (§2): configurable uniform + scene-based sampling,
  aHash deduplication with dupOf provenance, provider-size scaling, FULL
  provenance per frame (asset, clip, SOURCE-media seconds AND timeline seconds
  via the speed-aware M11 mappers, dimensions, method, status); temp frames in
  MEDIA_ROOT/tmp always cleaned (finally, test-proven); corrupt/unsupported
  media refuses honestly
- vision gateway (§3): provider-independent VisionProvider seam beside the M8
  LLM gateway — zai adapter over the SDK's REAL createVision endpoint
  (base64 data URLs, model glm-4.5v live-verified), typed error
  normalization, real health probe (1x1 JPEG round trip), structured
  FrameAnalysis zod validation with ONE informed repair attempt; nothing
  reads filenames/metadata/transcripts — text-only reasoning can never be
  presented as visual understanding
- scene intelligence (§4): JAZMII deterministic cut boundaries + grouped
  frames → scene records with both clocks, timeline placements, aHash
  similarity + repeated-shot union-find groups, representative frames
  REGISTERED as IMAGE assets through the existing lifecycle (provenance,
  parent link, persistent dir — never the temp sweep zone); every scene
  states semantic vs heuristic-only understanding — a boundary never claims
  content
- NL footage search (§5): project-scoped search over the REAL index;
  provider ranking (validated VisionSearchRanking, EN/TA) with consent,
  deterministic local-keyword fallback labeled honestly, time/asset filters,
  scene thumbnails, direct timeline navigation; unavailable until real
  indexing completed — never fabricated results
- narration-to-visual matching (§6): APPROVED M11 transcript versions ×
  timeline mapping through the transcript's own source asset (embedded audio
  supported) × scene coverage → deterministic coverage + consent-gated
  provider relevance verdicts (ai-interpretation) with missing-data
  warnings; mismatches are observations, never editing errors
- B-roll (§7): measured coverage gaps + analyzed scenes + owned unplaced
  assets → validated AddClip proposals through the approval flow, additive
  laxii-broll-image engine-action routing to the EXISTING LAXII job,
  informational missing-footage notes; no fabricated availability, no
  auto-insertion, undo/redo intact
- continuity (§8): repeated shots (aHash), rapid cuts, static/black sections,
  aspect changes (measured) separated from consent-gated composition
  interpretation (ai-interpretation); camera movement/emotion/cinematography
  quality explicitly NOT claimed
- Visual tab (§9): scene browser with REAL registered thumbnails, frame
  evidence inspector, search, narration match, continuity review, consent
  controls with exact disclosure, open-in-timeline seek; all M10/M11 tabs
  preserved
- jobs/versioning (§10): VISUAL_INTELLIGENCE on the EXISTING worker (45 min,
  per-user 1); whole-run dedup (identical deps => stored index REUSED, no
  re-extraction no provider calls — tested), fingerprint invalidation with
  reasons (asset mtime, timeline version, settings, provider/model),
  per-call AIUsage recording; artifacts on the EXISTING
  CreativeAnalysisArtifact model — ZERO schema changes
- privacy (§11): frames leave the server ONLY with explicit per-run consent
  (deterministic-only otherwise, stated honestly); scaled JPEG frames only,
  never full videos; credentials server-side; no Ollama
- API: /api/creative/visual/index (GET/POST), /api/creative/visual/search
  (POST) — auth, ownership, zod, version checks, audit rows
- tests: visual-core 22/22 (REAL extraction/dedup/scenes/M1-M2 b-roll
  insertion through the real engine, stub vision labeled), visual-live 3/3
  REAL providers (glm-4.5v described REAL frames with KNOWN visible content:
  'BEAN FX' text read back exactly; consent-gated job + provider-ranked
  search top-verified; TTS→REAL ASR→glm-4.5v honest 'unrelated' verdict
  citing SMPTE bars); full matrix 26 suites / 0 failures; tsc/eslint clean;
  prisma validate valid (no schema change); production build ✓"
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
