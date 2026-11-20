#!/usr/bin/env python3
"""M30 Phase 1 — additive collaboration models appended to prisma/schema.prisma.

Additive only: no existing column changes. Project gains an optional
workspaceId (null = personal project, exactly today's behavior).
"""
import re, sys

p = "prisma/schema.prisma"
s = open(p).read()

# --- 1. Project: optional workspace link + new relations -------------------
old = """  /// Project settings for the editor (fps, resolution, sample rate …) —
  /// additive JSON blob; absent = sensible defaults (30fps 1080p 48kHz).
  settingsJson String?"""
new = """  /// Project settings for the editor (fps, resolution, sample rate …) —
  /// additive JSON blob; absent = sensible defaults (30fps 1080p 48kHz).
  settingsJson String?
  /// M30: null = personal project owned solely by `userId` (today's model).
  /// Set = the project is shared into a team workspace; access then follows
  /// the workspace membership role plus explicit per-user project shares.
  workspaceId String?
  workspace    Workspace? @relation(fields: [workspaceId], references: [id], onDelete: SetNull)"""
assert old in s; s = s.replace(old, new, 1)

old = """  transcriptVersions TranscriptVersion[] @relation("TranscriptVersions")
}"""
new = """  transcriptVersions TranscriptVersion[] @relation("TranscriptVersions")
  /// M30 collaboration.
  projectShares      ProjectShare[]
  reviewRevisions    ReviewRevision[]
}"""
assert old in s; s = s.replace(old, new, 1)

# --- 2. User: M30 relations ------------------------------------------------
old = """  sessions     Session[]
  emailVerificationTokens EmailVerificationToken[]
  passwordResetTokens     PasswordResetToken[]
  projects     Project[]"""
new = """  sessions     Session[]
  emailVerificationTokens EmailVerificationToken[]
  passwordResetTokens     PasswordResetToken[]
  projects     Project[]
  /// M30 collaboration relations.
  workspacesOwned       Workspace[]         @relation("WorkspaceOwner")
  workspaceMemberships  WorkspaceMember[]
  invitationsSent       Invitation[]        @relation("InvitationInviter")
  notifications         Notification[]
  reviewAssignments     ReviewAssignment[]
  reviewComments        ReviewComment[]
  reviewRevisionsCreated ReviewRevision[]   @relation("ReviewRevisionCreator")
  reviewLinksCreated    ReviewLink[]        @relation("ReviewLinkCreator")
  projectSharesGranted  ProjectShare[]      @relation("ProjectShareGranter")
  projectSharesReceived ProjectShare[]      @relation("ProjectShareGrantee")"""
assert old in s; s = s.replace(old, new, 1)

# --- 3. New models ----------------------------------------------------------
M30 = """
/// ─────────────────────────────────────────────────────────────────────────
/// M30 — COLLABORATIVE WORKSPACES, CLIENT REVIEW & APPROVAL
/// Additive models. Server-side permission matrix lives in src/lib/collab.ts.
/// ─────────────────────────────────────────────────────────────────────────

/// M30: a team workspace. Personal usage (no workspace) is unchanged.
model Workspace {
  id          String   @id @default(cuid())
  name        String
  ownerUserId String
  owner       User     @relation("WorkspaceOwner", fields: [ownerUserId], references: [id], onDelete: Cascade)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  members     WorkspaceMember[]
  invitations Invitation[]
  projects    Project[]
  @@index([ownerUserId])
}

/// M30: workspace membership with the server-enforced role.
/// OWNER cannot be removed or demoted (guard rails in collab.ts).
model WorkspaceMember {
  id          String      @id @default(cuid())
  workspaceId String
  workspace   Workspace   @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  userId      String
  user        User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  /// "OWNER" | "ADMIN" | "EDITOR" | "REVIEWER" | "VIEWER"
  role        String
  createdById String
  createdAt   DateTime    @default(now())
  @@unique([workspaceId, userId])
  @@index([userId])
}

/// M30: workspace invitation. Raw token is NEVER stored — SHA-256 hash only
/// (same hygiene as EmailVerificationToken). The raw token is shown once and
/// embedded in a copyable invite URL; email delivery is best-effort via the
/// M19 mailer and honestly reported as not-configured when SMTP is absent.
model Invitation {
  id          String    @id @default(cuid())
  workspaceId String
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  /// Lower-cased email of the intended recipient — the invitation is BOUND to
  /// this identity; another account cannot accept it.
  email       String
  /// Invited role: never above the inviter's own capability.
  role        String
  tokenHash   String    @unique
  /// PENDING → ACCEPTED | REJECTED | EXPIRED | REVOKED (terminal; no reuse).
  state       String    @default("PENDING")
  expiresAt   DateTime
  invitedById String
  inviter     User      @relation("InvitationInviter", fields: [invitedById], references: [id], onDelete: Cascade)
  acceptedById String?
  decidedAt   DateTime?
  createdAt   DateTime  @default(now())
  @@index([workspaceId, state])
  @@index([email])
}

/// M30: explicit named-collaborator grant on ONE project (independent of any
/// workspace). Revocable; grants never widen the granter's own rights.
model ProjectShare {
  id          String    @id @default(cuid())
  projectId   String
  project     Project   @relation(fields: [projectId], references: [id], onDelete: Cascade)
  userId      String
  user        User      @relation("ProjectShareGrantee", fields: [userId], references: [id], onDelete: Cascade)
  /// "EDITOR" | "REVIEWER" | "VIEWER" (never OWNER — ownership is inalienable)
  role        String
  grantedById String
  granter     User      @relation("ProjectShareGranter", fields: [grantedById], references: [id], onDelete: Cascade)
  revokedAt   DateTime?
  createdAt   DateTime  @default(now())
  @@unique([projectId, userId])
  @@index([userId])
}

/// M30: an immutable review revision — client approval binds to THIS, never
/// to the live project. Built on the existing TimelineVersion snapshot (no
/// second version system): the revision pins versionNumber + a fingerprint of
/// the canonical sequence JSON, so later project edits cannot alter it.
model ReviewRevision {
  id                String       @id @default(cuid())
  projectId         String
  project           Project      @relation(fields: [projectId], references: [id], onDelete: Cascade)
  /// Monotonic per project (1,2,3…).
  sessionNo         Int
  /// The pinned, immutable timeline snapshot.
  timelineVersionId String
  timelineVersion   TimelineVersion @relation(fields: [timelineVersionId], references: [id], onDelete: Cascade)
  versionNumber     Int
  /// SHA-256 over canonical revision inputs — detects any drift.
  fingerprint       String
  /// DRAFT | PROCESSING | READY_FOR_REVIEW | IN_REVIEW | CHANGES_REQUESTED
  /// | APPROVED | SUPERSEDED | CANCELLED | FAILED
  status            String       @default("PROCESSING")
  title             String
  instruction       String?
  dueAt             DateTime?
  /// "ALL" (every assigned reviewer must approve) | "ANY" (one approval wins)
  approvalPolicy    String       @default("ALL")
  createdById       String
  creator           User         @relation("ReviewRevisionCreator", fields: [createdById], references: [id], onDelete: Cascade)
  /// The reviewable preview produced by the REAL render pipeline.
  previewExportId   String?
  previewExport     ExportFile?  @relation(fields: [previewExportId], references: [id], onDelete: SetNull)
  previewDurationSec Float?
  /// When a newer revision supersedes this one.
  supersededById    String?
  approvedAt        DateTime?
  createdAt         DateTime     @default(now())
  updatedAt         DateTime     @updatedAt
  assignments       ReviewAssignment[]
  comments          ReviewComment[]
  links             ReviewLink[]
  @@unique([projectId, sessionNo])
  @@index([projectId, createdAt])
  @@index([status])
}

/// M30: one reviewer's decision on ONE revision. Decisions are unique per
/// (revision, reviewer) — resubmission of a changed mind is a new revision.
model ReviewAssignment {
  id             String         @id @default(cuid())
  revisionId     String
  revision       ReviewRevision @relation(fields: [revisionId], references: [id], onDelete: Cascade)
  reviewerUserId String
  reviewer       User           @relation(fields: [reviewerUserId], references: [id], onDelete: Cascade)
  /// PENDING | APPROVED | CHANGES_REQUESTED | REJECTED | DECLINED
  state          String         @default("PENDING")
  note           String?
  decidedAt      DateTime?
  createdAt      DateTime       @default(now())
  @@unique([revisionId, reviewerUserId])
  @@index([reviewerUserId])
}

/// M30: frame-accurate review comment on ONE revision. Frame identity uses
/// INTEGER frames in the sequence timebase (fps num/den persisted alongside);
/// seconds are derived for display only. Replies form one-level threads.
model ReviewComment {
  id            String         @id @default(cuid())
  revisionId    String
  revision      ReviewRevision @relation(fields: [revisionId], references: [id], onDelete: Cascade)
  /// Null for top-level comments.
  parentId      String?
  parent        ReviewComment? @relation("CommentThread", fields: [parentId], references: [id], onDelete: Cascade)
  replies       ReviewComment[] @relation("CommentThread")
  /// Authenticated author OR a guest identified by the review link.
  authorUserId  String?
  author        User?          @relation(fields: [authorUserId], references: [id], onDelete: Cascade)
  guestName     String?
  /// Integer frame number in the sequence timebase (null = general comment).
  frame         Int?
  /// Canonical fps the frame was addressed in: num/den.
  fpsNum        Int?
  fpsDen        Int?
  /// Derived display timestamp (frame / fps) — NOT the frame identity.
  timeSeconds   Float?
  clipId        String?
  body          String
  /// OPEN | RESOLVED
  status        String         @default("OPEN")
  editCount     Int            @default(0)
  editedAt      DateTime?
  createdAt     DateTime       @default(now())
  @@index([revisionId, status])
  @@index([parentId])
  @@index([authorUserId])
}

/// M30: revocable external review link for ONE revision. High-entropy token;
/// only the SHA-256 hash is stored. Guests get a scoped session (no
/// workspace membership, no edit rights, no original-media access).
model ReviewLink {
  id            String         @id @default(cuid())
  revisionId    String
  revision      ReviewRevision @relation(fields: [revisionId], references: [id], onDelete: Cascade)
  tokenHash     String         @unique
  /// ACTIVE | REVOKED | EXPIRED
  state         String         @default("ACTIVE")
  /// "VIEW" | "COMMENT" | "APPROVE" — comments/approval must be granted.
  permission    String         @default("COMMENT")
  expiresAt     DateTime
  /// Optional password (SHA-256 at rest, same hashToken).
  passwordHash  String?
  createdById   String
  creator       User           @relation("ReviewLinkCreator", fields: [createdById], references: [id], onDelete: Cascade)
  accessCount   Int            @default(0)
  lastAccessAt  DateTime?
  createdAt     DateTime       @default(now())
  guestAccesses GuestAccess[]
  @@index([revisionId, state])
}

/// M30: one guest identity bound to one link. The guest session cookie holds
/// linkId + guest token; the guest can only act within the shared revision.
model GuestAccess {
  id         String     @id @default(cuid())
  linkId     String
  link       ReviewLink @relation(fields: [linkId], references: [id], onDelete: Cascade)
  /// Self-reported display name (never treated as an authenticated identity).
  displayName String
  tokenHash  String     @unique
  lastSeenAt DateTime   @default(now())
  createdAt  DateTime   @default(now())
  @@index([linkId])
}

/// M30: durable in-app notification. dedupKey makes retries idempotent.
model Notification {
  id          String    @id @default(cuid())
  userId      String
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  /// e.g. "invitation.received", "review.requested", "comment.created",
  /// "review.approved", "review.changes_requested", "revision.superseded".
  type        String
  projectId   String?
  payloadJson String?
  /// Stable key for retry-safe creation; unique where present.
  dedupKey    String?   @unique
  readAt      DateTime?
  createdAt   DateTime  @default(now())
  @@index([userId, readAt])
  @@index([userId, createdAt])
}

/// M30: render job for the review preview (ExportFile kind REVIEW_PREVIEW).
/// Completed by the existing RENDER_TIMELINE pipeline via a hook that flips
/// the revision to READY_FOR_REVIEW.
"""
s = s.rstrip() + "\n" + M30
open(p, "w").write(s)
print("schema models appended")

# --- 4. TimelineVersion + ExportFile back-relations -------------------------
old = """  edits         TimelineEdit[]

  @@unique([projectId, versionNumber])"""
new = """  edits         TimelineEdit[]
  reviewRevisions ReviewRevision[]

  @@unique([projectId, versionNumber])"""
assert old in s; s = s.replace(old, new, 1)
open(p, "w").write(s)

s = open(p).read()
old = """model ExportFile {"""
idx = s.index(old)
end = s.index("}", s.index("storagePath", idx))
seg = s[idx:end]
assert "reviewRevisions" not in seg
s = s[:end] + "  /// M30: review revisions whose preview was produced by this export.\n  reviewRevisions ReviewRevision[] @relation(\"ReviewRevisionPreview\")\n" + s[end:]
open(p, "w").write(s)
print("back-relations added")
PYEOF_MARKER = True
