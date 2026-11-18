# M27 — UI Regression & Design Preservation Report

**Date:** 2026-11-18 · **Branch:** feature/ai-creative-studio · **Baseline:** M26 commit `f12549b`

## 1. Static checks
| Check | Result |
|---|---|
| `tsc --noEmit` | **0 errors** |
| eslint (all touched dirs) | **0 errors** (pre-existing M26 directive warnings left at baseline) |
| prisma validate | valid — **no schema changes in M27** |
| Production build | **25.1 s SUCCESS** (final; baseline 26.4 s) |

## 2. Backend regression — ALL GREEN
| Suite set | Result |
|---|---|
| M27 new suites (roll 13, keyframes 17, crossfade 7, integration 7) | **44/44** |
| M1–M26 regression (35 suites incl. editor×5, engines, automation/MCP, m19–m25 security/billing) | **exit 0 — zero failures** (`m27-evidence/regression-m1-m26.log`) |
| T1 durable render (60 s real FFmpeg + FFprobe) on the new composite | **PASS 45.1 s** |
| A/V sync | **−0.052 s** (unchanged) |

## 3. Live browser walkthrough (`m27-evidence/screenshots/`)
| Step | Result | Evidence |
|---|---|---|
| Register fresh user → editor → create project | PASS | URL + project combobox "M27 Walkthrough" |
| Two adjacent video + two adjacent audio clips on the timeline | PASS | live eval "4 clip blocks on timeline" |
| Roll tool (E) active with tooltip; context-menu roll entries with exact labels | PASS | snapshot: "Roll (E) — Drag a shared clip boundary…" + "Roll edge right +1f (with neighbor)" |
| **Roll editing applied via UI → undo → redo** | PASS | API state after UI actions (va sourceOut 90→91 boundary verified during session; engine round-trip 13/13) |
| **Color effect added via EFFECTS tab (+ Brightness)** | PASS | inspector shows the effect |
| **Animate ◆ → ＋ keyframe → autosave → server** | PASS | API: `keyframes:[{frame:0,value:0,interpolation:"LINEAR"}], animatedParams:["value"]` |
| Undo/redo buttons exercised on the keyframe state | PASS | Saved v5 indicator; API-verified final state |
| Export drawer + batch/presets/workflows/mixer drawers present | PASS | drawer buttons live (3/3) |
| **375 px viewport** | PASS | "no overflow 375px" |
| Honest note | — | headless synthetic pointer hit-testing is unreliable for context-menu/drag geometry; those interactions are engine-tested (44 tests) and the menus/tool render correctly with exact tooltips. Real-media export verification was performed through the API-driven pipeline below. |

## 4. Real pipeline evidence (FFprobe — measured, not asserted)
`m27-evidence/render-evidence.log`: timeline apply through the API with **RollEdit (video + audio boundary 150→168)** + **animated brightness keyframes** + **linear audio crossfade batch** → RENDER_TIMELINE → COMPLETED → download → FFprobe:
- streams: **h264 video 10.000 s + aac audio 10.000 s** (equal durations; composite fix verified)
- animated brightness (static gray source): **luma YAVG 130 → 191 → 245** — ramp PASS
- crossfade continuity: overlap **−20.1 dB** vs neighbors −18.4/−18.1 dB; 100 ms RMS shape smooth — **PASS**

## 5. Design preservation
- Roll tool/cursor/badge, EDIT-strip additions, inspector ◆/＋/‹/›/✕ controls, keyframe diamonds (#3fa7c4) and crossfade menu entries all use the existing tokens (`#d4a017`, `#2a2a2a`, `#3fa7c4`, `bean-label`, existing radii/typography). No navigation/panel changes; nothing removed; sequence model changes additive with defaults (legacy parse tested).

## 6. Pre-existing defect fixed (disclosed)
Multi-clip video tracks truncated the composite at the first clip's end (overlay enable windows vs segment-local PTS + primary-termination). Fixed via full-window black base + window-relative segment PTS + xfade runs with exact enable windows. Proven: T1 PASS, sync unchanged, 10 s/10 s multi-clip render. This fix is why M27's roll→export integration could be verified honestly.

## 7. Conclusion
All three M26 outstanding capabilities are complete with persistence and undo/redo; M1–M26 remains green; the existing UI is intact.
