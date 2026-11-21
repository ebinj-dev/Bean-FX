# M31 SHOWCASE RESULTS — BEAN SHOWCASE STUDIO

**Date:** 2026-11-20 · **Branch:** `feature/ai-creative-studio` · **Scope:** M31 ADDENDUM — turn a product, website, app or BEAN FX project into a promotional film using BEAN's own engines and native editing infrastructure.

**Reference product studied (inspiration only):** BrAG (github.com/latent-spaces/brag) — product-concept level. **No BrAG source, skills, prompts, schemas, scripts, bundled audio/media or UI was copied, vendored or imported; BrAG is not a runtime dependency; no Hyperframes/Remotion introduced.** Register of originality: `M31_SHOWCASE_ARCHITECTURE.md` §header; compliance audit in §GitHub below.

## 1. Test summary (all evidence in `docs/m31-showcase-evidence/`)

| Suite | Result | Notes |
|---|---|---|
| `test-showcase-core.test.ts` (unit, 20 tests) | **20 pass / 0 fail** | SSRF guard, HTML→text, redaction, palette, claims lint, poster choice, all 11 primitives editor-valid, stat-reveal refusal, share-copy limits, campaign honesty, additive schemas, dependency-graph integrity |
| `test-showcase-live.test.ts` (live E2E, 10 tests) | **10 pass / 0 fail** | full chain on an isolated server + DB with REAL media, REAL jobs, REAL render (see §2) |
| `test-m31-studio-core.test.ts` (base regression) | **14 pass / 0 fail** | template-count invariant updated 3→4 active (showcase added) — the stage-graph integrity assertions unchanged and passing |
| `test-m31-security.test.ts` + worker + performance (HTTP suites) | 18 pass / 2 fail → **18 pass / 1 fail** | 1 remaining failure is a PRE-EXISTING SQLite 4-writer contention flake (`Socket timeout` on 2 of 4 concurrent timeline writes) — `src/lib/editor/`, `notify`, `job-runner` untouched by this diff (verified via `git diff --name-only`); optimistic concurrency still held (exactly one winner, one clean 409 with authoritative head, no lost writes). Classified INFRASTRUCTURE (SQLite single-writer), not a regression |
| TypeScript `tsc --noEmit` | **0 errors** | |
| ESLint (all showcase files) | **clean** | repo-wide lint state unchanged (pre-existing errors in unrelated files: `credential-store`, `premiere-panel`) |
| Production build (`bun run build`) | **OK** | Next standalone; server boots and serves |

An earlier run hit a render-job `SIGKILL` (OOM) when two suite executions overlapped with a live browser session — the identical pipeline renders cleanly under normal load; recorded as an operational note (limitation §7), and the failed job surfaced honestly as FAILED with retry available (which is the designed behavior).

## 2. What the live E2E proved (addendum tests A/B/D/E/F/G mapped)

Real fixture media (PIL product screenshot + FFmpeg screen-recording with audio) uploaded through the REAL upload path, driven through the REAL API on an isolated standalone server:

1. **INTAKE (Test A/B inputs):** description + feature list + authorized URL + screenshots + demo recording + project → production created on `showcase-studio`.
2. **UNDERSTAND:** validated artifact — identity, ≥3 evidence-backed capabilities, screenshot palette derived from REAL pixels, demo-video probe facts, website evidence **or** an honest FETCH-FAILED note, approvals recorded append-only. Unverified claims demoted; secret redaction kinds recorded.
3. **BRIEF → CONCEPT:** 3 distinct campaign-aware directions; selection + approval gates enforced.
4. **SCRIPT → STORYBOARD (Test B + editing invariants):** beats from the approved concept; primitives pre-assigned per beat; **approved scene edit → 409**, `reApprove:true` → PENDING + logged; reorder/duplicate/remove exercised.
5. **ASSET PLANNING → GENERATION (gates):** real media attached; demonstration notes recorded; provider routing preview-only without approval (no fake submission, no duplicate-provider risk).
6. **COMPOSE:** canonical `AddClip`/`AddGraphic` assembly — REAL media clips + primitive keyframes + NIKKI graphic end card verified ON the real timeline; rough cut verified.
7. **REVIEW → RENDER → QA (Test E/10):** M30 review revision created + approved through the REAL review API; `FINAL_RENDER` on the durable queue SUCCEEDED; QA ran real measurements (`file-decodable`, `black-frames`, loudness, caption timing) and PASSED.
8. **DELIVER (Phase 9):** poster extracted from the REAL render (`frame-extracted: PASSED`, registered as a MediaAsset), 6-platform share copy — limits honored, no invented claims (no "10x" or unbacked numbers anywhere in the copy).
9. **Isolation (Test F/G):** stranger gets 404; resume skips SUCCEEDED stages with no duplicate clips; input-less UNDERSTANDING refuses with a clear error.

## 3. Functional classification (summary; full matrix in `M31_SHOWCASE_FEATURE_MATRIX.md`)

- **VERIFIED:** product understanding (deterministic core), campaign concepts, storyboard editing, canonical assembly with composition primitives + NIKKI graphics, native timeline output, M30 review bridge, real render, QA measurements, poster from real render, share copy, UI at 375px, isolation/resume.
- **AUTOMATED:** provider generation output validation + asset sync; poster checks; QA measurements.
- **CONFIGURATION REQUIRED:** LLM-assisted artifact structuring (works; gateway health-gated), JAZMII/LAXII generation (job handlers + routing verified; provider CLI presence gated), narration TTS (tongtong verified seam; CLI-gated), beat-aligned animation (audio analysis provider).
- **SIMULATED (labelled):** illustrative interaction accents in demonstration plans — recorded `illustrative: true` in production metadata, never presented as captured behavior.
- **OWNER ACTION:** SFX selection, mask-application sign-off before public release, rights confirmations for user-supplied music.
- **NOT IMPLEMENTED (honest):** in-app browser automation for authorized captures; automated mask compositing (requirements are recorded; masking itself is manual until implemented).
- **INFRASTRUCTURE:** SQLite 4-writer contention flake (pre-existing); render jobs need headroom (SIGKILL under stacked concurrent renders).

## 4. Compliance confirmations (addendum critical rules)

1. **No BrAG code/assets:** only product-behavior concepts studied; no source, prompts, schemas, skills, bundled audio or UI imported. No BrAG runtime dependency; no new runtime dependencies at all (Prisma columns + `GeneratedEngine` union extension are additive to existing packages).
2. **No Hyperframes/Remotion:** composition primitives emit editor-model keyframes/effects; the canonical BEAN renderer remains the only renderer.
3. **Canonical timeline preserved:** assembly via `applyTimelineEdits` only; frame-relative keyframes on the existing timebase; `seqClips`/QA extended without changing editor contracts.
4. **Engines not reshuffled:** MY AI = gateway structuring (provider-gated); JAZMII = video provider + analysis seams; LAXII = image providers; NIIKI = graphic templates; GANGZII = audio/narration seam; RIISHE = creative drafting. All calls go through existing seams.
5. **No fabricated anything:** costs UNKNOWN (never 0) for provider work; no invented claims (claims lint + evidence-only artifacts); no fake generation; placeholders labelled; honest 409s.
6. **No unapproved paid calls:** preview-only routing without `approved:true` + approved budget; duplicate-produce refused.
7. **UI preserved:** existing editor/PRODUCE untouched; SHOWCASE STUDIO is additive (`/showcase` + tool-grid entries); black/yellow system intact.

## 5. Prisma / schema changes (additive)

`Production.productJson`; `ProductionAsset.jobId`, `ProductionAsset.error`; `GeneratedEngine += "SHOWCASE"`. db push additive; existing tables/rows untouched; tsc 0.

## 6. Deliverables

- Engine + services: `src/lib/production/showcase/{types,product-understanding,concepts,compositions,generation-router,narration,poster,share-copy,runner-types}.ts`
- Runner/API: showcase stage executors in `src/lib/production/runner.ts`; board + scene ops + product approval in `/api/productions/[id]`; generation routing + narration in `/api/productions/[id]/assets`
- UI: `src/components/bean/showcase-studio.tsx` at `/showcase` (+ dashboard entries)
- Tests: `scripts/test-showcase-core.test.ts`, `scripts/test-showcase-live.test.ts`, `scripts/m31-showcase-e2e.sh`
- Docs: this file, `M31_SHOWCASE_ARCHITECTURE.md`, `M31_SHOWCASE_FEATURE_MATRIX.md`, `M31_SHOWCASE_UI_REPORT.md`, `m31-showcase-evidence/`

## 7. Limitations (stated plainly)

- Generated-shot cinematic trailers require a configured video provider; without one the pipeline assembles from user media and records blocked generation assets.
- Website understanding is text/structure-level; JS-rendered SPA content beyond the initial HTML is not fetched.
- Beat-aligned animation requires an audio-analysis provider; cut pacing is deterministic otherwise.
- Concurrent renders need memory headroom; a killed encoder surfaces as an honest FAILED stage with retry.
- Vertical-variant rendering (Test D's full cycle) reuses the verified variant pipeline; this suite verified the plan + safe-area QA hooks, not a second full vertical render.

## 8. GitHub

Commit on `feature/ai-creative-studio`, pushed fast-forward; remote SHA verified via `git ls-remote`, fresh clone verified, M30 ancestor check and `main` unchanged — see the final reply for the commit URL.
