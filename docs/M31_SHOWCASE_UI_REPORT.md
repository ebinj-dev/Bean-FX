# M31 SHOWCASE UI REPORT — SHOWCASE STUDIO

**Date:** 2026-11-20 · **Entry point:** `/showcase` (hash route `#/showcase`) + dashboard tool-grid entries (`SHOWCASE STUDIO`, `PRODUCE` — additive; existing tools untouched).

## 1. Design system conformance

- Existing BEAN FX black/yellow system reused verbatim: `#d4a017` accent, `#0d0d0d` panels, `#1c1c1c`/`#2a2a2a` borders, neutral text scale, same `lucide-react` icons, same button/badge idioms as the PRODUCE tool.
- The editor and every pre-existing tool are unchanged; SHOWCASE STUDIO is a new component (`src/components/bean/showcase-studio.tsx`) behind the existing `AppShell` auth gate (workspace route).

## 2. Nine-step workflow (addendum Phase 11)

Step rail renders the REAL persisted stage states mapped to the 9 steps (SELECT PRODUCT → UNDERSTAND → CREATIVE CONCEPT → STORYBOARD → GENERATE → COMPOSE → REVIEW → RENDER → DELIVER): ✓ succeeded, ⏸ awaiting approval, … running, ✗ failed, ⛔ blocked — **no fabricated progress**; states poll the board API every 5s.

Panels:
1. **Intake** — product name, description, feature list (the only capability-claim source), authorized URL, screenshot/demo-recording pickers (library-kind filtered), campaign type (8), tone (9 presets + custom), aspect/duration, narration (off by default / generated-when-configured), music (user track / explicit silence), budget field labelled "required before ANY paid generation", plus the user's showcase productions list (reopen any board).
2. **Understand** — artifact card: identity/tagline, basis (deterministic/llm-assisted), purpose, benefit, brand palette swatches from REAL pixels, evidence-traced capabilities, unverified-claims + redaction banners, approve/reject (append-only decision).
3. **Creative concept** — three distinct direction cards with complexity + select; selection recorded.
4. **Storyboard** — scene cards with on-screen text editing, primitive selector (11 real primitives), approve/reject, reorder ↑/↓, duplicate, remove, regenerate; demonstration metadata line (source, ILLUSTRATIVE label, mask counts); "approved scenes are never silently changed" stated in-UI and enforced server-side (409 without reApprove).
5. **Generate** — asset wall: per-row category/source/provider/status/cost (unknown renders as "unknown"), attach-media selects, provider routing button (preview-only flow; approval + budget enforced server-side), sync-generation, per-scene narration buttons when narration is enabled.
6. **Compose** — canonical-commands explanation, compose/verify-rough-cut buttons, open-in-editor link.
7. **Review** — M30 client-review creation (approval happens on the review surface).
8. **Render** — submit + live job state (job id shown).
9. **Deliver** — QA per-check results with honest PASSED/FAILED/NOT_RUN, artifact list (real exports), poster checks (frame-extracted/not-black/transition-clear/overlay), share copy per platform with fits/TRIMMED verdicts; finalize delivery.

Plus the append-only **production log** (real events only, verbatim).

## 3. 375px verification (browser walkthrough, real server)

- Intake view (`#/showcase`, signed in): `scrollWidth == 375 == innerWidth` — **no horizontal overflow**; single-column stacking; full form usable (verified by driving the form end-to-end at 375×812).
- Production creation from the form → board opens: `overflow: false`; step rail wraps (3-4 badges per row); panels stack; all controls reachable; real event log renders.
- Dashboard (`#/studio`): TOOLS grid shows SHOWCASE STUDIO + PRODUCE first; `overflow: false`.
- Login/signup surfaces unaffected (existing components untouched).
- Table-less layout; no fixed widths; `clamp`-free but fluid (`max-w-*` + flex/grid wrap) consistent with the app's existing responsive patterns.

Screenshots: `m31-showcase-evidence/showcase-intake-375.png`, `showcase-board-375.png` (from the live walkthrough).

## 4. Honesty in the UI

- Unknown costs render "unknown", never $0.00 (fmtCents).
- Blocked templates/steps show the exact reason string from the server.
- Illustrative demonstrations are labelled ILLUSTRATIVE.
- Failed poster/QA checks render FAILED with details; nothing is hidden behind a spinner.
- The production log contains only recorded events.

## 5. Known UI limitations

- Step "run step" buttons are enabled for steps whose dependencies have not succeeded yet; the server rejects with a precise 409 message (shown in the error banner). A future refinement could pre-disable from dependency state.
- The story-board demonstration planner edits existing plans via the scene-edit API; richer mask-region drawing is not implemented (recorded as OWNER ACTION in the feature matrix).
