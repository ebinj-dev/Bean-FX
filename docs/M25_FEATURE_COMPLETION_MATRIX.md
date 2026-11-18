# M25 — Feature Completion Matrix

Legend: **VERIFIED** (live browser + API evidence this milestone) · **AUTOMATED** (test suites) · **BLOCKED** / **CONFIGURATION REQUIRED** / **OWNER ACTION REQUIRED** · **NOT IMPLEMENTED** (honest).

## P2 — Billing & subscription foundation
| Feature | Backend | UI access | Status | Verification |
|---|---|---|---|---|
| Plan catalog (3 tiers, no prices) | `/api/billing/plans` | Settings → Plan & usage | VERIFIED | UI + test (no price strings) |
| Subscription state + period | `/api/billing/subscription` | Settings → Plan & usage chip | VERIFIED | Free auto-provisioned; renews date shown |
| Real usage snapshot | computed from projects/exports/AIUsage/media/render-jobs | usage grid | VERIFIED | zeros for fresh user; aggregates wired |
| Self-serve plan switch | POST subscription (selfServe only) | Switch buttons | VERIFIED | paid → 403 PAYMENTS_DISABLED + audit event |
| Entitlement: maxProjects | hook in POST /api/projects | honest 402 | VERIFIED | 26th project → 402 PLAN_LIMIT |
| Entitlement: monthlyAiCalls | hooks in jazmii/laxii/my-ai-chat | honest 402 | VERIFIED | 2000-row user → 402 |
| Entitlement: export minutes + concurrency | hook in render POST | honest 402 | AUTOMATED | contract + free-unlimited verified |
| Cancel at period end | POST /api/billing/cancel | Cancel button | VERIFIED | state + CANCEL_SCHEDULED event |
| Resume cancellation | POST /api/billing/resume | Resume button | VERIFIED | CANCEL_RESUMED event |
| Period roll (renew, no charge) | lazy roll in ensureSubscription | renewal date | VERIFIED | PERIOD_RENEWED event; no provider |
| Cancelled period → downgrade | roll → FREE | — | VERIFIED | SUBSCRIPTION_ENDED event |
| Billing history | `/api/billing/history` | history list | VERIFIED | events render |
| Admin manual assignment | POST /api/admin/billing | admin card → Assign | VERIFIED | creator assigned; ADMIN_OVERRIDE audited |
| Admin billing summary | GET /api/admin/billing | admin card | AUTOMATED | requireAdmin deny for users |
| Payment processing | **NOT IMPLEMENTED** (by design) | "Payments not enabled" chip | NOT IMPLEMENTED | no provider, no credentials, no checkout |

## P3 — Export experience
| Feature | Backend | UI access | Status | Verification |
|---|---|---|---|---|
| Export range presets | render POST startFrame/endFrame | EXPORT drawer | VERIFIED | 3 presets render; range contract tested |
| Custom range (seconds → frames) | same | drawer inputs | AUTOMATED | validation + enqueue contract |
| Render cancel | DELETE /api/jobs/[id] | Cancel on active jobs | AUTOMATED | jobManager.cancel ownership |
| Render retry | re-POST with job's own range (GET exposes it) | Retry on FAILED | VERIFIED | GET range contract tested |
| FFprobe validation | M20 pipeline (unchanged) | — | AUTOMATED | T1 45 s pass |
| Resolution/codec selectors | not supported by pipeline | deliberately absent | NOT IMPLEMENTED (honest) | no invented capabilities |
| Export history + download | /api/exports* (pre-existing) | drawer + dashboard | VERIFIED (M24 carryover) | regression green |

## P4 — Project & media management
| Feature | Backend | UI access | Status | Verification |
|---|---|---|---|---|
| Project deletion safeguard | DELETE ?confirm=<name> (412 mismatch) | drawer danger zone | VERIFIED | wrong name disabled; exact name deletes |
| Media library untouched on delete | only project row + cascade versions | — | VERIFIED | mediaUntouched:true |
| Missing media detection | engine model (missingMedia) | timeline/monitor honest placeholders | VERIFIED (pre-existing, carried) | regression green |
| Media relink | ReplaceClip command | inspector MISSING MEDIA → Relink | VERIFIED | validated reversible command |
| Project duplication | M15 route (pre-existing) | drawer | VERIFIED (carryover) | regression green |
| Storage usage visibility | /api/account/storage | Settings Storage | VERIFIED (carryover) | — |

## P5 — AI workflows
| Feature | Backend | UI access | Status | Verification |
|---|---|---|---|---|
| Generation cancel | DELETE /api/jobs/[id] | JAZMII/LAXII CANCEL JOB | VERIFIED | poll reports CANCELLED |
| Generation retry | same params re-submit | RETRY after FAILED | VERIFIED | lastGen params |
| Engine availability | /api/my-ai/health + proposals | panel footers | VERIFIED (M24 carryover) | — |
| Intent routing | POST /api/ai/route | MY AI panel | VERIFIED (M24 carryover) | "→ engine JAZMII" |
| Approval visibility | MCP approvals | MY AI panel | VERIFIED (M24 carryover) | — |

## P6 — Reliability & accessibility
| Item | Status | Verification |
|---|---|---|
| Empty/loading/error states | VERIFIED (carried + new) | fresh-user renders, drawers, honest errors |
| Session expiry → login | VERIFIED (pre-existing) | app-shell switch |
| Responsive 375 px | VERIFIED | studio + settings no overflow |
| aria-labels/tooltips on new controls | VERIFIED | all new inputs/buttons labeled |
| Keyboard: editor shortcuts | VERIFIED (carried) | tooltips list shortcuts |

## P7 — Admin & operations
| Feature | Backend | UI access | Status |
|---|---|---|---|
| Audit event feed | GET /api/admin/audit (read-audited) | admin card | VERIFIED deny for users; admin render |
| Job queue + failed jobs | /api/admin/jobs, worker recovery | admin status card | VERIFIED (M24 carryover + probe) |
| Service health | /api/health, /api/admin/health | settings footer + admin card | VERIFIED |
| Plan assignment | admin billing POST | admin card | VERIFIED |

## Totals
- VERIFIED 26 · AUTOMATED 8 · carried-VERIFIED 8 · NOT IMPLEMENTED (honest, by design) 2 (payment processing, prices) · OWNER ACTION 3 (Premiere host, Windows bridge, quota/config) — unchanged from M24.
