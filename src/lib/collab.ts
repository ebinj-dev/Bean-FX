/**
 * M30 — server-side collaboration permissions (the single authority).
 *
 * NOTHING in the UI is trusted for authorization. Every protected operation
 * re-resolves access here. Inaccessible projects answer 404 with the SAME
 * generic message used for missing projects (no existence leak).
 *
 * Role capability matrix (M30 baseline, adapted to the existing codebase):
 *
 *   Action                    OWNER  ADMIN  EDITOR  REVIEWER  VIEWER
 *   View authorized projects   yes    yes    yes     shared    shared
 *   Invite collaborators       yes    yes    limited  no        no
 *   Edit project               yes    yes    yes      no        no
 *   Create review request      yes    yes    yes      no        no
 *   Comment on review          yes    yes    yes      yes       no
 *   Resolve/reopen comments    yes    yes    own+     no        no
 *   Submit approval            via    via    via      yes       no
 *                             assigned reviewer assignment only
 *   Manage workspace           yes    limited no       no        no
 *   Remove workspace owner     no     no     no       no        no
 *
 * Workspace OWNER/ADMIN act as project ADMINs on shared projects (the
 * workspace is the tenant). Explicit per-project shares (ProjectShare) grant
 * EDITOR/REVIEWER/VIEWER only — ownership stays with the project creator and
 * can never be widened, changed or claimed through any request payload.
 */
import { createHash } from "crypto";
import { db } from "@/lib/db";

export type CollabRole = "OWNER" | "ADMIN" | "EDITOR" | "REVIEWER" | "VIEWER";
export const COLLAB_ROLES: CollabRole[] = ["OWNER", "ADMIN", "EDITOR", "REVIEWER", "VIEWER"];

export const ROLE_RANK: Record<CollabRole, number> = {
  OWNER: 5,
  ADMIN: 4,
  EDITOR: 3,
  REVIEWER: 2,
  VIEWER: 1,
};

export type ProjectAccess = {
  role: CollabRole | "NONE";
  source: "OWNER" | "WORKSPACE" | "SHARE" | "NONE";
  workspaceId?: string | null;
  workspaceRole?: CollabRole | null;
  shareRole?: CollabRole | null;
};

export type ProjectLike = {
  id: string;
  userId: string;
  workspaceId: string | null;
};

/** Resolve the effective role of `userId` on a project (server-side only). */
export async function getProjectAccess(userId: string, project: ProjectLike): Promise<ProjectAccess> {
  if (project.userId === userId) {
    return { role: "OWNER", source: "OWNER", workspaceId: project.workspaceId };
  }
  if (project.workspaceId) {
    const member = await db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } },
    });
    if (member) {
      // Workspace OWNER/ADMIN govern the tenant: they act as project ADMINs.
      const role: CollabRole = member.role === "OWNER" || member.role === "ADMIN" ? "ADMIN" : (member.role as CollabRole);
      return { role, source: "WORKSPACE", workspaceId: project.workspaceId, workspaceRole: member.role as CollabRole };
    }
  }
  const share = await db.projectShare.findFirst({
    where: { projectId: project.id, userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (share) {
    return { role: share.role as CollabRole, source: "SHARE", workspaceId: project.workspaceId, shareRole: share.role as CollabRole };
  }
  return { role: "NONE", source: "NONE", workspaceId: project.workspaceId };
}

export function canEdit(access: ProjectAccess): boolean {
  return access.role === "OWNER" || access.role === "ADMIN" || access.role === "EDITOR";
}

export function canCommentOnReviews(access: ProjectAccess): boolean {
  return access.role === "OWNER" || access.role === "ADMIN" || access.role === "EDITOR" || access.role === "REVIEWER";
}

export function canCreateReview(access: ProjectAccess): boolean {
  return canEdit(access);
}

export function canView(access: ProjectAccess): boolean {
  return access.role !== "NONE";
}

/**
 * Who may invite into a workspace, and to which roles:
 * OWNER → any role except OWNER (there is exactly one owner);
 * ADMIN → ADMIN/EDITOR/REVIEWER/VIEWER (never OWNER);
 * EDITOR → REVIEWER/VIEWER only (restricted, per the matrix);
 * REVIEWER/VIEWER → nothing.
 */
export function invitablesFor(actorRole: CollabRole): CollabRole[] {
  switch (actorRole) {
    case "OWNER": return ["ADMIN", "EDITOR", "REVIEWER", "VIEWER"];
    case "ADMIN": return ["ADMIN", "EDITOR", "REVIEWER", "VIEWER"];
    case "EDITOR": return ["REVIEWER", "VIEWER"];
    default: return [];
  }
}

export function canManageWorkspace(role: CollabRole): boolean {
  return role === "OWNER";
}

/** Role changes: OWNER may set any role for anyone except themselves (the
 * workspace always keeps exactly one owner). ADMIN may manage non-admin
 * members only (cannot touch the OWNER or other ADMINs). */
export function canSetMemberRole(actorRole: CollabRole, targetRole: CollabRole, newRole: CollabRole, self: boolean): { allowed: boolean; reason?: string } {
  if (self) return { allowed: false, reason: "You cannot change your own role." };
  if (targetRole === "OWNER") return { allowed: false, reason: "The workspace owner role cannot be changed." };
  if (newRole === "OWNER") return { allowed: false, reason: "There can be only one workspace owner." };
  if (actorRole === "OWNER") return { allowed: true };
  if (actorRole === "ADMIN" && ROLE_RANK[targetRole] <= ROLE_RANK.EDITOR) return { allowed: true };
  return { allowed: false, reason: "Not permitted for your role." };
}

export function canRemoveMember(actorRole: CollabRole, targetRole: CollabRole, self: boolean): { allowed: boolean; reason?: string } {
  if (self) return { allowed: false, reason: "Use workspace leave flows instead; owners cannot be removed." };
  if (targetRole === "OWNER") return { allowed: false, reason: "The workspace owner cannot be removed." };
  if (actorRole === "OWNER") return { allowed: true };
  if (actorRole === "ADMIN" && ROLE_RANK[targetRole] <= ROLE_RANK.EDITOR) return { allowed: true };
  return { allowed: false, reason: "Not permitted for your role." };
}

/** Granting a per-project share can never widen the granter's own rights. */
export function shareablesFor(granterRole: CollabRole): CollabRole[] {
  switch (granterRole) {
    case "OWNER": return ["EDITOR", "REVIEWER", "VIEWER"];
    case "ADMIN": return ["EDITOR", "REVIEWER", "VIEWER"];
    case "EDITOR": return ["REVIEWER", "VIEWER"];
    default: return [];
  }
}

// ── Stable identity / tokens ────────────────────────────────────────────────

/** SHA-256 of the canonical revision inputs — detects any drift between the
 * pinned snapshot and what a reviewer is shown. */
export function revisionFingerprint(input: { projectId: string; sessionNo: number; versionNumber: number; sequenceJson: string; settingsJson: string | null }): string {
  return createHash("sha256").update(JSON.stringify({
    projectId: input.projectId,
    sessionNo: input.sessionNo,
    versionNumber: input.versionNumber,
    sequence: input.sequenceJson,
    settings: input.settingsJson ?? null,
  })).digest("hex");
}

/** 256-bit URL-safe token (invitations, review links, guest sessions). */
export function newOpaqueToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// ── Enum-safe state machines ────────────────────────────────────────────────

export const INVITATION_STATES = ["PENDING", "ACCEPTED", "REJECTED", "EXPIRED", "REVOKED"] as const;
export const REVISION_STATES = ["PROCESSING", "READY_FOR_REVIEW", "IN_REVIEW", "CHANGES_REQUESTED", "APPROVED", "SUPERSEDED", "CANCELLED", "FAILED"] as const;
export type RevisionState = (typeof REVISION_STATES)[number];

/** Allowed revision transitions (enforced server-side on every update). */
export const REVISION_TRANSITIONS: Record<string, string[]> = {
  PROCESSING: ["READY_FOR_REVIEW", "FAILED", "CANCELLED", "SUPERSEDED"],
  READY_FOR_REVIEW: ["IN_REVIEW", "APPROVED", "CHANGES_REQUESTED", "SUPERSEDED", "CANCELLED"],
  IN_REVIEW: ["CHANGES_REQUESTED", "APPROVED", "SUPERSEDED", "CANCELLED"],
  CHANGES_REQUESTED: ["IN_REVIEW", "SUPERSEDED", "CANCELLED"],
  APPROVED: ["SUPERSEDED"],
  FAILED: ["SUPERSEDED"],
  CANCELLED: [],
  SUPERSEDED: [],
};

export function transitionRevision(from: string, to: string): boolean {
  return (REVISION_TRANSITIONS[from] ?? []).includes(to);
}

export const REVIEW_LINK_PERMISSIONS = ["VIEW", "COMMENT", "APPROVE"] as const;
export const DECISIONS = ["APPROVE", "REQUEST_CHANGES", "REJECT"] as const;

/** Final revision status from per-reviewer decisions (deterministic). */
export function finalStatusFromDecisions(policy: "ALL" | "ANY", decisions: string[]): "APPROVED" | "CHANGES_REQUESTED" {
  if (decisions.length === 0) return "CHANGES_REQUESTED";
  if (policy === "ANY") {
    return decisions.includes("APPROVE") ? "APPROVED" : "CHANGES_REQUESTED";
  }
  return decisions.every((d) => d === "APPROVE") ? "APPROVED" : "CHANGES_REQUESTED";
}

/** Marks stale PENDING invitations EXPIRED (explicit lifecycle; invoked from
 * acceptance/preview flows so the state never silently lies). */
export async function expireStaleInvitations(): Promise<number> {
  const r = await db.invitation.updateMany({
    where: { state: "PENDING", expiresAt: { lte: new Date() } },
    data: { state: "EXPIRED", decidedAt: new Date() },
  });
  return r.count;
}

/** Marks stale ACTIVE review links EXPIRED. */
export async function expireStaleReviewLinks(): Promise<number> {
  const r = await db.reviewLink.updateMany({
    where: { state: "ACTIVE", expiresAt: { lte: new Date() } },
    data: { state: "EXPIRED" },
  });
  return r.count;
}
