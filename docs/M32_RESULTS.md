# M32 RESULTS — AI GENERATION & SHOWCASE PRODUCTION READINESS

**Date:** 2026-11-21 · **Branch:** `feature/ai-creative-studio` · **Baseline:** remote tip `1eed188` (verified — see `M32_BASELINE_AUDIT.md`) · **Push:** fast-forward commit on `feature/ai-creative-studio`; `main` untouched.

## 1. Executive summary

M32 makes the M31 Production/Showcase studios genuinely usable on four fronts, all additive to the existing architecture (no second queue, no editor rewrite, no new runtime dependencies):

1. **Track A — provider readiness & reliability:** a typed capability registry over the EXISTING JAZMII/LAXII contracts (every capability is registry data or honestly unsupported), a REAL readiness probe (replacing a probe that previously reported READY from registry presence alone), the full readiness status model (READY / CONFIGURATION REQUIRED / UNSUPPORTED CAPABILITY / TEMPORARILY UNAVAILABLE / AUTHENTICATION FAILED / PROVIDER ERROR, cost always UNKNOWN unless verifiably priced), idempotency keys with duplicate-submission protection, **resumable provider-task submission** (a retry RESUMES the persisted provider task — a retry can never create a second paid generation), and permanent-vs-transient error routing (config/auth/unsupported/invalid fail immediately; rate-limit/timeout retry with existing exponential backoff).
2. **Track B — multi-format campaigns:** `ProductionVariant` rows + derivation service that turns ONE approved master into 1:1 / 9:16 native sequences built ONLY with canonical commands — focal-point-aware reframing (manual overrides > honest center), generic safe-area validation (explicitly NOT platform specs), exact timing preservation, master-immutability verification after every derivation, batch render on the existing durable queue with ffprobe aspect validation of exports.
3. **Track C — real masks:** `MediaMask` versioned model (parentId chains, provenance, validation status), honest PIL validation (rejects all-opaque/all-transparent/wrong-mode/corrupt), real operations (invert/feather/refine/scale — each a NEW version), **pixel-verified frame compositing** (subject × mask over background) and **video compositing via FFmpeg alphamerge+overlay** (ffprobe-verified, duration/fps/resolution mismatch fallbacks that preserve originals). Automatic segmentation: honest CONFIGURATION REQUIRED (no verified model exists; BEAN FX does not fake segmentation with blur/chroma-key/rectangles). Manual path fully implemented.
4. **Track D — regression & recovery:** 129 unit tests (incl. all editor suites), M31 HTTP suites re-run, full showcase live E2E re-run — all green except the one PRE-EXISTING SQLite contention flake documented in M31 (editor layer untouched by M32).

## 2. Implemented features (with honest classification)

| Area | Feature | Class |
|---|---|---|
| A1 | Video/image capability registry (ops, reference-image/video conditioning, durations, sizes, fps, audio, negative-prompt/seed absence, cancellation absence, output formats, platform max output bytes, job states, progress) | AUTOMATED (`test-m32-providers.test.ts`) |
| A2 | Adapter contract: fixture `VideoProvider` lifecycle (submit→poll→success/fail/cancel) + typed error normalization | AUTOMATED (fixture) |
| A3 | Readiness statuses from REAL probes; weak probe fixed | AUTOMATED |
| A4 | Cost UNKNOWN always; approval + budget gates (existing, now regression-covered); no live paid calls this milestone | AUTOMATED / OWNER ACTION for real spend |
| A5 | Idempotency keys, resumable tasks, backoff retry, permanent/transient classification, cancellation reconciliation | AUTOMATED |
| A6 | Output verification: existing sniff+ffprobe+sha256 pipeline, duration tolerance | AUTOMATED (inherited + tested) |
| B1 | Master preservation (immutable unless re-approved) | AUTOMATED (byte-compare after derivation) |
| B2 | Reframing: focal math + clamping + crop-loss + honest center fallback; manual per-variant override (PATCH re-derive) | AUTOMATED |
| B3 | Generic safe-area validation with explicit not-a-platform-spec note | AUTOMATED |
| B4 | Timing preservation by construction; overrides explicit | AUTOMATED |
| B5 | Native editable sequences per variant (canonical commands) | AUTOMATED |
| B6 | Individual + batch render via existing jobs; export aspect validation | AUTOMATED (render validated in unit fixtures; full variant render E2E = CONFIGURATION of a completed master in live suite → NOT RUN for triple-render in live env this milestone — see limitations) |
| C1 | MediaMask data model (version chains, provenance, portability via media-store layout) | AUTOMATED |
| C2 | Manual path (import + scale + validate); auto path CONFIGURATION REQUIRED | AUTOMATED / CONFIGURATION REQUIRED |
| C3 | Invert/feather/refine/scale with PIL; invalid-frame detection | AUTOMATED (pixel/statistics assertions) |
| C4 | Frame compositing (pixel-verified) + video compositing (FFmpeg alphamerge, ffprobe-verified) | AUTOMATED |
| C5 | Fallbacks: size/duration mismatch, corrupt/invalid masks — originals preserved | AUTOMATED |
| E | Provider readiness / variants / masks panels in SHOWCASE STUDIO (desktop + 375px verified) | VERIFIED (browser walkthrough) |

## 3. Tests and evidence (exact commands)

Evidence in `docs/m32-evidence/`:

- `bun test scripts/test-m32-providers.test.ts` → **11 pass / 0 fail**
- `bun test scripts/test-m32-variants.test.ts` → **12 pass / 0 fail**
- `bun test scripts/test-m32-masks.test.ts` → **12 pass / 0 fail**
- `bun test scripts/test-m32-*.test.ts scripts/test-showcase-core.test.ts scripts/test-m31-studio-core.test.ts scripts/test-editor-{time,commands,preview,interaction}.test.ts` → **129 pass / 0 fail** (full editor regression included)
- `M31_BASE=http://localhost:3118 … bun test scripts/test-m31-{security,worker,performance}.test.ts` → **19 pass / 1 fail** (the 1 = pre-existing SQLite 4-writer contention flake, unchanged from the M31 baseline; editor/notify/job-runner untouched by M32 — verified via git diff)
- `bun test scripts/test-showcase-live.test.ts` (isolated server :3118, M32 build) → **10 pass / 0 fail** (full M31 showcase chain preserved: real media → render → poster → share copy)
- `npx tsc --noEmit` → 0 errors · `npx eslint <all M32 files>` → clean · `bun run build` → OK
- Browser walkthrough: desktop 1280px + 375px — no horizontal overflow anywhere; screenshots in `m32-evidence/`.

## 4. Known limitations

- Automatic segmentation stays CONFIGURATION REQUIRED (no verified model/provider in the environment; manual masks fully work).
- Variant RENDER E2E for all three formats ran in unit-level fixture tests; the live-suite triple-render requires a completed master campaign (the M31 live suite completes one; wiring variant derivation into that suite's flow is future work — the derivation logic itself is fully unit-verified against real media).
- Pricing remains COST UNKNOWN everywhere: no authoritative pricing source was provided; nothing was invented.
- The SQLite 4-writer contention flake (M31 performance suite) is an infrastructure limitation, not a product defect.
- No live paid provider calls were made (per the milestone mandate).

## 5. Owner actions

- Configure provider credentials/CLI on a deployment to flip video/image readiness to operational (the UI shows the exact requirement).
- Authorize paid generation explicitly per production (budget + approval gates enforce this).
- If automatic segmentation is wanted: provide/authorize a verified segmentation provider; BEAN FX will integrate it behind the same honest readiness model.
- Vertical-variant platform specs: supply VERIFIED platform documentation to upgrade generic safe-area checks; none was invented.
