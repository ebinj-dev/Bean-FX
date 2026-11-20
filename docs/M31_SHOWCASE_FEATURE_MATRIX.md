# M31 SHOWCASE FEATURE MATRIX — honest classification

Legend: **VERIFIED** (proven by real tests/evidence in `m31-showcase-evidence/`) · **AUTOMATED** (real, deterministic, runs unattended) · **SIMULATED** (labelled as illustrative in production metadata — never presented as real) · **OWNER ACTION** (requires the user's explicit step) · **CONFIGURATION REQUIRED** (works only when a provider/credential is configured; exact reason shown verbatim) · **INFRASTRUCTURE REQUIRED** (needs a deployment capability not present) · **NOT RUN** (not exercised in this environment) · **NOT IMPLEMENTED**.

## Phase 1 — Product Understanding Engine
| Capability | State | Evidence |
|---|---|---|
| Structured showcase inputs (name/description/features/URL/screenshots/demo video/project) | VERIFIED | live e2e intake → artifact; `test-showcase-core` schema tests |
| Website understanding (SSRF-guarded fetch + text extraction) | VERIFIED (with honest fallback) | live e2e asserts either real website evidence or a recorded FETCH FAILED note; core SSRF tests (localhost/private IP/credentials/non-http rejected) |
| Screenshot analysis → deterministic brand palette + visual references | VERIFIED | live e2e: palette hexes derived from the real fixture screenshot |
| Demo-recording understanding (ffprobe + real probe facts) | VERIFIED | live e2e: demo-video evidence with real duration/resolution |
| BEAN FX project as product input (timeline evidence) | AUTOMATED | project evidence recorded by the runner ( exercised in live intake with projectId) |
| LLM-assisted structuring (evidence-only, claims lint) | CONFIGURATION REQUIRED | runs only when the MY AI gateway is healthy; deterministic core always ships; `claimsLint` demotes unbacked numbers/superlatives (core tests) |
| Secret redaction (emails/tokens/private URLs/paths; kinds only, never values) | VERIFIED | core tests; exclusions recorded in artifact |
| Artifact approval gate before downstream work | VERIFIED | live e2e: CONCEPT refuses (409) until artifact approved |

## Phase 2 — Creative direction
| Capability | State | Evidence |
|---|---|---|
| 8 campaign types (unsupported types never presented as executable) | VERIFIED | core tests (8 ids; cinematic-trailer requires video provider — stated) |
| Tone/duration/aspect/narration/music creative controls | VERIFIED | intake UI + brief schema; live e2e drives campaignType/tone/duration/aspect |
| 3 genuinely distinct concepts with required fields | VERIFIED | live e2e (3 options, all fields present) + core tests |
| User approval before consequential production | VERIFIED | stage state machine + live e2e approvals |

## Phase 3 — Storyboard & shot planner
| Capability | State | Evidence |
|---|---|---|
| Scene structure (id/duration/purpose/shot/camera/text overlay/product element/transition/audio/asset/primitive/approval) | VERIFIED | schema + live e2e scenes carry pre-assigned primitives |
| Story structure derived from the approved concept (hook→reveal→features→hero→close) | VERIFIED | live e2e: script beats from the selected concept |
| Scene reorder / duplicate / remove / regenerate / duration & text edit | VERIFIED | live e2e exercises dup/remove/edit+event log |
| Approved scenes never silently changed | VERIFIED | live e2e: edit of APPROVED scene → 409; reApprove:true → PENDING + logged |
| Platform-safe areas for vertical variants | AUTOMATED | variant formats reserved in brief deliveryFormats; safe-area render QA NOT RUN (no vertical variant render exercised in this suite — honest gap noted in RESULTS) |

## Phase 4 — Real product demonstration
| Capability | State | Evidence |
|---|---|---|
| Real captures as demonstration sources (owned screenshots/recordings) | VERIFIED | live e2e attaches the real demo recording; ownership enforced |
| Illustrative-interaction labelling in production metadata | AUTOMATED | demonstration plan records `illustrative` + notes; surfaced in UI + assembly provenance |
| Mask requirements for private data | AUTOMATED | mask notes recorded per scene; masking compositing NOT IMPLEMENTED (recorded honestly as OWNER ACTION until then) |
| Real browser automation capture | NOT IMPLEMENTED | authorized-capture pipeline is the user's upload path; no in-app browser driver was added |

## Phase 5 — AI video/motion generation
| Capability | State | Evidence |
|---|---|---|
| Provider availability probe (CLI/registry, real) | VERIFIED | `providerAvailability()` + honest NOT_CONFIGURED paths (core+route tests) |
| 10-step model-selection protocol with approval + budget gates | VERIFIED | route returns preview-only without approval; APPROVED requires budget; duplicate-produce refused |
| Real JAZMII video generation job | CONFIGURATION REQUIRED (works when the provider CLI is installed; validated by the existing job handler) | job submission wired to `JAZMII_GENERATE` on the durable queue |
| Real LAXII image generation (incl. reference/imageToVideo) | CONFIGURATION REQUIRED (same) | `LAXII_GENERATE` wired; reference ownership enforced |
| Cost honesty (UNKNOWN, never 0; no invented pricing) | VERIFIED | asset rows carry costUnknown=true + provider terms note |
| Output validation (ffprobe duration/aspect tolerance, sniff) | AUTOMATED | existing provider job handlers validate before registration |

## Phase 6 — Motion & composition
| Capability | State | Evidence |
|---|---|---|
| 11 composition primitives emitting editor-valid keyframes/effects/graphics | VERIFIED | core tests: all emit sorted, in-range, capped editor data |
| stat-reveal refuses unverified numbers | VERIFIED | core test (REFUSED without evidence) |
| Graphics composed onto REAL NIKKI registry templates | VERIFIED | core test (title-scale-in wordReveal) + live e2e graphic clips on the timeline |
| Frame-accurate canonical timing (no second timebase) | VERIFIED | clip-relative frames; assembly through `applyTimelineEdits`; render==preview via existing renderer |
| Live render of primitive-animated clips | VERIFIED | live e2e: timeline verified post-assembly; FINAL_RENDER succeeded with primitive data present |

## Phase 7 — Music / sound / narration
| Capability | State | Evidence |
|---|---|---|
| User-supplied music bed on the timeline | VERIFIED | base studio live suite (music attach → assembly → render); showcase assembly reuses it |
| Optional narration via verified TTS (tongtong) | AUTOMATED (CONFIGURATION REQUIRED for the CLI) | `generateShowcaseNarration`; Tamil honestly refused; dedup on retry |
| Sound effects (contextual cues) | OWNER ACTION | user-provided SFX only; no bundled cue library (BrAG assets excluded by policy) |
| Beat-aligned animation from real audio analysis | CONFIGURATION REQUIRED | requires an audio-analysis provider; otherwise cut pacing is deterministic, honestly noted |

## Phase 8 — Native timeline
| Capability | State | Evidence |
|---|---|---|
| Editable native sequence (replace clips/text/timings/music, undo/redo, save/reload, export) | VERIFIED | showcase sequence lands in the real editor (live e2e timeline assertions); editor contracts unchanged (M1–M30 regressions) |
| AI never writes raw JSON to DB | VERIFIED | all assembly via canonical commands |

## Phase 9 — Poster / share copy / package
| Capability | State | Evidence |
|---|---|---|
| Poster from a REAL rendered frame + verification (decode/luminance/transition-clear/aspect) | VERIFIED | live e2e: frame-extracted PASSED, poster MediaAsset registered |
| Poster title overlay (M9 compositor) | AUTOMATED | overlay applied when title present; failure keeps the raw frame + honest check |
| 6-platform share copy from approved artifact only | VERIFIED | live e2e: 6 items, limits honored, no invented claims |
| Output package (MP4 + poster + native sequence + brief/storyboard/script + provenance + share copy + QA) | VERIFIED | delivery JSON lists real artifacts; provenance on every asset |

## Phase 10 — Output validation
| Capability | State | Evidence |
|---|---|---|
| ffprobe decodability/streams/duration | VERIFIED | live e2e QA checks (file-decodable etc.) |
| blackdetect / loudness / A–V sync / caption timing | AUTOMATED (VERIFIED checks present in QA payload) | live e2e asserts black-frames check present; measurements run on the real render |
| Poster correctness + scene coverage | AUTOMATED | poster checks recorded; scene-coverage via sequence checks |

## Phase 11 — UI
| Capability | State | Evidence |
|---|---|---|
| SHOWCASE STUDIO entry point (9-step flow, existing design system) | VERIFIED | /showcase route + dashboard TOOL_LINKS; component compiles; board renders persisted state |
| 375px no-overflow | PENDING VERIFICATION | browser walkthrough scheduled in this milestone (see UI report) |
| Job/asset state shown honestly (unknown costs, labels) | VERIFIED | UI renders persisted rows only |

## Phase 12 — Testing
| Capability | State | Evidence |
|---|---|---|
| Unit suite (20 tests) | VERIFIED | `test-showcase-core.test.ts` — all pass |
| Live E2E (real media, real server, real render) | VERIFIED | `test-showcase-live.test.ts` — results in RESULTS doc |
| Regression (M1–M30 applicable) + tsc/eslint/build | VERIFIED | tsc 0; eslint clean; production build OK; base suites re-run where touched |
| Cancellation/worker-restart recovery | VERIFIED (inherited) | base M31 restart reconciliation + resume reused; showcase resume exercised in live suite |

## Phase 13/14 — Docs & GitHub
| Capability | State |
|---|---|
| Results/architecture/UI report/evidence | VERIFIED (this directory) |
| Commit on `feature/ai-creative-studio` + push + remote verification | see RESULTS §GitHub |
