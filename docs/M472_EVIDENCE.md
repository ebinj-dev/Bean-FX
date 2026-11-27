# M47.2 — RELEASE INTEGRITY & PRODUCTION PROOF (evidence summary)

Branch `feat/m472-release-integrity` from verified main `4c44777572d6f30690a128df3a7a092c27c27874`.
Commits: A `8348454` · B `222bb37` · C `a9e429e` · D (this commit). All pushed and remote-SHA-verified.

## A. M46.1 render integrity hotfix (commit 8348454)

**Root cause (traced through the full pipeline):** the ≤240 s render path allocated ffmpeg inputs
into a reference-keyed `Map<RenderClipPlan, …>`, but `buildTimelineGraph` re-collects plans
(fresh objects) — every lookup missed and the graph fell back to an asset map the caller never
populated. All plans were filtered out; the render produced a **valid H.264/AAC container with
black frames and silence**.

**Fix:** stable content-keyed plan identity (`planOccurrenceKey`), ONE allocation routine used by
both render paths (`allocateRenderInputs`), and loud invariants: missing asset rows / missing
source files / unresolved plans abort the render BEFORE ffmpeg runs — never black output.

**Real-media matrix — 11/11 (`scripts/test-m472-render-matrix.test.ts`, live server):**

| Case | Content check (decoded pixels + volumedetect, not exit codes) |
|---|---|
| A motion+original audio | spatial spread > 50 (real moving imagery), audio max −17.2 dB |
| B muted source audio | digital silence −91 dB, video content intact |
| C source reused 3× | each range shows ITS imagery (red/green/blue mapped) |
| D distinct sources | segments pairwise-distinct |
| E video(audio)+music | summed mix (higher level than F) |
| F video-only+music | music-only level math holds, video present |
| G audio-only WAV | no video stream, PCM, real signal |
| H image base+overlay | red then blue window composition |
| I cross-dissolve | mid-frame is a real blend (not pure, not black) |
| J long-form 252 s | windowed path, content correct across three windows |
| K negative | missing asset FAILS the job clearly — never black output |

Evidence: `/download/m472-evidence/render-matrix/` (case JSONs + rendered outputs).
Also green: 9 mapping unit tests, 19/19 m16-core, 15/15 m18 pixel-parity, m37 golden graphs, tsc, build.

## B. Complete dependency-instance audit (commit 222bb37)

995 lockfile entries → **577 production instances** (540 unique names; 40 nested, 40 at versions
differing from the top-level copy) + 418 dev instances (separated, SBOM scope `excluded`, not omitted).
License evidence: installed copy → npm registry (exact name@version, 159 lookups) → UNRESOLVED
(0 remain). Classification: 561 PERMISSIVE / 14 COPYLEFT-WEAK (libvips LGPL) / 2 NON-STANDARD
(nodebox Sustainable Use — excluded from commercial distribution; W3C-20150513).
**New integrity finding:** `nodemailer@^10.6.0` declared in package.json but ABSENT from the
lockfile — `npm ci` fails; flagged RESOLVE (regenerate lockfile or drop the declaration).
16/16 audit tests (full lockfile↔audit reconciliation, no collapsing, SBOM structure).
Regenerated: audit JSON, CycloneDX SBOM (995 components, unique bom-refs), inventory, notices,
risk report, `/open-source` page. Evidence: `/download/m472-evidence/13-open-source-instance-model.png`.

## C. Registration acknowledgement (commit a9e429e)

The UI's draft-terms acknowledgement is now enforced server-side: `acceptedDraftTerms` must be
exactly `true` — missing/false/string → 400 (the error itself states the draft status). Tests
4/4 (bypass attempts refused). Factual acknowledgement of DRAFT documents only: no binding consent
record, no policy version, acceptance tracking still deferred until owner-approved final terms.
Live UI evidence: `/download/m472-evidence/14-register-acceptance-gate-m472.png`.

## D. End-to-end journey (partial — documented honestly)

Verified live (screenshots + JSON in `/download/m472-evidence/`):
public homepage, Open Source Center (instance model), Legal Center, register gate (disabled until
the checkbox), real upload with project association + ownership read-back (step-8-ownership.json),
RIISHE chat with the REAL LLM (mode `llm`, model `glm-4-plus` disclosed — step-9-riishe-chat.json),
production creation from that conversation (13 stages, step-10-production.json), pipeline advancing
INTAKE→BRIEF→CONCEPT with real approval semantics (pipeline-poll.log).

**Remaining blocker (not fabricated):** the full automated walk to FINAL_RENDER through the
production pipeline stops at the CONCEPT approval decision — `POST /api/productions/[id]` returns
405 (no POST export in that route); the concept-selection endpoint needs to be located/added
(the UI performs the same selection through Studio Chat's board). The DIRECT render path the
journey ultimately exercises is fully proven by matrix case J + the M46.1 battery.

## Known limitations

- Tamil/Tanglish remain marked unverified (M47.1 evidence: provider returns unusable output).
- Audible playback not testable in this environment (no audio device) — byte/decode/signal-level proof instead.
- The production-pipeline E2E walk stops at the CONCEPT decision endpoint (above).
- The `nodemailer` lockfile gap and the nodebox/FFmpeg license questions await owner decisions.
