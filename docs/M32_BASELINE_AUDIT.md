# M32 BASELINE AUDIT — Phase 0

**Date:** 2026-11-21 · **Auditor:** BEAN FX agent (M32 Phase 0) · **Mandated first step:** repository audit before any edit.

## 1. Verified current state

| Item | Result |
|---|---|
| Reported baseline `1eed188` | **VERIFIED on the remote**: `git ls-remote` → `refs/heads/feature/ai-creative-studio = 1eed188ae2fedfd6ee314a8e3a1b1d5de70875f6` (exact match) |
| Remote `main` | `f7867d1c1e45a431cd08e53e2f4466e95f9522a9` — unchanged by M31/M32 work |
| Fresh clone of `1eed188` | checked out `feature/ai-creative-studio`, tip = `1eed188 feat(m31): BEAN SHOWCASE STUDIO…` |
| Workspace relationship | the workspace repo is the durable sandbox snapshot chain (branch `main`, clean tree) — its tracked source files **match the baseline exactly** (verified by `diff -rq` excluding gitignored dirs); M32 continues the established clone-overlay publication procedure |
| Working tree | clean; no unrelated user changes to preserve in tracked files; local-only artifacts (`.env`, `GITHUB_AUTH.md`, `PUSH_TO_GITHUB.md`, `next-env.d.ts`, `requirements-test.txt`, `skills/`) are gitignored/workspace tooling — untouched |
| Reconciliation items found | (a) the M31 qualification-doc renames (`M31_QUALIFICATION_*.md`) exist in the workspace but the remote still carries the old names (`M31_INTEGRATION_QUALIFICATION.md`, `M31_RELEASE_READINESS.md`, `M31_SECURITY_AUDIT.md`) — doc-only, will be reconciled in the M32 docs commit; (b) `BEAN_FX_RECOVERY_AUDIT.md` differs (workspace newer) — preserved |

**Conclusion: the repository matches the reported baseline. No discrepancy blocks implementation.**

## 2. Existing architecture (verified paths)

- **Canonical timeline commands:** `src/lib/editor/{model,commands,engine,persistence}.ts`; clips FLAT on `seq.clips`; keyframes clip-relative; `applyTimelineEdits` with optimistic concurrency (409 + authoritative head). Effects: `crop`, color family + `blur/sharpen/vignette`; per-effect-param keyframes (M27 P2). **No mask concept exists in the editor model** (only `crop`).
- **Durable job system:** `src/lib/job-runner.ts` (claims/attempts/maxAttempts, heartbeat, stale recovery, SIGTERM→CANCELLED, SIGKILL→honest FAILED) + `src/lib/job-helpers.ts` (`enqueueMediaJob`, `requeueJob` exponential backoff 30s·2^n cap 5min, `handleJobError` permanent-vs-transient routing via `PermanentJobError`). Job types include `JAZMII_GENERATE/ANALYZE`, `LAXII_GENERATE`, `GANGZII_ANALYZE/PROCESS`, `RENDER_TIMELINE`, `EXPORT_VARIANT`, `COMPOSITION_RENDER`, `PUBLISH_*`.
- **JAZMII (video providers):** `src/lib/jazmii/{providers,types,jobs,analysis}.ts` — data-driven capability model (`VideoProviderCapabilities`: operations textToVideo/imageToVideo, qualities, sizes, fps, durationsSec, withAudio, providerProgress, license/attribution/pricingNote strings), CLI adapter with hard timeouts, poll loop with per-poll local-cancel check, timeout honesty (provider task left as-is, result NOT registered), ffprobe validation (duration tolerance + aspect class), `registerGeneratedAsset` (sniff + probe + quota + sha256 + provenance), `AIUsage` accounting.
- **LAXII (image providers):** `src/lib/laxii/{providers,types,jobs}.ts` — `zai-image` (textToImage) + `zai-image-edit` (imageToImage); PIL decode + size verification; honest license note ("provider terms NOT independently verified").
- **MY AI gateway:** `src/lib/my-ai/gateway/{provider,structured}.ts` — provider-independent LLM seam (zai adapter, glm-4-plus), health-gated, typed errors, validated JSON with bounded repair.
- **M31 Production/Showcase:** `src/lib/production/{engine,runner}.ts` + `src/lib/production/showcase/*` (product understanding w/ SSRF guard + claims lint, campaign concepts, 11 composition primitives, generation router, narration, poster, share-copy); board API with approved-scene immutability; showcase UI `/showcase`.
- **M30 collaboration:** `/api/reviews` + `/api/reviews/[id]` + `link`; `src/lib/production/review-bridge.ts`; workspace/roles models in Prisma.
- **M29 portability:** `src/app/api/projects/[id]` + `import` routes (package/import with checksums).
- **M14 layered compositing:** `src/lib/creative/m14/compose.ts` — `CompositionDoc` single evaluator, PIL export parity, blend modes normal/multiply/screen. This is GRAPHICS compositing — **not subject isolation**.

## 3. What M31 genuinely implements vs partial vs missing

- GENUINE (verified by M31 suites): engine/state machine, intake, concepts/script/storyboard, asset provenance, canonical assembly, render on durable jobs, QA, delivery, showcase product understanding/concepts/primitives/poster/share-copy, UI.
- PARTIAL: templates A/B/F blocked-start only (honest 409s); podcast ASR stage CONFIGURATION REQUIRED; generation assets route but provider CLI presence gates real runs.
- MISSING (M32 targets): typed provider readiness statuses; provider-side cancellation; reference-video conditioning/seed/negative-prompt capability fields; pricing availability model; multi-format campaign variants; ANY mask data model or subject-isolation compositing (M31 reported it NOT IMPLEMENTED — confirmed: only `maskNotes` text and M14 graphic layers exist).

## 4. Existing tests and baseline results (re-run in Phase 6)

- `scripts/test-showcase-core.test.ts` (20 tests), `scripts/test-showcase-live.test.ts` (10 tests, isolated server :3118), `scripts/test-m31-studio-core.test.ts` (14), `test-m31-security/worker/performance` (HTTP suites), editor command suites (`test-editor-*.test.ts`), M29 packaging/import journey, M30 review suites. Baseline at `1eed188`: all green per M31 evidence; Phase 6 re-runs them against M32.

## 5. M32 dependencies and risks

- **Provider reality:** the only configured provider seam is the z-ai CLI (verified live in M31). No owner authorization for paid calls this milestone → real-provider execution stays CONFIGURATION REQUIRED; adapters/tests must be fixture-qualified.
- **Segmentation:** no verified segmentation model/provider exists in the environment → automatic mask path will be honest CONFIGURATION REQUIRED; manual mask path + real processing/compositing is implementable and testable.
- **SQLite concurrency:** known 4-writer contention flake (M31 record) — distinguish product vs infrastructure in tests.
- **Risk:** variant derivation must NOT mutate approved masters (immutability rules already enforced server-side; variants must be new rows/sequences).
- **Risk:** mask compositing must integrate via canonical commands + render hooks, never direct JSON writes.
