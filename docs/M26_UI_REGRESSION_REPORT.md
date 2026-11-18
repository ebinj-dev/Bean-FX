# M26 — UI Regression & Design Preservation Report

**Date:** 2026-11-18 · **Branch:** feature/ai-creative-studio · **Baseline:** M25 commit `4aa0d6d`

## 1. Static checks
| Check | Result |
|---|---|
| `tsc --noEmit` | **0 errors** |
| `prisma validate` + db push | valid, in sync (no force-reset — incident of M25 not repeated) |
| Production build | **SUCCESS 23.6 s** (`m26-evidence/build-m26.log`) |
| eslint | clean on touched files (checked during development) |

## 2. Backend regression — ALL GREEN
| Suite set | Result |
|---|---|
| M26 engine tests | **11/11** |
| M26 API tests (presets/batch/workflows) | **5/5** |
| M1–M25 regression (33 suites: editor×5, fillers, ai-registry, gangzii×2, export-safety, asr×2, jazmii, automation×2, creative-core, m19 security, m20 mail, M21×6, M22×5, M23×2, M25×2) | **exit 0 — zero failures** (`m26-evidence/regression-m1-m25.log`) |
| T1 durable render (60 s real FFmpeg + FFprobe) | **PASS 45.1 s** |
| A/V sync | **−0.052 s mean / 0.052 s max** (unchanged) |
| Worker stale-claim probe | pass |

## 3. Live UI walkthrough (agent-browser; `m26-evidence/screenshots/`)
| Step | Result | Evidence |
|---|---|---|
| Register fresh user → editor | PASS | 01-editor-m26.png |
| Project created via toolbar | PASS | combobox "M26 Pro Demo" |
| **EDIT strip renders** (9 controls: + MARKER / IN / OUT / CLR / LIFT RANGE / CLOSE GAPS / ALIGN SEL / GROUP / UNGROUP) | PASS | 02-mixer-m26.png |
| **Marker added via UI** → red flag on ruler with remove × | PASS | (live eval: "1 marker(s) on ruler") |
| **MIXER drawer**: per-track faders ×4 (Video 1/2, Audio 1/2) + honest meter description | PASS | 02-mixer-m26.png (image verified) |
| **WORKFLOWS drawer**: 4 templates listed with step chips; Start → run appears with live step states | PASS | 03-workflows-m26.png |
| **EXPORT drawer**: BATCH EXPORT (M26) section + variant queue | PASS | live eval "batch-section-rendered" |
| **PRESETS drawer**: 5 kind tabs incl. MIXER-context entries | PASS | 04-presets-batch-m26.png |
| Responsive 375 px | PASS | "no overflow 375px" (studio + editor drawers) |

## 4. Design preservation
- Every addition uses the EXISTING design system: toolbar buttons reuse the exact drawer-button classes; the EDIT strip sits between ruler and tracks in the timeline's own borders/typography; drawers follow the existing drawer container; inspector additions are inline in existing sections; all colors are existing tokens (`#d4a017` accents, `#2a2a26` borders, `#0b0b0a` panels, `bean-label` labels).
- No navigation changes; no existing control removed; timeline/monitor/inspector layout untouched; screenshots show seamless integration (see 02-mixer-m26.png).
- Sequence model changes are additive with defaults — legacy sequences parse (engine test asserts).

## 5. Honest notes
- main was moved externally during the milestone (c30c7125 → 3c10649) — not by this workspace; feature branch pushed fast-forward only; main untouched by us.
- Sandbox recycle incidents (servers down, exec bits, empty dev DB) were repaired; disclosed in `m26-evidence/00-m26-audit.md`.

## 6. Conclusion
M26 delivers professional editing/audio/effects/presets/batch/workflow capabilities as pure additions to the existing BEAN FX interface, with zero regressions across the full M1–M25 suite set.
