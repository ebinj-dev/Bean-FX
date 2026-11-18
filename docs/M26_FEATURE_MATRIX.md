# M26 — Feature Matrix

Legend: **VERIFIED** (live evidence) · **AUTOMATED** (tests) · **REUSED** (pre-existing, verified this milestone) · **NOT IMPLEMENTED** / **CONFIGURATION REQUIRED** (honest).

## P1 — Advanced timeline editing
| Feature | Status | Where / Evidence |
|---|---|---|
| Ripple editing | REUSED | `RippleDelete` command + toolbar/context menu/Delete key |
| Roll editing | REUSED | `compileRoll` + context-menu Roll edge ±1f |
| Slip / slide editing | REUSED | tools Y/U + drag paths |
| Track lock/mute/solo/visibility | REUSED | Track model + header toggles |
| Snapping controls | REUSED | snap toggle + edge/playhead snapping (8px tol.) |
| Frame-accurate trimming | REUSED | `TrimClip` + ±2 frame snap search |
| **Timeline markers** | VERIFIED/AUTOMATED | new `AddMarker/RemoveMarker/UpdateMarker`; ruler flags; M key; engine tests (sorted, reversible) |
| **Clip grouping** | VERIFIED/AUTOMATED | `GroupClips/UngroupClips/SetClipGroup`; Ctrl+G/Ctrl+Shift+G + GROUP/UNGROUP buttons; reversible (tested) |
| **Multi-clip operations** | VERIFIED | existing multiSelect now wired to group/align/gap ops |
| **Range selection (I/O)** | VERIFIED | I/O keys + IN/OUT/CLR + ruler brackets; LIFT RANGE via `compileLift` |
| **Gap detection & removal** | VERIFIED/AUTOMATED | `CloseGaps` (transition/lock refusals tested) + CLOSE GAPS button |
| **Clip alignment** | VERIFIED/AUTOMATED | `AlignClipsToPlayhead` + ALIGN SEL button (tested reversible) |
| Sequence duplication | REUSED | M15 POST /api/projects/[id] duplicate |
| Keyboard editing shortcuts | VERIFIED | Space/arrows/S/Delete/Z/Ctrl+S/v-a-c-y-u-h-z-t-r + NEW i/o/m/Esc/Ctrl+G |
| Drag-roll tool | NOT IMPLEMENTED (honest) | context-menu roll kept; drag surgery deferred |
| Effect-parameter keyframes | NOT IMPLEMENTED (honest) | property keyframes (opacity/scale/x/y/rotation/blur/volume…) exist; per-effect-param keyframes do not |

## P2 — Professional audio
| Feature | Status | Evidence |
|---|---|---|
| Per-track volume (fader) | VERIFIED/AUTOMATED | `UpdateTrack.volume`; preview gain + export volume expression; mixer faders |
| Clip-level gain | REUSED | `ChangeVolume` + inspector slider |
| Audio keyframes | REUSED | M17/M18 automation strip → preview + export |
| Fade in/out | REUSED | `fadeIn/OutFrames` + afade + inspector |
| **Clip pan** | VERIFIED | Web Audio panner + `pan=stereo` FFmpeg (equal-power) + inspector PAN slider |
| Crossfades (video) | REUSED | xfade transitions |
| Audio ducking | REUSED | GANGZII duck-music preset |
| Loudness analysis | REUSED | BS.1770-4 K-weighted (real DSP) |
| Peak/clipping detection | REUSED | GangziiInspection measured facts |
| Normalization / noise reduction / voice enhancement | REUSED | loudness modes + 11 presets |
| **Audio monitoring (meters)** | VERIFIED | mixer drawer REAL AnalyserNode peaks (idle = honest 0) |
| Processing history | REUSED | GangziiProcess rows + audio tool |

## P3 — Effects & color
| Feature | Status | Evidence |
|---|---|---|
| Brightness/contrast/saturation/exposure/temperature/tint/blur/sharpen/crop | REUSED + **VERIFIED UI** | filter registry (FFmpeg+CSS dual mapping) now surfaced in the browser COLOR section |
| Transform (position/scale/rotation/opacity) | REUSED | transform controls + keyframes |
| Grayscale | REUSED | hue=s=0 |
| Effect stacking / enable-disable / reset | REUSED | ordered array, enabled flags, per-param reset, bypass-all |
| **Effect copy/paste** | VERIFIED | Copy FX / Paste FX (reversible batches) |
| Color presets | VERIFIED (P4) | save any clip's effect stack as VIDEO_EFFECT preset |
| Effect-parameter keyframes | NOT IMPLEMENTED (honest) | see P1 note |

## P4 — Creative presets
| Feature | Status | Evidence |
|---|---|---|
| Kinds | VERIFIED | VIDEO_EFFECT / CAPTION / EXPORT / AUDIO |
| Save from selection | VERIFIED | captures engine state (effect stack / caption style) |
| Apply to selection | VERIFIED | reversible AddEffect / UpdateClipProperties batches |
| Rename / duplicate / delete-confirm | VERIFIED/AUTOMATED | PATCH/POST/DELETE + 412 typed-name safeguard (tested) |
| Unique names (no overwrite) | AUTOMATED | 409 on clash (tested) |
| Version compatibility | AUTOMATED | version field bumped on payload update |
| Export preset sets | VERIFIED | EXPORT payloads consumed by batch drawer |

## P5 — Batch production
| Feature | Status | Evidence |
|---|---|---|
| Batch export (multi-profile) | VERIFIED/AUTOMATED | batch-export route (max 8) → real ExportVariant pipeline |
| Idempotency (no dup jobs) | VERIFIED | unique active variant per (master, profile); refresh-safe (contract tested) |
| Queue management + per-job progress | VERIFIED | variant queue UI (poll 3s), stage/error shown |
| Cancellation | REUSED/VERIFIED | DELETE /api/publish/variants/[id] → worker cancel |
| Retry | REUSED | M9 retry route |
| Failed-job recovery | REUSED | worker resetAssetMarkers + attempts/backoff |
| Export history | REUSED | ExportFile rows + drawer list |
| Multi aspect-ratio outputs | REUSED | profile registry (16:9 / 9:16 / 1:1 / custom) |
| Social platform profiles | REUSED | YouTube/Shorts/Reels/TikTok/square |
| Plan entitlements respected | REUSED | M25 hooks on render/variant paths |

## P6 — AI-assisted production (reuse)
| Engine | Workflows | Status |
|---|---|---|
| RIISHE | transcript-based editing, autocut, captions | REUSED (M4) |
| GANGZII | cleanup/voice/loudness/quality | REUSED (M5) + template step |
| NIIKI | animated captions/motion/typography | REUSED (M6) templates |
| JAZMII | b-roll analysis/suggestions | REUSED (M11) + template step w/ approval gate |
| LAXII | thumbnails/images | REUSED (M11) + template step |
| MY AI | multi-step plans, approvals, orchestration | REUSED (M8/M21) |

## P7 — Workflow automation
| Feature | Status | Evidence |
|---|---|---|
| Whitelisted templates (4) | VERIFIED/AUTOMATED | render→review→variants / gangzii→render / analyze→gate / thumbnail |
| Step-by-step execution + persistent state | VERIFIED | WorkflowRun.stepsJson; tick executor |
| Real job dispatch | AUTOMATED | RENDER_TIMELINE / EXPORT_VARIANT / GANGZII_PROCESS / JAZMII_ANALYZE / LAXII_GENERATE |
| Approval gates (⚑) | VERIFIED/AUTOMATED | AWAITING_APPROVAL pauses run; refuse non-waiting approve (tested) |
| Cancellation | VERIFIED | run + waiting job cancelled (tested) |
| Safe step retry | VERIFIED/AUTOMATED | failed step re-dispatch (tested) |
| Execution history | VERIFIED | runs list (20) + per-step states |
| Failure reporting | AUTOMATED | missing sequence/media fail honestly (tested) |
| No code execution | AUTOMATED | POST /api/workflows rejects non-whitelisted ids (tested) |
| LAXII/JAZMII providers | CONFIGURATION REQUIRED | steps fail honestly without providers (tested) |

## Totals
VERIFIED 24 · AUTOMATED 17 · REUSED 30+ · NOT IMPLEMENTED (honest) 3 · CONFIGURATION REQUIRED 2 (providers; unchanged M21/M22 items).
