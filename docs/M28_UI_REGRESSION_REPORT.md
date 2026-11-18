# M28 — UI Regression & Design Preservation Report

**Date:** 2026-11-18 · **Branch:** feature/ai-creative-studio · **Baseline:** M27 tip `01286f5`

## 1. Static checks
| Check | Result |
|---|---|
| tsc --noEmit | **0 errors** |
| eslint (src/) | **0 errors** (3 pre-existing M26 directive warnings at baseline) |
| prisma | valid — **no schema changes in M28** (all proxy/relink state already existed) |
| Production build | **26.5 s SUCCESS** |

## 2. Backend regression — ALL GREEN
| Suite set | Result |
|---|---|
| M28 new suites (pipeline 7 + API E2E 4) | **11/11** |
| M1–M27 regression (41 suites total incl. editor×5, engines, automation/MCP, m19–m27) | **exit 0 — zero failures** (`m28-evidence/regression-m1-m27.log`) |

## 3. Live browser walkthrough (`m28-evidence/screenshots/`)
| Step | Result | Evidence |
|---|---|---|
| Register → project "M28 UI" → 1280×720 clip on the timeline | PASS | live eval "1 clips" |
| **SOURCE MEDIA panel renders real ffprobe metadata** (1920× dims shown for the first upload, Probe READY, Proxy READY, ↻ regenerate button) | PASS | live text match + screenshot 01 |
| Proxy auto-generated for the ≥1280p source and served (panel Proxy READY) | PASS | consistent with the FFprobe-verified E2E |
| Asset deleted → **MISSING MEDIA relink UI appears in the Inspector with the replacement picker** | PASS | live text match "MISSING-MEDIA-UI ✓ picker=present" |
| Compatibility warning list | PARTIAL — logic automated + type-checked; the live warning row was not exercised because the test user had no second library asset (picker empty) | honest note |
| 375 px viewport | PASS | "no overflow 375px" |

## 4. Real pipeline evidence (`m28-evidence/render-evidence.log`)
Timeline apply through the API with **RollEdit (video + audio) + animated brightness keyframes + linear audio crossfade** → RENDER_TIMELINE → COMPLETED → FFprobe:
- **M27 multi-clip truncation regression repeated: video 10.000 s = audio 10.000 s** under the NEW duration/dimensions conformance gates
- Animated brightness (static gray source): **luma 130 → 191 → 245** — ramp PASS
- Crossfade continuity: overlap −20.1 dB vs −18.4/−18.1 neighbors, smooth RMS shape — **PASS**
- Timings: import 638 ms · timeline apply 24 ms · probe settle 514 ms · render wall 7 s

## 5. Design preservation
SOURCE MEDIA panel + relink warnings use the existing tokens (`bean-label`, `#d4a017`, `#2a2a2a`, `#4cc47f`/`#c45c4c` status colors, existing typography/radii). No navigation/panel changes, no removals, no model changes (no migration).

## 6. Conclusion
The media lifecycle (IMPORT → PROBE → PROXY → EDIT → PREVIEW → RENDER → VALIDATE → EXPORT → RECOVER) is backed by executed tests, real FFmpeg outputs, and honest classification. Two items are explicitly NOT IMPLEMENTED (bulk relink UI; a new packaging mechanism beyond the audited M23 contract) and one is CONFIGURATION-REQUIRED-by-design (host-dependent encoders, now reported instead of failing mid-render).
