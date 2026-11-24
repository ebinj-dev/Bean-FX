# Editing Workflows — RIISHE standard flows (M42-C)

Each flow = intent → style routing → analysis scope → plan shape → approval → execution → revision semantics. All execution goes through the canonical editor command system (M42-F); nothing here mutates the timeline directly.

## W1 — Montage from selected clips
Analyze selected assets (probe + scene sampling) → pick `music-video-montage` or `gaming-highlight` per content → plan: ordered shots at recipe pacing, transitions per recipe → approve → apply AddClip/AddTransition → preview → revise conversationally.

## W2 — Story edit
Full-project analysis (scene map + transcript when ASR available) → `cinematic-storytelling` / `documentary-interview` → plan includes chapter structure narration (concept text), long-take holds, J/L-cuts → approve per operation → apply → revise ("make the intro shorter" = adjust first chapter's clip durations via TrimClip commands).

## W3 — Social vertical
Take the current edit (or selected clips) → `vertical-reframe` (+ `instagram-reel` if the prompt asks for a reel) → per-clip crop windows (center default; subject-aware when frame analysis is available — disclosed otherwise) → captions re-flowed → approve → apply transforms/keyframes on a 9:16 sequence copy. **The original 16:9 sequence is never modified.**

## W4 — Caption pass
Transcript source: existing ASR result, MCP transcription tool, or user-provided text (each disclosed as provenance) → word timing if available → caption clips per `CAPTIONS_AND_SUBTITLE_STYLES.md` style → approve → apply AddCaption commands.

## W5 — Revision loop
Every conversational follow-up is planned against the CURRENT sequence revision (re-read before planning; stale base revision → plan re-validated or rejected with a conflict message). Undo/redo uses the editor's existing history: "undo the last change" issues the inverse command set of the most recent approved AI operation.

## W6 — Render + verify
Approved timeline → existing durable RENDER_TIMELINE job → ffprobe validation → QA checklist → report. A completed timeline update is reported as "timeline updated", never as "render complete".
