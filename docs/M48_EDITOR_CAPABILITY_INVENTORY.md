# M48 — EDITOR CAPABILITY INVENTORY (PHASE ZERO AUDIT)

Audited at `81ff3fe16d07a730490ece79bec3d53f1c8f4288` (main, PR #45 merged). Method: complete read of
all 24 editor components + shell, all 17 engine modules, all 7 editor API routes + media/chat routes,
and all 8 editor test suites. Labels: **VERIFIED** (real test/evidence), **PARTIAL** (works but
disclosed gaps), **UNVERIFIED** (no test/evidence), **MISSING**, **CONDITIONAL**, **LICENSE-BLOCKED**.
"Preview/Export" states whether the user sees the effect before rendering AND it appears in the final file.

## 1. Control census (from the component audit)

- ~430 REAL controls (dispatch canonical commands or real APIs and persist).
- ~30 REAL-session controls (playhead, selection, tool modes, snap) — real behavior, intentionally not persisted.
- ~28 PREVIEW-ONLY (zoom, guides, track heights, range I/O, COMPARE hold, clipboards).
- **0 decorative controls**; 0 permanently-dead controls (honest conditional gating used instead).

## 2. Editing engine (canonical; nothing bypasses it)

| Capability | Implementation | Preview | Export | Persistence | Tests | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Command system | 36 zod-validated command types, registry 1:1 (`timeline.*` ids), risk classes, destructive⇒approval | preview==apply by construction | — | versioned snapshot + per-command audit rows | registry 25 + commands 24 tests | **VERIFIED** |
| Atomic batches | `applyTransaction` clone-and-abort | — | — | single version per batch | atomic-abort tests | **VERIFIED** |
| Undo/redo | engine-built inverses, 200-entry session stack, undo persisted as batches | live | — | yes (as new versions) | round-trip tests | **VERIFIED** (redo stack session-only — documented) |
| Optimistic concurrency | `baseVersion` + DB unique constraint → 409 with head | — | — | append-only versions | REVISION_CONFLICT tests + E2E stale-409 | **VERIFIED** |
| Rational fps + timecode | `time.ts` SMPTE families incl. drop-frame; format only (no parser) | — | — | — | 8 time tests | **VERIFIED / PARTIAL** (no timecode parsing — no Go-to field) |
| Tools: select/razor/trim/move/slip/slide/roll | real math in `interaction.ts`, frame-exact preview==engine | live | — | via commands | 16 interaction tests | **VERIFIED** |
| Tools: hand/zoom/text/transform (math) | UI implementations, no dedicated math module | live | — | — | none specific | **PARTIAL** |
| Track state (visible/mute/solo/lock/volume/height) | `UpdateTrack` + local heights | live | mute/solo/volume yes; height n/a | commands; heights local | covered | **VERIFIED** (heights session-only) |
| Markers | Add/Remove/UpdateMarker (frame+label) | ruler | n/a | commands | partially covered | **VERIFIED** (no color/duration) |
| Groups | GroupClips/UngroupClips, group-move | live drag | — | commands | registry tests | **VERIFIED** |
| Snapping | grid-only `snapFrame` | live | — | — | snap tests | **PARTIAL** (no clip-edge/playhead/marker snap) |
| Range I/O (timeline) | session-local only; consumed by LIFT RANGE | overlay | NOT a render range | not persisted | none | **PARTIAL** (orphaned vs export) |

## 3. Timeline operations (§6.2 mapping)

| Operation | State | Notes |
| --- | --- | --- |
| Insert edit | **MISSING wiring** | `compileInsert` exists in `edits.ts`, no UI invokes it |
| Overwrite edit | **MISSING wiring** | `compileOverwrite` exists, no UI |
| Append edit | **MISSING** (place-at-playhead only) | trivial via AddClip at sequence end |
| Replace edit | **VERIFIED** | `ReplaceClip` + relink UX |
| Lift / Extract / Ripple delete | **VERIFIED** | commands + UI |
| Ripple trim / rolling trim | **VERIFIED** | RollEdit + ripple via RippleDelete; ripple-trim-mode absent |
| Slip / Slide / Rate stretch | slip+slide **VERIFIED**; rate stretch = ChangePlaybackSpeed **VERIFIED** | extend edit MISSING |
| Split edit (A/V) | **MISSING** | clips move whole; no split A/V edges |
| Close gaps / Align to playhead | **VERIFIED** | commands exist |
| Copy/paste clips | **PARTIAL** | single-clip local clipboard only |
| Copy/paste attributes/effects | **PARTIAL** | effect clipboard is module-global; keyframe paste exists; attributes partial |
| Track targeting | **MISSING** | placement always targets dropped/active track implicitly |
| Track lock/sync-lock/mute/solo/visibility | lock/mute/solo/visible **VERIFIED**; sync-lock **MISSING** |
| Waveforms / thumbnails | thumbnails **VERIFIED** (160px posters); waveforms **VERIFIED** — the timeline renders real peaks from `/api/media/[id]/waveform` on AUDIO-track clips (min/max, per-asset cache; corrected during M48-C implementation — the initial component-scan missed it) |
| Timeline range export | **PARTIAL** | manual seconds inputs; I/O range not wired; **BUG: custom-range math hardcodes 30 fps** |
| Edit-point navigation (next/prev edit/marker) | **MISSING** |
| Match frame / source-record nav | **MISSING** (no Source Monitor) |

## 4. Monitors and preview

| Capability | State | Notes |
| --- | --- | --- |
| Program Monitor | **VERIFIED** | real decode pool, WebAudio mix, canvas layers, timecode, dropped-frame telemetry |
| Source Monitor | **MISSING** | no source inspection, no source in/out marking, no three-point editing |
| Fullscreen preview | **MISSING** (`requestFullscreen` absent) |
| Preview quality / proxy playback tiers | **MISSING** |
| Transform overlays (drag/scale/rotate/nudge) | **VERIFIED** (`composition-canvas.tsx`) |
| Safe-area guides | **VERIFIED** (overlay only) |
| Multi-track compositing preview | **PARTIAL** | preview resolves ONE video clip (overwrite); export composites alpha/overlays — disclosed mismatch |
| Video fades (fadeIn/outFrames) | **PARTIAL** | persisted + exported; **invisible in preview** (audio-only preview) |
| Transitions preview | **VERIFIED** | 12 kinds; ZOOM_OUT honestly renders as a cut (disclosed) |
| VFX preview (chroma/masks/motion-blur) | **VERIFIED** canvas path ≤1280px, parity tests |

## 5. Effects, color, motion (all map to `filters.ts` — one registry → FFmpeg + CSS/canvas)

| Capability | State | Notes |
| --- | --- | --- |
| 9 color effects (brightness/contrast/saturation/exposure/temperature/tint/highlights/shadows/whites/blacks/vignette) | **VERIFIED preview+export parity** | highlights/shadows/whites/blacks are brightness approximations — **PARTIAL** (disclosed APPROXIMATE_PREVIEW) |
| Grayscale/flipH/flipV/blur/sharpen/opacity/crop | **VERIFIED** | sharpen is export-only (no CSS) — **PARTIAL** |
| Chroma key, rect/ellipse masks, motion blur | **VERIFIED** canvas+export | |
| Keyframes (property + effect-param) | **VERIFIED** engine+tests; **BUG: inspector "keyframe at playhead" always lands at frame 0 (playhead prop not passed)** | animation export = 10-frame steps for most filters (expr path disabled) — **PARTIAL** |
| Scopes (waveform/parade/vectorscope/histogram) | **MISSING** |
| LUT import/management | **MISSING** (no LUT support; not license-blocked — implementable later) |
| Color management (ACES/ICC/HDR) | **MISSING** (documented sRGB assumption) |
| Blend modes, adjustment layers, nesting | **MISSING** |
| Motion tracking / optical flow | **MISSING**; stabilization **VERIFIED** (libvidstab two-pass, GPL disclosed) |
| Speed ramps | **VERIFIED** (ChangePlaybackSpeed + setpts/atempo) |
| NIIKI graphics (templates, keyframes, proposal) | **VERIFIED** (M14 pipeline) |

## 6. Audio

| Capability | State |
| --- | --- |
| Clip volume/pan/fades/automation keyframes | **VERIFIED** preview(WebAudio)+export(volume expr/pan/afade) |
| Track fader/mute/solo + real meters | **VERIFIED** |
| Waveform display | **VERIFIED** — timeline AUDIO clips draw real min/max peaks from the cached waveform API (audio tracks only; video clips' embedded audio not drawn — acceptable, disclosed) |
| EQ/compressor/limiter/ducking/buses | **MISSING** in engine — GANGZII offline processing pipeline **VERIFIED** (real ffmpeg chains: noise/hum/deess/click/DC/loudness/trim/compressor/limiter) |
| Audio-track transitions as crossfades | **PARTIAL/BUG-adjacent**: model accepts them, export mixes additively (documented) |
| Loudness measurement | **VERIFIED** (GANGZII measure); no live meter |
| Stems export | **MISSING** |

## 7. Media

| Capability | State |
| --- | --- |
| Upload (resumable, sha256 dedup, quota) + probe (ffprobe deep) | **VERIFIED** |
| Formats | probe-verified: MP4/MOV/MKV/WebM/WAV/MP3/AAC/M4A/PNG/JPEG/WebP; **AVI/MXF/TIFF unverified — CONDITIONAL (probe decides, never claimed)** |
| Thumbnails/posters | **VERIFIED** |
| Proxy workflow | **VERIFIED** (POST /api/media/[id]/proxy, idempotent; final renders always use originals — verified in renderer) |
| Stabilization | **VERIFIED** (real libvidstab, GPL disclosed) |
| Waveform API | **VERIFIED** (real decoded peaks, cached) |
| Media org: bins/tags/ratings/duplicate detect/relink bulk | **PARTIAL**: search+type filter exist; RelinkAssets command **VERIFIED**; bins/tags/ratings MISSING |
| Footage intelligence: scene/visual/temporal index, search | **VERIFIED** (M14 creative/visual + temporal, consent-gated, honest) |
| Transcript search | **PARTIAL** (transcripts exist, chunk-level timing, energy-estimated — honestly labeled) |
| Diarization / speaker ID | **LICENSE-BLOCKED/NOT APPROVED** (disclosed) |

## 8. Chat ↔ Editor

| Capability | State |
| --- | --- |
| Chat → Open in Editor deep link (`#/editor?project=`) | **VERIFIED** (three surfaces) — carries ONLY projectId; no conversationId/productionId/planId/exportId — **PARTIAL continuity** |
| Editor deep-link robustness | **PARTIAL**: mount-only parse; invalid/unowned id → inline 404 notice, no recovery |
| Chat plan cards | **PARTIAL**: "Review in Editor" only; **no approve/execute buttons in chat** |
| RIISHE in-editor dock (`riishe/chat`) | **VERIFIED** route (owner-only, intent classes, plans via /api/my-ai/plans, never applies directly) — conversation durability **PARTIAL** (localStorage synthetic ids; route ignores `model` param) |
| Editor AI dock (M47) | **PARTIAL**: routes to Studio plan→assemble, not arbitrary command translation; 300-char context |
| Return to Chat with continuity | **VERIFIED**: chat re-reads latest timeline head each turn (resolveProjectContext) — fresh revision visible |
| Render → chat video cards → Create New Version | **VERIFIED** |
| batch-export master kind | **BUG**: requires kind `VIDEO` but timeline renders produce `TIMELINE_RENDER` → fresh timeline masters not batch-exportable via this route |

## 9. Delivery/QC/collab

| Capability | State |
| --- | --- |
| Render (mp4/mov/wav/mp3), durable job, entitlement metering | **VERIFIED** |
| Post-render ffprobe QC (duration/dims/streams) | **VERIFIED** (violations rejected) |
| Batch export + variants (7 profiles) + retry/cancel | **VERIFIED** except the master-kind bug above |
| Publishing suite (thumbnails/metadata/brand/package) | **VERIFIED** |
| Collab (workspaces/invites/reviews/comments/links) | **VERIFIED** (SMTP absence honest) |
| Portability (archive/import/relink) | **VERIFIED** |
| SRT/VTT sidecar export | **PARTIAL**: SRT parsed on import + transcripts approve→SRT asset; timeline caption tracks → sidecar at render MISSING |
| Rate limiting on editor routes | **MISSING** (M47.4 limiter covers auth/media; editor timeline routes unthrottled) |

## 10. Workspace/layout/responsive

| Capability | State |
| --- | --- |
| Essentials/Pro modes | **VERIFIED** (panel config, localStorage, never touches data) |
| Resizable docks | **VERIFIED** (clamped, viewport-aware) |
| Responsive layouts (≤768/390/375px) | **MISSING** (fixed desktop shell; tab-wrap + dock clamping only) |
| Fullscreen preview | **MISSING** |

## 11. GAP REPORT → implementation plan (M48-B…F)

**P0 bugs (fix first):**
1. Inspector effect-keyframe playhead mis-wired (keyframes always at frame 0).
2. Custom-range render math hardcodes 30 fps (wrong ranges at other fps).
3. batch-export rejects `TIMELINE_RENDER` masters (fresh timeline renders not batch-exportable).
4. Stale snap tooltip ("S toggles").

**M48-B (Chat↔Editor):** deep-link carries conversation/production/plan/export + hashchange re-parse + invalid-project recovery; chat plan cards get approve/execute; editor↔chat context (Return to Chat passes back conversation).

**M48-C (media/timeline):** Source Monitor with source IN/OUT + Insert/Overwrite/Append (wires the dead compilers); waveform display on audio clips (existing API); timecode parsing + Go-to-timecode; next/prev edit-point + marker navigation; clip-edge/playhead/marker snapping; fullscreen preview; I/O range → render range.

**M48-D (finishing):** real computed scopes (waveform/RGB parade/vectorscope/histogram from the displayed frame); video fades visible in preview (parity fix); track-level compositing preview disclosed improvement where feasible.

**M48-E (intelligence):** expand 12 → 30+ schema-valid recipes (capability-validated); editing-grammar library with executable/partial/unavailable classification; curated trend feed with verifiable official sources + review dates; knowledge retrieval module (structured, keyword→knowledge selection) wired into RIISHE context; agent capability mapping test.

**M48-F (delivery/QC):** data-driven delivery profiles with source URLs + verification dates; SRT sidecar export from caption tracks; QC report surface; browser E2E + screenshots (desktop + narrow); 1000-clip performance test.

**Deliberately NOT in this milestone (honest):** multicam sync engine, ACES/ICC color management, LUT pipeline, nested sequences, split A/V edges, motion tracking, audio buses/EQ/ducking in the live engine, proxy playback tiers, mobile editing layout, server-persisted undo. Each is scoped with a continuation plan (see final report) — none is faked.
