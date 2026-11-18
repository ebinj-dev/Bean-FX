# M25 — UI Regression & Design Preservation Report

**Date:** 2026-11-18 · **Branch:** feature/ai-creative-studio · **Baseline:** M24 commit `f4802a4`

## 1. Static checks
| Check | Result |
|---|---|
| `tsc --noEmit` | **0 errors** |
| `eslint src scripts` | **0 errors** (2 pre-existing warnings, untouched files) |
| `prisma validate` | valid |
| Production build | **SUCCESS 23.6 s** (`m25-evidence/build-m25.log`) |

## 2. Backend regression — ALL GREEN
| Suite set | Result |
|---|---|
| M25 billing (13 tests) + P3/P4 (7 tests) | **20/20 pass** |
| M21–M23 suites (13 files: core, tokens, mcp, myai, premiere, bridge, bridge-deep, mcp-client, orchestration, security ×2, e2e ×2, raw-client) | exit 0 |
| M1–M20 suites (18 files: editor commands/time/regressions/interaction/preview, filler lexicon, ai-registry, gangzii dsp/analysis, export safety, asr adapter + chunk cache, jazmii, automation api/mcp, creative core, m19 security, m20 mail) | exit 0 |
| T1 durable render (60 s real ffmpeg + ffprobe) | **PASS 45.0 s** |
| A/V sync | **−0.052 s mean / 0.052 s max** (unchanged) |
| Worker stale-claim probe | pass |

## 3. Live UI walkthrough (agent-browser; screenshots in `m25-evidence/screenshots/`)
| Step | Result | Evidence |
|---|---|---|
| Register → editor (fresh user) | PASS | 01-editor-m25.png |
| Project create via toolbar | PASS | combobox updated |
| Project drawer: VERSION HISTORY + **DANGER ZONE** present | PASS | 02-project-drawer-m25.png |
| **Deletion safeguard live**: wrong name → button disabled; exact name → enabled; delete → selector cleared, media untouched | PASS | 03-after-delete-m25.png |
| User menu → SETTINGS → **Plan & usage** renders: Free chip (auto-provisioned), usage grid, plan cards with honest "Payments not enabled", billing history event | PASS | 04-plan-usage-m25.png |
| EXPORT drawer → **FULL SEQUENCE / PREVIEW (FIRST 10s) / CUSTOM RANGE** | PASS | 05-export-range-m25.png |
| 375 px: studio + settings — **no horizontal overflow** | PASS | 06-settings-mobile-375-m25.png |
| M24 access points (SETTINGS menu item, integrations) still present | PASS | 04 screenshot |

## 4. Design preservation
- Diff vs M24 tip: content changes limited to **additive blocks + the M24 doc corrections + the discarded-route restoration**; existing className/style constants untouched (only additive JSX with existing tokens: `#d4a017`, `#2a2a26`, `rounded`, `bean-label`, same font sizes).
- No navigation redesign: SETTINGS menu item from M24 retained; plan section inserted as a new card in the existing settings layout order (before Integrations), admin additions inside the EXISTING admin card.
- Editor workspace unchanged (timeline/monitor/toolbar); all new affordances are inside existing drawers/panels.
- Landing page untouched.

## 5. Honest incidents (disclosed in m25-evidence/00-m25-audit.md)
1. M24 record error corrected (upload route existed since M3; superior original restored).
2. `--force-reset` wiped dev custom.db — synthetic test data only; no real users; recreatable.
3. Sandbox recycle cleared 522 exec bits + rolled back .git metadata — repaired; prevented mode-noise in the M25 commit.

## 6. Conclusion
M25 adds the billing foundation (payments disabled), completes export/project/media/AI management affordances and admin tooling with zero regressions across the full M1–M24 suite set, and the visual identity is preserved.
