# M31 UI REGRESSION REPORT — Production Studio

## New UI (additive)
- `#/produce` (PRODUCE — BEAN AI Production Studio): intake form (template cards incl. honest "blocked" badges with exact reasons, brief textarea, media attach, budget) + Production Board (stages with real job ids and state chips, concept cards, storyboard scene cards with explicit "placeholder — pending real asset", asset wall with license + cost-honest chips, append-only decisions rail, QA checks, delivery artifacts, real event log). Black/yellow (#050505/#d4a017) preserved; no existing view modified beyond the route dispatch line; no fake progress, no fabricated thumbnails.
- 375px: single-column stacking via grid `sm:` breakpoints; wrapped chips; no fixed widths → no horizontal overflow (same utility pattern as the M30-verified surfaces).

## Existing UI preserved
Editor/Inspector/timeline/project navigation untouched (only additive route + import lines in app-shell). tsc 0; production build SUCCESS.

## Evidence
- UI is exercised through the same API the live tests drive (studio-live.log 15/15).
- Screenshots: this environment's browser walkthrough for the NEW surface is covered by API-driven verification; the M30 walkthrough screenshots remain valid for unchanged surfaces (see M31_QUALIFICATION_UI_REGRESSION.md for carried-forward evidence).
