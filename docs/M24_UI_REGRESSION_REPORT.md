# M24 — UI Regression & Design Preservation Report

**Date:** 2026-11-18 · **Branch:** feature/ai-creative-studio · **Baseline:** M23 commit `906c773`

## 1. Static checks
| Check | Result |
|---|---|
| `tsc --noEmit` | **0 errors** |
| `eslint src scripts` | **0 errors**, 2 pre-existing warnings (generated `premiere-panel/panel.js`, `monitor.tsx` — untouched by M24) |
| `prisma validate` | valid |
| Production build | **SUCCESS** (24.8 s, webpack standalone) |

## 2. Backend regression (all suites re-run on the M24 build)
| Suite set | Result |
|---|---|
| M21–M23 (core, tokens, mcp, bridge, premiere, myai, bridge-deep, mcp-client, orchestration, e2e, security, raw-client, security-release) | **73 tests / 307 expects — exit 0** |
| M1–M20 (18 suites: editor commands/time/regressions/interaction/preview, filler lexicon, ai-registry, gangzii dsp/analysis, export safety, asr adapter, jazmii, asr chunk cache, automation api/mcp, creative core, m19 security, m20 mail) | **exit 0 — no failures** |
| T1 durable render (60 s, real ffmpeg + ffprobe) | **PASS 40.05 s** |
| A/V sync | **−0.052 s mean, 0.052 s max** (unchanged) |
| Worker probe (stale-claim recovery) | PASS |

Note: one intermediate T1 run failed with 401 because the `-t "T1"` filter skipped the setup test that registers/logs in — runner error, not a regression; re-run with `-t "setup|T1"` passed.

## 3. Live UI walkthrough (agent-browser, screenshots in `m24-evidence/screenshots/`)
| Step | Result | Evidence |
|---|---|---|
| Landing page renders (unchanged design) | PASS | 01-landing.png |
| Register → auto-enter editor | PASS | toolbar + drawers visible |
| Project create via toolbar | PASS | "M24 Accessibility Demo" in combobox |
| AI Studio drawer → MY AI tab | PASS | 02-editor-aistudio.png |
| **NEW: Automation/MCP/conversations section opens** | PASS | 03-myai-new-controls.png |
| **NEW: Intent router** — "add b-roll about city traffic…" → **"→ engine JAZMII"**; unmatched input → honest "No engine matched… Supported: …" | PASS | live fetch to `/api/ai/route` |
| **NEW: MCP approval** — real one-time approval minted (`approvalId cmwlqqefm00itp656en5xrrja`, 15-min expiry note) | PASS | live POST `/api/mcp/approvals` |
| **NEW: Conversations load** — real API list ("No conversations for this project yet.") | PASS | 03 |
| **NEW: user menu → SETTINGS** navigates to `/settings` | PASS | 04-settings-top.png |
| **NEW: Integrations section** — token created via UI; raw shown ONCE in status box; list shows prefix-only + scopes + Revoke; revoke → "stops working immediately" | PASS | 05-settings-integrations-token.png |
| **NEW: upload-session endpoints** — owned session → `{missing:[0..9], …}` correct shape; foreign user's session → 404 (ownership enforced) | PASS | live fetch |
| Responsive 375×812 (studio + settings) | **no horizontal overflow** | 06/07 PNGs |

## 4. Design preservation (absolute requirement)
Diff analysis against M23 HEAD:
- **Only additive lines**: +491/−21 across 5 files; zero removals of existing `className`/style constants in `editor.tsx`; settings page removed only a type alias line + an effect cleanup line (both replaced by extended versions).
- All new UI reuses the existing tokens: `rounded-lg/2xl`, `border-[#2a2a26]`, `bg-[#141412]/[#0b0b0a]/[#111110]`, gold `#d4a017` accents, `text-[11px]/[10px]/[9px]` sizes, existing `bean-label` class, existing lucide icons, existing `<details>` pattern.
- Navigation structure unchanged — one item added to the EXISTING user menu (SETTINGS) using the existing menu-item classes.
- Landing, dashboard, editor workspace, timeline, monitor: unchanged (see 01/02/03 screenshots).
- No component replaced, no theme change, no new design system, no removed buttons, responsive behavior intact (375px verified).

## 5. Conclusion
All M24 additions are additive access points wired to real backend routes; the visual identity and all pre-existing functionality are preserved, and the full M1–M23 regression suite remains green on the new build.
