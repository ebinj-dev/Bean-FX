# M33 — END-TO-END PRODUCTION ACCEPTANCE (Track D)

**Result: 4/5 tests pass on a fresh server (VERIFIED for the executed steps); the final package+import step failed on a TEST-ONLY archiveId extraction bug — fixed in `test-m33-acceptance.test.ts` but not re-verified before the session cutoff (NOT RUN after the fix).**

## Scenario (real workflow, no bypasses)

One campaign with: product description + feature evidence (real 720×1280 screenshot + 8s demo video WITH audio) → approved concept → approved storyboard → REAL subject mask (imported, validated) → REAL FFmpeg mask compositing (subject over background video) → composited asset added to the campaign timeline via CANONICAL commands (AddTrack + AddClip, overlay INSIDE the approved duration) → review render → approval → FINAL_RENDER → QA → delivery → 16:9 + 1:1 variants derived and rendered.

## What was proven

- Campaign chain with approvals: PASS (intake → … → TIMELINE_ASSEMBLY).
- Mask compositing through `/api/masks` (import → validate → composite-video): PASS — composited MediaAsset registered, then placed on the timeline through the EDITOR command endpoint (no direct JSON writes).
- QA honesty (from an earlier run): adding the composited clip BEYOND the approved duration was **correctly rejected** by the QA duration gates ("duration-matches-brief, render-duration" FAILED) — the test was corrected to composite as an overlay within the approved window.
- Master render + QA + delivery with the composited subject: PASS (35s on a fresh server).
- Three-format variants rendered: PASS.
- Poster + share copy: recorded as delivery artifacts (`acceptance-delivery.json`).

## Infrastructure notes (honest)

- One review render was killed by the system (SIGKILL — OOM, 4 GB sandbox) while suites ran in parallel; the worker recorded it honestly and the retry on a fresh server succeeded. **Runs of render-heavy suites must be serial in this environment.**
- A stale PROJECT_ARCHIVE row from an interrupted run was recovered by the worker ("Recovered after a worker interruption") — recovery behavior observed working.

## Remaining manual steps

1. Re-run `test-m33-acceptance.test.ts` alone on a fresh server → expect 5/5 (extraction bug fixed).
2. (Owner) provider credentials for live generation; automatic segmentation remains CONFIGURATION REQUIRED.
