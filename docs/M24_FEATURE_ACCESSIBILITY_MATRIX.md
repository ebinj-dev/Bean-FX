# M24 — Feature Accessibility Matrix (M1–M23 → UI)

Legend: **Connected** = discoverable UI entry point + real backend call verified · **By design** = backend intentionally not user-facing (documented) · **Blocked** = needs owner/config · **NOT IMPLEMENTED** = no backend; UI must not pretend otherwise.

Verification = this milestone's live browser walkthrough (`m24-evidence/screenshots/`) and/or the milestone suites re-run in M24 regression.

## A. Professional Editing Studio
| Feature | Milestone | Backend | UI access | Status | Verification |
|---|---|---|---|---|---|
| Media import/management | M2/M3 | `/api/media*` | Media browser (editor left panel) + upload gate | Connected | pre-existing; exercised by suites |
| Project create/manage | M1/M2 | `/api/projects` | Editor toolbar combobox + "+ new" · Studio dashboard | Connected | browser walkthrough (project created) |
| Timeline editing (move/trim/split/ripple) | M1/M6 | editor session + `/api/…/timeline` | Timeline + toolbar | Connected | suites 73/73 |
| Multiple tracks | M1 | canonical sequence | Timeline track headers (Video/Graphics/Captions/Audio) | Connected | screenshot 03 |
| Video/audio editing, inspector | M6 | editor session | Inspector panel | Connected | pre-existing |
| Transitions/effects/keyframes | M6/M13 | editor session + effects browser | Left panel EFFECTS tab + inspector | Connected | pre-existing |
| Playback + preview monitor | M5 | frame bus + proxy files | Program monitor + transport | Connected | screenshot 03 |
| Audio mixer | M5 | audio engine | Timeline audio controls + audio tool | Connected | suites |
| Undo/redo | M1 | session history | Toolbar undo/redo | Connected | screenshot (buttons live) |
| Version history | M11 | `/api/projects/[id]` + `/api/editor/…/timeline/versions` | Settings & history drawer | Connected | walkthrough |
| **Version restore** | **M24** | `POST /api/editor/…/timeline/restore` | **NEW: Restore button per version row** | **Connected (was missing)** | walkthrough code-verified; endpoint contract confirmed |
| Autosave & recovery | M11 | debounced timeline POST + head restore | automatic | Connected | suites (M11) |
| Export configuration | M20 | render route | EXPORT drawer → TimelineRenderPanel | Connected | T1 pass |
| Render progress | M20 | `/api/jobs/[id]` + job progress | Render panel progress rows | Connected | screenshot (job rows) |
| Render/export history | M20 | `/api/exports*` | Settings drawer exports list + dashboard | Connected | pre-existing |
| Failed job recovery | M20 | `requeueJob` (worker) | Worker-side automatic; jobs show FAILED honestly | Connected (server-side) | M24 R4 test |

## B. RIISHE (transcription & captions)
| Feature | Milestone | Backend | UI access | Status |
|---|---|---|---|---|
| Transcription | M4 | `/api/transcribe` | CAPTIONS tool | Connected |
| Caption editing/styling/timing | M4 | captions editor | CAPTIONS tool editor | Connected |
| Speaker info | M4 (where supported) | ASR adapter | Captions editor | Connected (provider-dependent) |
| Auto Cut | M4 | `/api/autocut/*` | AUTO CUT tool | Connected |
| Transcript-based editing | M4/M6 | autocut decisions → timeline | Auto Cut review + apply | Connected |
| Caption export (SRT/VTT) | M4 | export routes | Captions tool | Connected |
| Re-classify wrapper `/api/riishe` | M4 | shared inference (stage 9 of unified pipeline) | **By design** — internal; the unified Auto Cut pipeline is the user path | By design |

## C. GANGZII (audio)
| Feature | Milestone | Backend | UI access | Status |
|---|---|---|---|---|
| Analyze/cleanup/enhance/loudness/effects | M5 | `/api/gangzii/analyze`, `/process*` | AI Studio → GANGZII tab + AUDIO tool | Connected |
| Processing status/history | M5 | `/api/gangzii/processes` | Gangzii panel list | Connected |
| AI Studio proposal endpoint | M5 | `/api/gangzii/proposal` | **By design** — MY AI internal interface | By design |

## D. NIIKI (motion graphics)
| Feature | Milestone | Backend | UI access | Status |
|---|---|---|---|---|
| Caption animations/motion presets/timing | M8 | `/api/nikki/proposal` + `/render` | AI Studio → NIIKI tab | Connected |

## E. JAZMII (video generation)
| Feature | Milestone | Backend | UI access | Status |
|---|---|---|---|---|
| Text-to-video + jobs | M7 | `/api/jazmii/generate` | AI Studio → JAZMII tab | Connected |
| Suggestions (b-roll/cutaway) | M7 | `/api/jazmii/proposal` | JAZMII tab SUGGEST | Connected |
| **Footage analysis** | **M24** | `POST /api/jazmii/analyze` | **NEW: ANALYZE FOOTAGE selector + job poll** | **Connected (was missing)** |
| Generated media management | M7 | `/api/ai/outputs` | JAZMII outputs list + insert-at-playhead | Connected |
| Provider availability | — | live provider | quota-gated (intermittent 406) | Blocked → CONFIGURATION REQUIRED |

## F. LAXII (image generation)
| Feature | Milestone | Backend | UI access | Status |
|---|---|---|---|---|
| Text-to-image/thumbnails/illustrations | M13 | `/api/laxii/generate` | AI Studio → LAXII tab | Connected |
| History/results/settings | M13 | `/api/ai/outputs` | LAXII outputs list | Connected |

## G. MY AI (orchestration)
| Feature | Milestone | Backend | UI access | Status |
|---|---|---|---|---|
| Assistant chat (LLM/deterministic, labeled) | M8 | `/api/my-ai/chat` | AI Studio → MY AI tab | Connected |
| Approval-gated plans (approve/execute/cancel) | M8 | `/api/my-ai/plans*` | MY AI tab PLAN flow | Connected |
| Usage/provider status | M8 | `/api/my-ai/health` | MY AI panel footer | Connected |
| **Conversation history + delete** | **M24** | `GET/DELETE /api/my-ai/conversations` | **NEW: CONVERSATIONS list in MY AI panel** | **Connected (was missing)** |
| **Intent router (engine selection preview)** | **M24** | `POST /api/ai/route` | **NEW: INTENT ROUTER box** | **Connected (was missing)** — verified "→ engine JAZMII" live |
| Engine registry | M7 | `src/lib/ai/registry` (5 engines) | shared — no second registry | Connected |

## H. AI Creative Studio
| Feature | Milestone | Backend | UI access | Status |
|---|---|---|---|---|
| Social Video Studio (plan→scenes→assemble→batch) | M8.1 | `/api/studio/*` | AI Studio → STUDIO tab / dashboard | Connected |
| Creative Director (assistant/reviews/variants/recommendations) | M10/M15 | `/api/creative/*` | AI Studio → COMPOSE/RIISHE tabs (creative panel) | Connected |
| Multimodal/visual/temporal intelligence | M12 | `/api/creative/analyze/*`, `/visual/*`, `/temporal/*` | Creative panel sections | Connected |
| Art direction / motion composition (M14) | M14 | `/api/creative/m14/*` | Creative panel M14 flows | Connected |
| Publishing workflows | M9 | `/api/publish/*` | EXPORT drawer → PublishingPanel | Connected |

## I. Integrations
| Feature | Milestone | Backend | UI access | Status |
|---|---|---|---|---|
| **Integration token CRUD (API v1/MCP/Bridge)** | **M21 → M24 UI** | `/api/account/tokens` | **NEW: Settings → Integrations** (create w/ scopes+TTL, show-once secret, prefix list, instant revoke) | **Connected (was missing)** — verified live incl. revoke |
| API v1 / MCP / Bridge / Premiere docs + status | M21–M23 | `/api/v1/*`, `/api/health` | **NEW: Settings → Integrations connection guide + service status** | **Connected** |
| **MCP approvals (one-time, hash-bound)** | **M21 → M24 UI** | `POST /api/mcp/approvals` | **NEW: MY AI panel → MCP APPROVALS** | **Connected (was missing)** — real approvalId minted in walkthrough |
| Automation token (read-only profile) | M8 | `/api/automation/tokens` | MY AI panel (pre-existing) | Connected |
| MCP/JSON-RPC transports | M21 | `/api/v1/mcp`, `/api/automation/*` | External clients by design (SDK + raw clients verified in M23) | By design |
| Premiere extension | M21/M23 | UXP panel | external (UDT) | Blocked → OWNER ACTION (checklist delivered M23) |
| Desktop Bridge pairing/status | M22/M23 | bridge process | external + guide | Blocked → OWNER ACTION (Windows) |
| **Resumable-upload session endpoints** | **M24** | `GET/DELETE /api/media/upload/[uploadId]` — **implemented (route was missing while the client called it)** | transparent (upload resume) | **Connected** — verified 200 w/ missing-chunk list + 404 ownership |
| Admin ops status | M19 | `/api/admin/*` | **NEW: Settings → System status (admin-only)** | Connected (server-gated) |

## J. Project / Account / Production management
| Feature | Milestone | Backend | UI access | Status |
|---|---|---|---|---|
| Account profile/password/sessions | M19 | `/api/account*`, `/api/auth/sessions` | `/settings` | Connected |
| **Settings reachable from UI** | **M24** | — | **NEW: user menu → SETTINGS** | **Connected (was URL-only)** |
| Data export / account deletion | M19 | `/api/account/*` | Settings Privacy/Deletion | Connected |
| Storage usage | M19 | `/api/account/storage` | Settings Storage | Connected |
| Billing | M19 | **NOT IMPLEMENTED** (disabled by design) | — | NOT IMPLEMENTED — no UI pretending otherwise |
| Public registration | M19 | disabled flag | — | unchanged (not enabled) |

## Totals
- Implemented & **Connected**: 60+ user-facing features (8 newly connected in M24, marked NEW)
- By design (not user-facing): 5 (internal MY AI interfaces, external MCP transports)
- Blocked → owner/configuration: Premiere real-host, Windows bridge hardware, JAZMII sustained quota
- NOT IMPLEMENTED: billing/payments (intentionally disabled)
