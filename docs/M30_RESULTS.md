# M30 RESULTS — Collaborative Workspaces, Client Review & Approval

**Date:** 2026-11-19 · **Branch:** feature/ai-creative-studio · **Baseline:** M29-C tip `63b6e91f`
**Scope:** secure collaboration + review foundations. NO multiplayer editing, NO CRDT/OT, no redesign.

## 1. Initial audit (Phase 0)
- Remote feature tip `63b6e91f` verified with the full ancestry (M29-C `85c3bfdf`, M29 `21aa65e4`, M28 `1058dd7`).
- **No workspace/organization/invitation/review models existed** — M30 introduces them additively.
- Reused existing infrastructure deliberately (no duplication):
  - `TimelineVersion`/`TimelineEdit` — the immutable version history (revisions pin it; **no second version system**).
  - `AuditEvent` — audit trail for every collaboration action.
  - `hashToken` / SHA-256-at-rest token hygiene (EmailVerificationToken pattern) — invitations, review links, guest sessions.
  - M19 mailer — honest `{ delivered: false }` contract; email is optional, never a dependency.
  - The existing `RENDER_TIMELINE` job pipeline produces review previews (real FFmpeg, validated — never mock media).
  - The timeline route's existing optimistic concurrency (409 + authoritative head) — extended to project metadata (§8).

## 2. Architecture (Phase 1)
Additive Prisma models (10): `Workspace`, `WorkspaceMember`, `Invitation`, `ProjectShare`, `ReviewRevision`, `ReviewAssignment`, `ReviewComment`, `ReviewLink`, `GuestAccess`, `Notification`. `Project.workspaceId` is optional — **null = personal project, exactly today's behavior**.

### Permission matrix (server-enforced in `src/lib/collab.ts`)
| Action | OWNER | ADMIN | EDITOR | REVIEWER | VIEWER |
|---|---|---|---|---|---|
| View authorized projects | yes | yes | yes | shared | shared |
| Invite collaborators | any role | ≤ADMIN | REVIEWER/VIEWER only | no | no |
| Edit project | yes | yes | yes | no | no |
| Create review request | yes | yes | yes | no | no |
| Comment on review | yes | yes | yes | yes | no |
| Resolve/reopen comments | yes | yes | yes | no | no |
| Submit approval | yes | yes | yes | yes | no |
| Manage workspace (rename) | yes | no | no | no | no |
| Change member roles | any except own/OWNER | ≤EDITOR roles | no | no | no |
| Remove workspace owner | **no** | no | no | no | no |

Documented adaptations: workspace OWNER/ADMIN act as project ADMINs on workspace projects (the workspace is the tenant); per-project `ProjectShare` grants EDITOR/REVIEWER/VIEWER only (ownership stays with the creator, inalienable); approval eligibility = explicit assignment OR any authenticated collaborator (Owner/Admin/Editor/REVIEWER share) — matching the matrix rows above.

## 3. Invitations (Phase 2)
Lifecycle PENDING → ACCEPTED | REJECTED | EXPIRED | REVOKED (all terminal, no token reuse). 256-bit tokens, SHA-256 stored, raw token shown once as a copyable `#/invite/<token>` URL. Bound to the invited EMAIL (a different account gets 403; anonymous gets 401). Duplicate active invitations → 409. Stale sweeps mark EXPIRED. Every transition audited. Delivery: honest — the mailer reports `delivered: false` when SMTP is unconfigured (verified in UI + suite); **external email delivery = CONFIGURATION REQUIRED**.

## 4. Sharing & review links (Phase 3)
Personal projects stay private; access = workspace membership OR explicit named `ProjectShare` (revocable, next-request effect). External review links: per-revision, permission tiers VIEW/COMMENT/APPROVE, 14-day default TTL (configurable ≤30d), optional password (SHA-256 at rest), revocation kills guest sessions immediately, `accessCount`/`lastAccessAt` tracked, token hashes only in listings. Guest sessions: cookie-bound to one link, self-reported display name, no workspace membership, no project role, no original media, no downloads; comment rate capped (20 sessions/10min/link).

## 5. Immutable review revisions (Phase 4)
`ReviewRevision` pins the head `TimelineVersion` (versionNumber + sequence) + a **SHA-256 fingerprint** over canonical inputs. Creating session N supersedes open sessions (server-enforced transitions) and notifies participants. Preview = the REAL render pipeline (`RENDER_TIMELINE` with `reviewRevisionId`) → validated export attached, status flips PROCESSING → READY_FOR_REVIEW automatically. Verified: post-submission edits leave the pinned revision untouched (test C2); superseded revisions close decisions (test E2).

## 6. Frame-accurate comments (Phase 5)
Integer `frame` + canonical `fpsNum/fpsDen` persisted (seconds derived for display only — never the identity). Threading (one-level replies), author-only edit (editCount history), resolve/reopen (editors+ only; guests never), same-frame multiplicity allowed, malformed fps/negative frames rejected 400, comments stay attached to their revision.

## 7. Approval workflow (Phase 6)
Decisions APPROVE | REQUEST_CHANGES | REJECT with note + timestamp + audit. Approval binds to the EXACT revision fingerprint; superseded/cancelled revisions refuse decisions (409). Multi-reviewer: per-(revision,reviewer) dedup, ALL/ANY policy, deterministic final status, duplicate votes 409, unauthorized voters 403/404. CHANGES_REQUESTED → resubmit new revision → APPROVED verified end-to-end.

## 8. Concurrency guard (Phase 8)
Timeline writes already 409 on stale baseVersion with the authoritative head (verified two-editor). Project PATCH gains optional `expectedUpdatedAt` — stale writes 409 with `conflict: true` + `updatedAt` (verified). Attempted conflicting writes are audited via the existing audit trail patterns.

## 9. Notifications (Phase 7)
Single durable `Notification` store (no second system). Retry-safe via `dedupKey` unique. Unread count, mark-read (ids/all), dismissal, bounded retrieval + cursor paging. Events: invitation accepted/rejected, member joined, project shared, review requested, revision ready/superseded/cancelled, comment created/replied/resolved, review approved/changes-requested. Payloads carry ids/titles only.

## 10. UI integration (Phase 9) — no redesign
COLLAB drawer (Users icon beside Portability): WORKSPACE (create/members/invite with copyable URL + delivery status), REVIEW SESSIONS (create/list/status badges), COMMENTS (threads, frame badge, resolve/reopen, frame input), APPROVE/REQUEST CHANGES, REVIEW LINKS (create/permission/revoke + one-time URL). Notifications bell in the editor toolbar (unread badge, dropdown, mark-read, dismiss). `#/invite/<token>` acceptance page (email binding enforced, honest errors). `#/review/<token>` guest page (identity gate FIRST, real preview player, frame comments, go-to-frame, decisions). Existing black/yellow design, glass styling, layout conventions preserved.

## 11. Testing (Phase 12) — all executed
| Suite | Result |
|---|---|
| `test-m30-collab.test.ts` (roles, invitations, shares, enforcement, concurrency) | **13/13 PASS** |
| `test-m30-reviews.test.ts` (revisions, comments, approvals, links, guests) | **15/15 PASS** |
| M1–M29 regression `run-all-tests.sh` | **34 suites PASS; 2 FAIL = the carried-forward M13 OpenCV-CSRT environmental exceptions (INFRASTRUCTURE REQUIRED — not relabeled, not counted as passes)** |
| M29 integrity + portability re-run after M30 changes | **8/8 and 4/4 PASS** |
| TypeScript / ESLint / Prisma / Production build | **0 / clean / valid / SUCCESS** |
| Browser walkthrough (independent sessions, real screenshots) | **PASS** — see M30_UI_REGRESSION_REPORT.md |
| 375px responsive | **PASS** — scrollWidth=clientWidth=375 on editor, COLLAB drawer, review page |

## 12. Security validation (Phase 10) — executed, not assumed
Email-bound acceptance (wrong account 403, anonymous 401) · expired → 410 · revoked → 410 immediately · escalation caps (editor→ADMIN 403, viewer invite 403) · self-role-change 403 · owner-removal 403 · reviewer/viewer timeline writes 404 (no existence leak) · stranger comment 404 · stranger vote 403 · cross-user archive/download 404/401 · VIEW-link guest comment 403 · guest resolve 403 · password-gated link (wrong password 401) · revocation kills live guest sessions · duplicate decisions 409 · superseded decisions 409 · token hashes only (listings expose no raw tokens) · storage paths never in API responses.

## 13. AI engine compatibility (Phase 11)
All existing engines untouched (no provider changes, no Ollama). No AI-assist features were added in M30 — the design leaves room (summarize feedback, group comments) as FUTURE work, explicitly advisory: AI cannot approve, resolve comments, change permissions, publish revisions, or bypass the revision guard. Core collaboration works with NO AI provider configured (all walkthrough/tests ran without any live provider). **Nothing to classify as CONFIGURATION REQUIRED because no AI feature ships in M30.**

## 14. Known limitations (honest)
1. Project-share management is API-only (no dedicated UI panel); workspace invitations + reviews have full UI.
2. `#/review` link URLs are built as `origin#/review/...` (missing `/` before the hash — cosmetic; the route still works).
3. Guest identity is self-reported (by design; no guest accounts exist).
4. In-process rate limits reset on server restart (documented; sufficient for review flows).
5. The carried-forward M13 OpenCV-CSRT exceptions remain INFRASTRUCTURE REQUIRED (opencv-contrib-python not present in the sandbox).

## 15. GitHub update (Phase 14)
**Implementation commit:** `f8c0290` — https://github.com/ebinj-dev/Bean-FX/commit/f8c029010e4e9f56ded13a592a3289f5499ac7e2
Independently clone-verified: M29-C tip `63b6e91f` + implementation `85c3bfdf` ancestors present; 21 evidence files + 3 M30 docs in the remote tree; diff vs M29-C tip: 64 files, +4,446/-22. `main` advanced only by its owner (`5db3140`->`60eaae4`) — untouched by this work.
