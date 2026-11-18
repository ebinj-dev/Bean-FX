/**
 * @beanfx/core — shared contracts (M21 spec §1, §3, §7, §12)
 *
 * Type-level contracts used by Studio, the Premiere panel, the Desktop
 * Bridge and the MCP server. No UI and no database access may live here.
 */
import type { Rational } from "./timebase";

// ---------- roles & token scopes (M21 §7) ----------

/** Additive roles on top of M19's "user"|"admin" account roles. These are
 *  PROJECT-level roles resolved from project membership; a token's scope
 *  set can only narrow, never widen, what the inviting user may do. */
export type ProjectRole = "owner" | "editor" | "reviewer" | "viewer";

export const TOKEN_SCOPES = [
  "projects:read",
  "projects:write",
  "jobs:submit",
  "jobs:read",
  "jobs:cancel",
  "media:upload",
  "mcp:invoke",
] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/** Scope set → effective project role. Narrowing only (M21 §7 acceptance:
 *  a token can never exceed the inviting user's own role). */
export const SCOPES_TO_ROLE: Record<TokenScope, ProjectRole> = {
  "projects:read": "viewer",
  "projects:write": "editor",
  "jobs:submit": "editor",
  "jobs:read": "viewer",
  "jobs:cancel": "editor",
  "media:upload": "editor",
  "mcp:invoke": "viewer",
};

export function effectiveRole(scopes: readonly TokenScope[]): ProjectRole {
  let best: ProjectRole = "viewer";
  for (const s of scopes) {
    const r = SCOPES_TO_ROLE[s];
    if (r === "editor") best = "editor";
  }
  return best;
}

const ROLE_RANK: Record<ProjectRole, number> = { viewer: 0, reviewer: 1, editor: 2, owner: 3 };
export function roleAtLeast(role: ProjectRole, min: ProjectRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

// ---------- capability discovery (M21 §12) ----------

export const CORE_API_VERSION = "v1";
export const CORE_FORMAT_VERSION = "beanfx-project-v1";

export interface CapabilityDescriptor {
  api: string;               // e.g. "v1"
  formatVersions: string[];  // canonical formats this surface speaks
  features: string[];        // feature flags actually implemented
  limits: Record<string, number>;
}

export const SERVER_CAPABILITIES: CapabilityDescriptor = {
  api: CORE_API_VERSION,
  formatVersions: [CORE_FORMAT_VERSION],
  features: [
    "projects",
    "timeline",
    "render.jobs",
    "media.upload",
    "captions",
    "ai.providers",
    "approvals",
  ],
  limits: {
    maxClipsPerSequence: 20000,
    maxTracks: 64,
    globalMaxActiveRenders: 3,
    maxUploadBytes: 524288000,
  },
};

export interface HostCapabilities {
  host: string;              // "premiere-pro" | "desktop-bridge" | "mock"
  adapterVersion: string;
  formatVersions: string[];
  features: string[];        // only what the adapter REALLY implements
  timelineOps: string[];     // reversible ops the host can apply
}

// ---------- canonical media references (M21 §9) ----------

export const ASSET_SCHEME = "beanfx-asset";
export type AssetRef = `${typeof ASSET_SCHEME}://${string}`;

export function assetRef(assetId: string): AssetRef {
  return `beanfx-asset://${assetId}`;
}

export function parseAssetRef(ref: string): { id: string } | null {
  const m = /^beanfx-asset:\/\/([A-Za-z0-9_-]{1,64})$/.exec(ref);
  return m ? { id: m[1] } : null;
}

// ---------- job contracts (M21 §4.4 durable jobs, mirrors M20) ----------

export type JobKind = "RENDER";
export type JobStatus = "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED"; // mirrors the M20 Job model exactly

export interface JobSubmission {
  kind: JobKind;
  projectId: string;
  sequenceId?: string;
  /** Canonical project payload when submitting from a host without a
   *  server-side project (bridge/premiere hand-off). */
  project?: unknown;
  createdBy: string;         // token id or "web:<userId>"
}

export interface JobView {
  id: string;
  kind: JobKind;
  status: JobStatus;
  progress: number;
  error?: string;
  createdAt?: string;
}

// ---------- API compatibility (M21 §13) ----------

export const COMPAT_WINDOW = { minMinor: -1, maxMinor: 1 }; // ±1 minor on v1

export interface ApiVersionInfo {
  prefix: string;            // "/api/v1"
  supported: string[];       // ["v1"]
  upgradeRequiredFor: string[];
}
