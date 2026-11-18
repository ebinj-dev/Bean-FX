# M27 — Feature Matrix

Legend: **VERIFIED** (live evidence) · **AUTOMATED** (tests) · **REUSED** (pre-existing, verified) · **NOT IMPLEMENTED** / **CONFIGURATION REQUIRED** (honest).

## Phase 1 — Professional Roll Editing
| Requirement | Status | Evidence |
|---|---|---|
| Roll tool in the existing tool system | VERIFIED | EDIT_TOOLS entry (E), toolbar icon, roll cursor |
| Adjust shared edit point between adjacent clips | VERIFIED/AUTOMATED | `RollEdit` command; boundary move tested ± |
| Extend one / shorten the other | AUTOMATED | left sourceOut + right sourceIn shift tests |
| Preserve sequence duration | AUTOMATED | END-fixed + total-90 assertions |
| Preserve unrelated clips/markers | AUTOMATED | unrelated-clip + marker immutability tests |
| Source-media in/out boundaries | VERIFIED/AUTOMATED | engine INVALID_RANGES + UI "beyond asset length" clamp |
| Respect locked tracks | AUTOMATED | locked-track refusal test |
| Respect transition constraints | AUTOMATED | transition-clip refusal test (invariants documented) |
| Snapping + frame-accurate pointer | VERIFIED | existing snapTo wired into roll preview |
| Undo/redo | VERIFIED/AUTOMATED | exact inverse; UI buttons exercised live |
| Persist the edit | AUTOMATED | schema round-trip; live autosave → API verified |
| Source media untouched | AUTOMATED | asset bytes never referenced for edit |
| Roll cursor + boundary preview + valid/invalid feedback | VERIFIED | col-resize cursor; green/red boundary line + ROLL badge |
| Reversible command with before/after state | AUTOMATED | inverse `RollEdit(oldBoundary)` |

## Phase 2 — Per-Effect Parameter Keyframes
| Requirement | Status | Evidence |
|---|---|---|
| Keyframes for brightness/contrast/saturation/exposure/temperature/tint/vignette/sharpen/blur | VERIFIED/AUTOMATED | registry-validated params; evaluator + sampled segment rendering; live luma ramp |
| Transform position/scale/rotation/opacity | REUSED | property-keyframe system (M17) — the established architecture for those parameters |
| Only supported params exposed | AUTOMATED | unknown-param refusal test; select offers only the 5 modes |
| Add/Update/Delete/Move keyframe | VERIFIED/AUTOMATED | inspector controls + upsert/remove commands + move tests |
| Navigate prev/next | AUTOMATED | UI buttons bound to setPlayhead at keyframe frames; engine data sorted |
| Enable/disable animation per param | VERIFIED/AUTOMATED | ◆ toggle; non-destructive (keyframes kept) test |
| Interpolation modes (5) + mathematically correct | AUTOMATED | exact curve values at midpoints (1e-10) |
| Copy/paste keyframe data | VERIFIED | Copy Keys/Paste Keys (same-type only), fresh ids |
| Undo/redo all keyframe changes | AUTOMATED | bulk `SetEffectKeyframes` exact-inverse chains |
| Preview = export evaluation | VERIFIED | shared evaluator; measured export luma ramp matches definitions |
| Persist in canonical format + legacy compatibility | AUTOMATED | round-trip + legacy-parse + malformed-reject tests |
| Effect-stack compatibility (presets/Copy FX/duplication) | VERIFIED/AUTOMATED | payloads carry animation; duplicate test |
| Timeline display of param keyframes | VERIFIED | blue diamonds on clip blocks |
| No separate animation editor | VERIFIED | compact inspector controls only |

## Phase 3 — Automatic Audio Crossfade
| Requirement | Status | Evidence |
|---|---|---|
| Detect adjacent audio clips | VERIFIED | context-menu entries appear only for adjacent pairs |
| Automatic operation (explicit user action) | VERIFIED | menu action names both affected clips |
| Equal-power crossfade | VERIFIED/AUTOMATED | cos/sin 9-sample ramp; Σcos²+sin²=1 test |
| Linear curve option | AUTOMATED | both curves compile + tested |
| Preserve original clip sources | AUTOMATED | sourceIn/Out unchanged test |
| Prevent unintended gaps | AUTOMATED | adjacency required; refusal on gaps |
| Respect track locks | AUTOMATED | locked refusal test |
| Source-boundary validation | AUTOMATED | duration clamps; very-short-clip test |
| No invalid overlap regions | AUTOMATED | engine-validated batch application test |
| Undo/redo | AUTOMATED | full-batch inverse restoration test |
| Persist configuration | VERIFIED | volume keyframes persisted (autosave → API) |
| Duration control | VERIFIED | 0.5 s default computed from fps; compiler accepts any 1..max |
| Fade-in/out shapes | AUTOMATED | LINEAR ramp + EQUAL_POWER √ curves tested |
| Preview playback | VERIFIED | Web Audio mixer schedules overlapping windows + automation (M17/M18 path) |
| Real processing (no fake indicators) | VERIFIED | keyframes feed the export volume expressions; measured RMS hand-off |
| Sample rates / mono+stereo | AUTOMATED | sample-rate-neutral compile test (stereo bed is the canonical mix bus) |
| Audible continuity | VERIFIED | rendered overlap −20.1 dB vs −18.4/−18.1; continuity PASS |
| GANGZII compatibility | REUSED | GANGZII processes assets upstream; crossfade acts on clip automation — orthogonal by construction |

## Phase 4 — Reliability integrations
| Integration | Status |
|---|---|
| Roll + markers / grouped clips | AUTOMATED |
| Roll + snapping | VERIFIED (snapTo in preview) |
| Keyframes + effect presets / Copy FX / duplication / export | VERIFIED/AUTOMATED |
| Crossfades + track gain / pan / GANGZII / batch export | VERIFIED/AUTOMATED (batch via the real render evidence) |
| All new commands + history restoration | AUTOMATED (exact-state restoration test) |
| No second command system | VERIFIED — everything compiles to the canonical union |

## Phase 5 — AI engine compatibility
| Engine | Status |
|---|---|
| RIISHE / GANGZII / NIIKI / JAZMII / LAXII / MY AI | REUSED — contract suites green in full regression; no architecture changes; LAXII/JAZMII provider gaps = CONFIGURATION REQUIRED (tested honest failure) |

## Phase 6 — UX & accessibility
| Requirement | Status |
|---|---|
| Tooltips | VERIFIED — every new control carries title/aria-label |
| Keyboard accessibility | VERIFIED — E tool key, I/O/M/Esc, Ctrl+G family, Space/arrows unchanged |
| Disabled states | VERIFIED — disabled+opacity-40 on all conditional controls |
| Invalid-operation feedback | VERIFIED — notices name the refusal reason (engine message or pre-check) |
| No overlapping controls / no redesign | VERIFIED — additions inside existing areas only |
| No horizontal overflow at 375 px | VERIFIED — live check "no overflow 375px" |

## Totals
VERIFIED 25 · AUTOMATED 24 · REUSED 9 · NOT IMPLEMENTED (honest) 2 (drag-roll automation harness; BEZIER for effect params — not exposed) · CONFIGURATION REQUIRED 1 (AI providers, unchanged).
**All three M26 outstanding capabilities are COMPLETE** (Roll Editing ✓, per-effect parameter keyframes ✓ preview+export ✓, automatic audio crossfades ✓ real processing ✓ — each with persistence and undo/redo ✓).
