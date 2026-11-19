# M30 FEATURE MATRIX (honest classification)

| # | Feature | Status | Evidence |
|---|---|---|---|
| 1 | Workspace create/list/members/roles (server matrix) | **VERIFIED** — independent sessions | collab-tests 1–8; screenshots 03/06 |
| 2 | Invitation lifecycle (accept/reject/expire/revoke, email binding) | **VERIFIED** | collab-tests 1–6; screenshots 04–06 |
| 3 | Role-escalation & self-role-change prevention | **VERIFIED** | collab-tests 6–8 |
| 4 | Per-project named shares (grant/revoke, next-request effect) | **VERIFIED** (API) | collab-tests B; review-tests beforeAll |
| 5 | Shared-project listing + editor write access | **VERIFIED** | collab-tests B2–B3; screenshot 07 |
| 6 | Reviewer/Viewer read-only enforcement (no-leak 404) | **VERIFIED** | collab-tests B2 |
| 7 | Immutable review revisions (pin + fingerprint) | **VERIFIED** | review-tests C2 |
| 8 | Real-pipeline review previews (PROCESSING→READY_FOR_REVIEW) | **VERIFIED** | review-tests C1; screenshot 07/10 |
| 9 | Supersession (open sessions close; decisions locked) | **VERIFIED** | review-tests C3, E2 |
| 10 | Frame-accurate comments (integer frames + timebase) | **VERIFIED** | review-tests D1–D4 |
| 11 | Comment threads/replies/resolve/reopen + author-only edit | **VERIFIED** | review-tests D1, D3 |
| 12 | Approval workflow (ALL/ANY, dedup, revision-bound) | **VERIFIED** | review-tests E1–E3 |
| 13 | Guest review links (VIEW/COMMENT/APPROVE tiers, password) | **VERIFIED** | review-tests F1–F4 |
| 14 | Guest session identity gate (no impersonation) | **VERIFIED** | review-tests F2; screenshots 09–14 |
| 15 | Revocation kills guest sessions immediately | **VERIFIED** | review-tests F4 |
| 16 | Preview streaming only (no originals/downloads) | **VERIFIED** | review-tests C1, F3 |
| 17 | Durable notifications (dedup, read state, paging) | **VERIFIED** | review-tests F5; bell UI |
| 18 | Concurrency guard (timeline 409 + PATCH expectedUpdatedAt 409) | **VERIFIED** | collab-tests B4–B5 |
| 19 | Audit trail for collaboration actions | **VERIFIED** (DB) | audit rows `review.approved`, `invitation.*` |
| 20 | UI: COLLAB drawer + invite + review pages (existing design) | **VERIFIED** | screenshots 02–16 |
| 21 | 375px responsive (no overflow) | **VERIFIED** | scrollWidth probes; screenshot 15/16 |
| 22 | External email delivery for invitations | **CONFIGURATION REQUIRED** (SMTP absent; honest status shown) | mailer contract; screenshot 04 |
| 23 | AI-assisted review summarization | **NOT IMPLEMENTED** (future, advisory-only by design) | M30_RESULTS §13 |
| 24 | Multiplayer/CRDT editing | **NOT IMPLEMENTED** (out of scope by mandate) | — |
| 25 | M13 temporal (OpenCV CSRT) suites | **INFRASTRUCTURE REQUIRED** (carried forward from M29-C) | regression log |

Every role/permission listed was validated with INDEPENDENT user sessions (6 separate cookie jars per suite; 3 separate browser identities in the walkthrough).
