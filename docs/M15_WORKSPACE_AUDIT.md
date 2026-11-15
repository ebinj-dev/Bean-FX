# M15 Workspace Audit — why BEAN FX did not feel like an editing application

Audited 2026-15-11 against `feature/ai-creative-studio` @ `03d2778`. Finding: **the editing application already exists and is real — it is the presentation layer and routing that hide it.** Nothing needed to be re-implemented; everything needed to be re-*organized*.

## Root causes (traced, not assumed)

1. **The landing page sells AI tools, not editing.** `/` renders `landing.tsx`; the site header (`nav-items.ts`) navigates to AUTO CUT / CAPTIONS / WATERMARK / AUDIO / B-ROLL tool pages. The editor is one link among six (`#/editor`), and the project dashboard (`#/studio`) does not open it directly — the primary surfaces present BEAN FX as a collection of standalone AI utilities.
2. **The real editor is buried as a "tool" route.** `tools/editor.tsx` mounts the genuine editing application: `useEditorSession` (M1 command engine client with versions/undo/redo/autosave/conflict handling), `ProgramMonitor`, `EditorTimeline`, `ClipInspector`, plus every AI engine panel. But its chrome is a single flat toolbar row + a stacked right column, which reads as a utility page rather than a desktop NLE.
3. **The timeline is genuinely multitrack in the model but visually single-lane-ish.** `src/lib/editor/model.ts` supports 64 tracks across VIDEO/AUDIO/CAPTION/GRAPHIC/OVERLAY with clips, transforms, keyframes, effects and transitions, and the command engine implements 22 commands (Split/Trim/Move/RippleDelete/Insert/Replace/Transitions/Effects/Keyframes/Volume/Speed/ClipProperties) with inverse generation and a validity gate. The timeline UI renders all tracks with move/trim drag, visibility/mute/solo/lock and zoom — but lacks pro tool modes (razor/slip/slide/hand/zoom as pointer modes), waveforms, keyframe markers, track height/reorder, copy/paste, context menus.
4. **AI engines are stacked as a vertical panel column**, not a contextual AI Studio; panels do not receive the current selection.
5. **No in-editor media import.** The media rail says "upload through any tool" — the resumable upload API exists (`/api/media/upload/*`, M3 pipeline; the worktree copy had been deleted by an environment auto-commit `b813cf8` and was RESTORED from the remote branch before any M15 work) but the editor never calls it.
6. **No interactive composition canvas.** M14 introduced a canonical composition evaluator (server-side PIL renderer + shared per-frame state), and the monitor overlays graphics/captions — but layers are not selectable/manipulable on the preview.

## What is reused as-is (verified implementations)

| Asset | Status |
|---|---|
| M1 command engine + versioning + autosave + optimistic concurrency | reused unchanged — all M15 edits flow through it |
| M1 multitrack sequence model (rational FPS, integer frames) | reused unchanged |
| `use-editor-session` (client session: save states, conflict reload, undo/redo) | reused unchanged |
| `ProgramMonitor` (real decoded video via `/api/media/[id]/file`, frame-accurate preview loop) | reused, extended (canvas layer) |
| `EditorTimeline` interaction math (`interaction.ts`: zoom/x↔frame/clip hit/move/trim previews) | reused, extended (tool modes, waveforms, keyframes) |
| `ClipInspector` | reused, extended (keyframe controls, effects) |
| Waveform API (`/api/media/[id]/waveform`) + peaks renderer | newly wired into the timeline (was tool-only) |
| Upload pipeline (`/api/media/upload/*` resumable, M3) | route restored; new media browser import UI |
| All AI engine panels (RIISHE/GANGZII/NIIKI/JAZMII/LAXII/MY AI/Social/Publishing/Creative Director M7–M14) | reused, re-hosted in a unified contextual AI Studio |
| M14 composition evaluator + renderer | reused for the interactive canvas + parity tests |
| M9 publishing/export + FFprobe validation | reused as the Export workspace |

## Rejected approaches
- Building a "second timeline engine" or new persistence: forbidden and unnecessary.
- Replacing `tools/editor.tsx` state logic: unnecessary — its session/playback/command plumbing is correct; only the shell/JSX was restructured.
- Canvas rewriting composition properties independently of the model: forbidden; the canvas reads the same sequence + preview evaluators the export path uses.
