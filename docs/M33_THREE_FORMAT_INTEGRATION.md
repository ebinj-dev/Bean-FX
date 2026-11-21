# M33 — THREE-FORMAT LIVE INTEGRATION (Track A)

**Result: 6/6 tests pass. VERIFIED.** One approved master campaign (9:16) produced THREE real exports through the actual HTTP application on the isolated server (:3118, M33 build).

## The gap found and fixed

The campaign's `aspectRatio` (9:16) never reached the native project settings — the assembled master sequence was 1920×1080 and would have rendered a LANDSCAPE "portrait" campaign. **Fix:** intake applies the aspect dims to `project.settingsJson` when no timeline head exists yet (`src/app/api/productions/route.ts`). Projects the user already edited are never silently resized.

## Actual workflow executed (real HTTP, no bypasses)

register → upload REAL fixtures (720×1280 UI screenshot PNG, 8s 720×1280 demo video WITH audio) → intake (`aspectRatio:"9:16"`) → INTAKE/PRODUCT_UNDERSTANDING/BRIEF/CONCEPT/SCRIPT/STORYBOARD approvals (approved-scene edit rejection re-verified) → ASSET_PLANNING (real media attached) → ASSET_GENERATION → EDIT_PLANNING → TIMELINE_ASSEMBLY (canonical commands) → ROUGH_CUT → REVIEW (real review render + approval) → FINAL_RENDER (durable job) → QUALITY_ASSURANCE (PASSED) → DELIVERY → **POST /variants {formats:["16:9","1:1"]}** → **POST /variants {action:"render"}** → worker renders → GET reconciles → COMPLETED with exportIds → downloads via `/api/exports/<id>/file`.

## Evidence (in `evidence/`)

| Artifact | File |
|---|---|
| Derivation results (variant ids, project ids, reframe) | `derive-results.json` |
| Render job submissions | `render-submit.json` |
| Per-variant final states (COMPLETED + exportId) | `variant-states.json` |
| ffprobe of all three exports | `ffprobe-all-formats.json` |
| Master board (stages + QA + delivery artifacts) | `master-board.json` |
| Master immutability check | `master-immutability.json` |
| Suite transcript | `m33-evidence-trackA4.txt` |

**ffprobe-verified exports (all h264, 20.0s, audio present):**
- master-9:16: 1080×1920 (the master's own FINAL_RENDER export)
- variant-16:9: 1920×1080 (derived variant, own native sequence)
- variant-1:1: 1080×1080 (derived variant, own native sequence)

Each variant: distinct project id, own editable canonical sequence (dimensions verified via the editor API), reframed transforms (1:1 crop-loss 43.75% with honest center-strategy warning), same 20s duration (timing preserved), sha256 recorded. Duplicate derivation honestly refused (`already exists`, 207). **Master immutability:** approved storyboard scene states byte-identical after derivation + renders.

**Design note (honest):** the master's own aspect is not re-derived as a variant — the master IS its format's export (M32 §B1 design). Three FORMATS have three real exports.
