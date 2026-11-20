# M30 UI REGRESSION REPORT — real browser walkthrough

**Method:** agent-browser, real sessions, isolated env (:3118). All screenshots live captures in `m30-evidence/screenshots/`.

## Multi-user walkthrough (independent identities)
| Step | Actor | Evidence | Result |
|---|---|---|---|
| Login via UI | Alicia (owner) | 01 | Editor loads with existing project |
| COLLAB drawer (new, existing design) | Alicia | 02 | Workspace/Invite/Reviews sections |
| Create workspace via UI | Alicia | 03 | "Alicia Productions" created |
| Invite editor via UI (copyable one-time URL + honest delivery status) | Alicia | 04 | "Email not configured … share the link below" |
| Invite acceptance page (email binding shown) | Ben (editor, 2nd browser identity) | 05 | Bound email + role displayed |
| Accept → membership | Ben | 06 | "You are now a member of 'Alicia Productions' as EDITOR" |
| Shared project visible in Ben's selector | Ben | — | "M30 Walkthrough Film" listed |
| Create review session via UI (locks immutable revision) | Ben (EDITOR) | 07 | "Review session 1 submitted — the preview renders now" → PROCESSING → READY_FOR_REVIEW |
| Create APPROVE review link via UI (one-time URL) | Ben | 08 | URL captured |
| Guest identity gate (name before any content) | Carmen (3rd identity) | 09 | "CLIENT REVIEW … Open review" |
| Real preview playback + frame comments | Carmen | 10, 11 | Comment at playhead frame, OPEN state |
| go-to-frame navigation + reply | Carmen | 12 | Player seeked; reply visible |
| APPROVE link decision buttons | Carmen | 13 | Approve / Request changes / Reject |
| Guest approval → revision APPROVED | Carmen | 14 | "Decision recorded: APPROVED"; DB: status APPROVED + approvedAt; audit `review.approved reviewer=guest:Carmen Client` |
| Owner notifications | Alicia | — | invitation.accepted + member_joined persisted |

## Defects found by the walkthrough (all fixed, verified)
1. **Shared-project renders failed inside the render job** ("Project not found for this user") — the job-level ownership check did not know about collaborators. Fixed with the same server-side matrix; re-queued render completed and the revision flipped to READY_FOR_REVIEW.
2. **Guest sessions never resolved** — the cookie's guest token was compared against the LINK's hash instead of the GuestAccess hash. Fixed (comment 404 → 201).
3. **Guest page skipped the identity gate** — video/comment UI rendered before the session was established. Fixed: join-first render.
4. **One-time URL display buried** in a members-conditional block. Fixed: promoted to an always-visible section.

## Responsive (375×812)
- Review page, editor, and COLLAB drawer: `scrollWidth === clientWidth === 375` — no horizontal overflow (screenshots 15, 16).
- No clipped dialogs; drawer stacks sections; identity gate fields usable; existing navigation unaffected.

## Regression
- M1–M29 batch: 34 suites PASS + the two carried-forward M13 OpenCV-CSRT environmental failures (INFRASTRUCTURE REQUIRED).
- M29 integrity 8/8 and portability 4/4 re-run AFTER the collaboration changes — PASS.
