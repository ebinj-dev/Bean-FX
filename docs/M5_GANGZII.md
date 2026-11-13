# M5 — GANGZII Audio Intelligence Engine

Milestone goal (repo audit): *"GANGZII / NIIKI / LAXII / JAZMII: audio tool, watermark, b-roll picker exist as separate tools → Engine adapters over existing services + FFmpeg filters; no duplicate engines."* M5 builds GANGZII as the production audio analysis/enhancement/restoration/mixing engine — **integrated into the editor, the media pipeline and the MY AI interface**, reusing the M1 command model, the M3 durable worker and the established storage/auth layers. This is an implementation milestone: everything described below runs (see the test evidence at the end).

## 1. Architecture

```
editor/audio-tool/MY AI
   │  typed params (zod — the ONLY accepted input)
   ▼
API routes (thin, owner-checked)          src/app/api/gangzii/*
   │  GangziiProcess row + durable Job row
   ▼
durable worker (M3.4)  — claim/heartbeat/retry/timeout/stale-recovery
   │  handlers: runGangziiAnalyzeJob / runGangziiProcessJob
   ▼
deterministic DSP layer                   src/lib/gangzii/*
   ├─ inspect.ts   ffmpeg → 48 kHz f32le pipe → streaming measurement
   ├─ loudness.ts  ITU-R BS.1770-4 (K-weighting, gating, LRA, true peak)
   ├─ fft.ts       dependency-free radix-2 FFT (spectrum + modulation)
   ├─ dsp.ts       GangziiParams → explicit FFmpeg filter chain
   ├─ presets.ts   11 named presets (validated values)
   └─ proposal.ts  MY AI intent table → validated proposals (NO LLM)
   ▼
derived asset (media-store/derived/) + MediaAsset row (derivedFromId → original)
   │  ONE ReplaceClip command (M1 model)
   ▼
editor timeline (undo/redo/autosave native) — original never modified
```

Non-destructive by construction: GANGZII only reads originals; every output is a new file under `media-store/derived/` registered as its own `MediaAsset` (with `derivedFromId`). Bypass/comparison swaps the clip between original and derived with a single validated `ReplaceClip` command — undo/redo and persistence come from the M1/M2 session, no second editing history.

## 2. Audio analysis (`inspect.ts`, deterministic DSP — no ML claims)

Measured on a streaming 48 kHz decode (loudness-standard practice; memory is O(window), a 20-minute file never loads into RAM):

| Measurement | Implementation |
|---|---|
| Integrated / short-term / momentary loudness, LRA | BS.1770-4: exact 48 kHz K-weighting table, 400 ms blocks / 75 % overlap, two-stage gating, 3 s windows @ 1 s hop, LRA percentiles |
| True peak | 4× oversampling polyphase FIR (windowed sinc, 16 taps/phase) + 4×-overs count |
| Sample peak, per-channel RMS, channel imbalance + corrective gains | streamed accumulators |
| Clipping | runs of ≥3 consecutive samples at ≥99.9 % FS per channel + suspected flag |
| DC offset | per-channel mean |
| Spectrum | 48 log-spaced bands 20 Hz–20 kHz, Hann-windowed 4096-point FFT every 0.5 s, time-averaged |
| Speech/music levels | deterministic heuristic: speech-band (300–3400 Hz) energy + 2–8 Hz envelope modulation — labelled a heuristic everywhere it appears |
| Silence spans, total, fraction | 100 ms RMS windows, threshold = max(noise floor + 6 dB, −60 dBFS) |
| Noise floor | 10th percentile of window RMS (digital silence clamps to null) |
| Waveform | min/max buckets resampled from envelope windows (UI-ready) |

Results are zod-validated (`GangziiInspectionSchema`) and persisted with the media (GangziiProcess row).

**Meter accuracy (verified by tests against EBU Tech 3341 anchors):** stereo 1 kHz sine @ −23 dBFS → −23.0 LUFS; full-scale stereo → ≈ 0.0 LUFS; full-scale mono → −3.01 LUFS. (Two real bugs were found and fixed on the way: a parametric-coefficient deviation vs the ITU table — the meter now uses the exact 48 kHz table — and a double-offset error in the gated-mean energy conversion.)

## 3. DSP operations (`dsp.ts` — every filter string is composed HERE, nowhere else)

Fixed deterministic order: channel balance → high-pass (DC 8 Hz / rumble / EQ-HP combined) → `adeclick` → hum notches (`bandreject` @ fundamental + harmonics) → `afftdn` (FFT denoiser, strength + measured noise floor) → `deesser` → EQ (`lowpass`, `bass`/`treble` shelves, up to 8 parametric `equalizer` bands) → `agate` → `acompressor` (threshold/ratio/attack/release/knee/makeup, linear-unit conversions handled internally) → loudness (`volume` static gain toward target — duration-neutral and sample-accurate — or `loudnorm` dynamic) → output trim → `alimiter` (auto-level disabled — no hidden gain) → fades.

Honest limitations are emitted as notes/warnings stored with the result:
- clipping repair is attenuation/limiting — heavily clipped audio cannot be perfectly restored;
- dynamic loudness may shift duration by a few ms (resampler flush); static gain is preferred and used by the presets;
- channel-balance gains apply to mono/stereo (multichannel passes through untouched with a warning);
- `pan` gains use the gain-first syntax (`0.5*c0`) this FFmpeg requires (found by tests).

**Verified round-trips (real FFmpeg + real re-analysis, `scripts/test-gangzii-dsp.test.ts`):** hum −20 dB in the 50 Hz band; loudness within 1 LU of target and duration within 50 ms; rumble attenuated ≥15 dB with speech band intact; 12 dB stereo imbalance equalized to <1 dB; loud segment compressed ≥3 dB while the below-threshold segment stays within 1 dB; limiter ceiling respected; noise floor drops without killing the tone; video stream copied bit-exact (h264) with A/V duration preserved.

## 4. Processing architecture (M3 reuse — nothing long runs in HTTP handlers)

- `GANGZII_ANALYZE` (timeout 900 s) and `GANGZII_PROCESS` (1800 s) are owned by the M3.4 durable worker: atomic claim, heartbeat, stale recovery, retry with backoff, hard timeout kill.
- FFmpeg runs through `JobManager.runFfmpeg`: real `-progress` → Job row progress (400 ms updates), user cancellation (`DELETE /api/jobs/[id]` → child kill → `CANCELLED`), settled-hook cleanup of partial outputs.
- **A/V sync guard:** the process job verifies the derived duration against the source (±50 ms for the duration-neutral chain, ±500 ms for dynamic loudnorm) and rejects the output otherwise — the original is untouched.
- Cancellation of a QUEUED job syncs the process row directly (the settled hook never fires for unclaimed jobs).
- Failure sync respects cancellation (`CANCELLED` is never downgraded to `FAILED`).

## 5. Database changes (additive-only migration, verified applier)

- New model `GangziiProcess` (userId, sourceAssetId, kind ANALYSIS|PROCESS, status, paramsJson, analysisJson, resultAssetId, resultMetaJson, error, jobId + indexes) — params and inspection are structured data, persisting across reloads; reprocessing always runs from the original.
- `MediaAsset.derivedFromId` (nullable) + index — marks derived copies.
- `migration/m5_migration.sql` + `scripts/apply_m5_migration.py` (preconditions, content-verified backup via `VACUUM INTO`, single transaction, post integrity check + unchanged row counts). Applied to the live DB; `prisma validate` passes.

## 6. API contracts (all owner-checked via `getOwnedMedia`/row ownership; strict zod; no client FFmpeg arguments)

| Route | Purpose |
|---|---|
| `POST /api/gangzii/analyze` | queue analysis for an owned asset → `{processId, jobId}` |
| `POST /api/gangzii/process` | validate `GangziiParams`, snapshot latest inspection, queue process → `{processId, jobId}` |
| `GET /api/gangzii/processes?mediaId=` / `?resultAssetId=` | persisted profiles (reload) / resolve the original behind a derived asset (A/B) |
| `GET /api/gangzii/process/[id]` | row + job progress (the panel's polling surface) |
| `DELETE /api/gangzii/process/[id]` | cancel + remove derived file/row (original untouched) |
| `POST /api/gangzii/proposal` | MY AI interface: instruction → validated proposal or an honest 422 |

## 7. Editor integration (existing design system — no redesign)

`GangziiPanel` (mounted under the clip inspector) — select clip → ANALYZE (progress-polling) → measurement grid → preset chips + bounded parameter editors (noise, hum, rumble, de-ess, clicks, DC, loudness target −16/−23/−14, trim, compressor, limiter) → **APPLY GANGZII TO CLIP** = derived asset + one undoable `ReplaceClip` → **A/B** bypass swap → saved-profile list with reprocess-from-original / swap / delete. The audio tool keeps its existing flow; GANGZII is the engine behind it.

## 8. MY AI integration (typed, validated, honest)

`proposeGangzii(instruction, inspection?)` maps natural language through a deterministic intent table (8 intents incl. noise, hum with measured 50/60 Hz detection, clarity, professional voice, loudness targets, ducking, repair, channel balance) feeding measured facts (noise floor, balance gains) into the parameters. Unmatched instructions return `null` → the API answers 422 with the supported examples. `GANGZII_ENGINE` is the M8 registry groundwork (`usesLLM: false`, capabilities, presets, validate). Proposals are structured zod objects; execution happens only through the validated job pipeline — an LLM can never shell out or touch media. No ML claims anywhere; no Ollama; no new heavy dependencies (zero runtime deps added).

## 9. Performance (measured in this sandbox, not claimed)

| Operation | Wall time (measured) |
|---|---|
| Inspect 4–6 s mono WAV | 150–280 ms |
| Inspect 12 s stereo WAV | ~190 ms |
| Inspect 120 s stereo WAV (streaming) | **1.15 s** |
| 6 s source process job (end-to-end incl. worker tick) | 0.21 s |
| 600 s stereo process with denoise+compressor+limiter | ~3.5 s (cancel test window) |

Resource use is bounded by design (streaming decode); the worker caps GANGZII at 1 job per user and 2 globally (2 vCPU sandbox).

## 10. Test evidence (all executed this milestone)

| Suite | Result |
|---|---|
| `test-gangzii-analysis.test.ts` (BS.1770 anchors, true peak, clipping, spectrum, silence) | **9/9** |
| `test-gangzii-dsp.test.ts` (real-FFmpeg round-trips incl. video sync) | **11/11** |
| `test-gangzii-jobs.test.ts` (pipeline, non-destructive, cancel, isolation, persistence, undo/redo, timing) | **8/8** |
| `test-riishe-timeline.test.ts` (M4) | **14/14** |
| `test-editor-regressions.test.ts` + `test-media-pipeline.test.ts` (M1–M3) | **4/4** + **29/29** |
| `p3_union.test.ts` + `test-words-srt.test.ts` + `v5-inference-reliability.test.ts` | **3/3** + **14/14** + **10/10** |
| Combined isolated runner `scripts/run-all-tests.sh` | **9 suites, 0 failures (102 tests)** |

**Isolation investigation (the five previously-flaky M3.4/M3.5 tests):** root cause = bun runs all test files in one process, so a suite's `DATABASE_URL` scratch override loses to the shared `db.ts` PrismaClient singleton (first-import binding). Fix: `scripts/run-all-tests.sh` runs each suite in its own process — the established per-suite combinations stay valid, and the combined mode is now reliable. Also: `expect(...).resolves` does not exist in bun test (one test corrected), and fixture amplitudes must use `aevalsrc` (the lavfi `sine` source is fixed at 0.125 amplitude — this hid a correct compressor behind a wrong fixture twice).

`npx tsc --noEmit` clean · `npx eslint src --max-warnings=0` clean · `npx prisma validate` clean · `npm run build` (production) success.

## 11. Known limitations (honest)

- Speech/music separation is a heuristic; source-separation models are out of scope for M5.
- Clipping repair is detection + attenuation/limiting — not restoration.
- Multichannel (>2) audio is inspected (per-channel, LFE-aware loudness) but per-channel gain balance is not applied to exotic layouts.
- Dynamic `loudnorm` mode is offered but static gain is the recommended default (timing-exact).
- MY AI is deterministic intent mapping; LLM orchestration lands in M8 on this typed interface.
- One bug-turned-feature note: `alimiter` lookahead catches attack transients — compression measurements in tests use per-segment levels, not global maxima.

## 12. Deployment requirements

FFmpeg + ffprobe on PATH (already required by M3); the M5 migration must be applied once per environment (`python3 scripts/apply_m5_migration.py`); no new services, no env changes beyond the existing `DATABASE_URL`/`BEANFX_DATA_DIR`.
