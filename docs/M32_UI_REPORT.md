# M32 UI REPORT

**Date:** 2026-11-21 · Walkthrough against the M32 production build on an isolated server (:3118), real account, real API.

## 1. What was added (only necessary controls; existing design untouched)

Three panels integrated into the EXISTING SHOWCASE STUDIO board (black/yellow glass, same Panel/STATE_STYLES idioms), plus the intake unchanged:

1. **AI providers (honest readiness)** — per-provider cards: registry id + engine, status badge (READY / CONFIGURATION REQUIRED / …), real probe detail, capability summary (operations, durations, size count), cost state (UNKNOWN), first unsupported item (e.g. "reference-video conditioning (provider contract documents image-to-video only)…", "transparent-background output … recorded honestly").
2. **Campaign variants (master <aspect> — immutable)** — derive buttons for the non-master formats, render-all / per-variant render, per-variant status badge (READY/RENDERING/COMPLETED/FAILED), framing strategy + crop-loss %, open-in-editor link, safe-area issue banners carrying the "not a platform specification" note, honest error lines.
3. **Masks (subject isolation — real compositing)** — the auto-segmentation CONFIGURATION REQUIRED banner with the no-faking statement, validated mask rows (status badge, geometry, method, version, source), invert/feather actions (versioned).

## 2. Desktop (1280×800) observations

- Step rail, all nine step panels, and the three M32 panels render without clipping or overlap (screenshot `m32-evidence/ui-desktop-panels.png`).
- Provider cards show the REAL probe result of the deployment (CLI present → READY with cost UNKNOWN — honest for this environment; on an unconfigured deployment the same card shows CONFIGURATION REQUIRED with the exact install hint, as proven by the readiness tests).
- Variants panel correctly refuses nothing silently: derive actions disabled only by busy-state; the server enforces completed-master + format rules and the UI prints its precise errors.
- Masks panel leads with the honesty banner before any action — impossible to mistake the manual path for AI segmentation.

## 3. Mobile (375×812) observations

- `scrollWidth == 375 == innerWidth` — no horizontal overflow on intake, board, or the M32 panels (verified programmatically at every step).
- Panels stack single-column; provider cards, derive buttons, mask rows remain full-width and touch-usable (screenshots `ui-375-providers.png`, `ui-375-variants.png`).
- Step badges wrap to multiple rows without truncation.

## 4. UX guarantees honored

- No fake progress: badges come from persisted rows (5s poll of the real board API); no animated placeholders.
- No false success: FAILED/CANCELLED render states and validation failures render verbatim error strings.
- No silent paid retries: the provider panel + generation gates state cost UNKNOWN and approval requirements; retries are server-side and resumable (never double-submit).
- No hidden configuration failures: CONFIGURATION REQUIRED is a first-class visible state.
- Keyboard: all actions are real `<button>`/`<a>` elements (existing focus behavior preserved; no new custom focus traps).

## 5. Known UI limitations

- Mask IMPORT from the board is via the STUDIO upload path + API (the panel lists/refines/composites; a dedicated file-picker inside the panel is future work — the empty state explains the exact path).
- Variant per-scene framing uses the default focal override (scene-keyed overrides via PATCH API; a visual focal picker is future work).
- Provider panel shows capability summaries; the full capability report is available via `/api/providers/readiness` for tooling.
