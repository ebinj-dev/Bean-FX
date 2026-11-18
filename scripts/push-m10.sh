#!/usr/bin/env bash
# One-command M10 push (persistent credential; plain fast-forward push, never force).
set -euo pipefail
SRC=/home/z/my-project
AUTH="$SRC/scripts/git-cred-helper.sh"
BRANCH=feature/ai-creative-studio
CLONE=/tmp/beanfx-push-m10

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
echo "=== M9 commit present in history ==="
git log --oneline -3 | cat

bash "$SRC/scripts/overlay-m10.sh" "$CLONE"

if git status --porcelain | grep -q .; then
  echo "=== secret scan (M10 set) ==="
  if git diff --name-only "$BASE" | while read -r f; do
        case "$f" in *.ttf) continue;; esac
        grep -lE "gho_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9]{20,}|BEGIN (RSA|OPENSSH) PRIVATE KEY" "$f" 2>/dev/null
      done | grep -q .; then
    echo "SECRET SCAN FAILED — aborting push"; exit 1
  fi
  echo "(clean)"
  git add -A
  git -c user.name="Z User" -c user.email="z@container" commit -m "M10 (AI Creative Director & Content Intelligence): evidence-based review, typed recommendations, A/B studio, explainable scorecard, creator assistant

- creative context from REAL services only: timeline head (shared staleness
  formula with the MY AI executor), GANGZII inspections (measured silence
  spans/LUFS/imbalance/clipping — enqueued on the EXISTING worker when absent,
  bounded wait), RIISHE transcripts REUSED from completed autocut-analysis
  results (never re-implemented), parseSrt captions, Studio scenes, M9
  metadata; everything unavailable is listed in missingEvidence — partial
  analysis is honest by construction
- retention intelligence m10-retention-1.0: documented thresholds, every
  finding labeled measured/inferred/ai-interpretation/insufficient-evidence
  with evidence JSON + confidence; measured silence is not automatically a
  bad edit; unclear level classification suppresses silence findings; no hook
  or CTA verdicts from timing alone; RETENTION_DISCLAIMER ships with every
  run — no viewer-retention claims anywhere
- smart recommendations: typed proposals (timeline-commands | engine-action |
  informational) mapped deterministically from findings; executable pause
  removal = SplitClip+SplitClip+RippleDelete built against the live head;
  execution ONLY through M1 validateCommand + M2 applyTimelineEdits
  (optimistic concurrency, new version, undo/redo/autosave intact); stale
  proposals rejected (head moved → STALE, never force-applied); locked tracks
  surface in dry-apply BEFORE any write; per-item approve/preview/reject;
  engine actions route to existing GANGZII/JAZMII/LAXII jobs
- A/B studio: text variants (hook/title/description/cta/narration-section)
  via MY AI with provider seam; thumbnail comparison REUSES M9 LAXII
  candidates; scene-sequence variants only promotable into the approval flow;
  text application writes M9 approved metadata (timeline untouched);
  comparisons labelled creative evaluation — no performance predictions
- explainable scorecard m10-scorecard-1.0: 4 deterministic dimensions with
  formulas stored in the explanation + 4 AI-assessed dimensions; missing data
  → null score + missingData; disclaimer always persisted; deterministic-only
  runs degrade honestly
- creator assistant on MY AI: typed intent routing, fresh-review reuse by
  contextVersion, deterministic quick passes persisted with provider=null,
  durable full-review enqueue, Conversation persistence, honest 503 on
  provider failure — no canned fake analysis, no Ollama
- additive Prisma models CreativeReview/CreativeFinding/CreativeRecommendation/
  CreativeVariant/CreativeScorecard; CREATIVE_REVIEW + CREATIVE_VARIANTS on
  the EXISTING durable worker; audit rows for enqueue/execute/dispatch/apply
- tests: creative-core 28/28 (REAL M1 execution shortens the timeline by
  exactly the measured pause; REAL worker-run GANGZII evidence; stale/locked/
  ownership refusals verified), creative-live 5/5 (REAL glm-4-plus briefs
  EN+TA, REAL GANGZII inspection, honest 'Unknown — no transcript' grounding);
  full matrix 21 suites / 0 failures; tsc/eslint/prisma/production build
  clean; browser-verified end-to-end (review queued from the UI, honest
  insufficient-evidence findings rendered)"
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
