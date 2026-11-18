/**
 * @beanfx/core — host adapter interface (M21 spec §3, §4, §10, §11)
 *
 * The ONLY contract a host integration (Premiere panel, Desktop Bridge,
 * mock/test host) implements. Adapters apply reversible editing ops as
 * transactions with snapshots, negotiate capabilities, and resolve media.
 * This module defines the interface, the op/inverse helpers and a MockHost
 * used by the contract tests — importing it does not touch any host.
 */
import type { CanonicalProject, CanonicalEditOp } from "./project-schema";
import type { HostCapabilities } from "./types";

export type ApplyResult =
  | { ok: true; snapshotId: string }
  | { ok: false; error: string; hostStateUnchanged: true };

export interface HostAdapter {
  readonly capabilities: HostCapabilities;
  /** Import: receive a canonical project into the host (atomic). */
  importProject(project: CanonicalProject, opts?: { baseVersion?: number }): Promise<ApplyResult>;
  /** Export: the host's current state as a canonical project (atomic). */
  exportProject(): Promise<{ ok: true; project: CanonicalProject } | { ok: false; error: string }>;
  /** Apply one reversible op as a transaction. On rejection the host must
   *  be exactly at its pre-op state (§10/§11 acceptance). */
  applyOp(op: CanonicalEditOp): Promise<ApplyResult>;
  /** Resolve a media reference to a host handle (§9). */
  resolveMedia(assetRef: string): Promise<{ ok: true; handle: string } | { ok: false; error: string }>;
  /** Restore a snapshot taken by applyOp/importProject (recovery, §11). */
  restoreSnapshot(snapshotId: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

// ---------- op/inverse helpers (§10) ----------

export function makeOp(op: CanonicalEditOp["op"], payload: Record<string, unknown>, inverse: Record<string, unknown> | null, id = cryptoRandomId()): CanonicalEditOp {
  return { id, op, payload, inverse, createdAt: new Date().toISOString() };
}

/** Build the inverse payload for common ops; returns null when the op has
 *  no faithful inverse (the caller must then fall back to snapshots). */
export function inverseOf(op: CanonicalEditOp): CanonicalEditOp | null {
  if (!op.inverse || Object.keys(op.inverse).length === 0) return null;
  return makeOp(inverseOpName(op.op), op.inverse as Record<string, unknown>, op.payload, `${op.id}:undo`);
}

function inverseOpName(op: CanonicalEditOp["op"]): CanonicalEditOp["op"] {
  switch (op) {
    case "INSERT_CLIP": return "DELETE_CLIP";
    case "DELETE_CLIP": return "INSERT_CLIP";
    case "ADD_TRACK": return "REMOVE_TRACK";
    case "REMOVE_TRACK": return "ADD_TRACK";
    case "SET_CLIP_PROPS": return "SET_CLIP_PROPS";
    case "MOVE_CLIP": return "MOVE_CLIP";
    case "SET_TRANSITION": return "SET_TRANSITION";
    case "REMOVE_TRANSITION": return "SET_TRANSITION";
    default: return op; // TRIM/SPLIT/OVERWRITE rely on explicit inverse payloads
  }
}

function cryptoRandomId(): string {
  // Deterministic-friendly id; hosts may replace with their own id scheme.
  return `op-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

// ---------- optimistic concurrency (§11) ----------

export type ConflictResolution = { outcome: "applied" } | { outcome: "conflict"; currentBaseVersion: number } | { outcome: "rejected"; error: string };

/** Compare-and-swap gate shared by every host surface: an op/project carrying
 *  a stale baseVersion NEVER applies; the response is machine-readable. */
export function checkBaseVersion(currentBase: number, incomingBase: number | undefined): ConflictResolution {
  if (incomingBase === undefined) return { outcome: "rejected", error: "baseVersion required for host hand-off" };
  if (incomingBase !== currentBase) return { outcome: "conflict", currentBaseVersion: currentBase };
  return { outcome: "applied" };
}

// ---------- mock host for contract tests (no external dependency) ----------

export class MockHost implements HostAdapter {
  readonly capabilities: HostCapabilities = {
    host: "mock",
    adapterVersion: "1.0.0",
    formatVersions: ["beanfx-project-v1"],
    features: ["import", "export", "ops", "snapshots", "media-resolver"],
    timelineOps: ["INSERT_CLIP", "DELETE_CLIP", "MOVE_CLIP", "SET_CLIP_PROPS"],
  };
  private state: CanonicalProject | null = null;
  private snapshots = new Map<string, CanonicalProject | null>();
  private media = new Map<string, string>();
  failNextApply = false;

  registerMedia(ref: string, handle: string) {
    this.media.set(ref, handle);
  }
  private snap(): string {
    const id = `snap-${this.snapshots.size}`;
    this.snapshots.set(id, this.state ? structuredClone(this.state) : null);
    return id;
  }
  async importProject(project: CanonicalProject): Promise<ApplyResult> {
    const sid = this.snap();
    this.state = structuredClone(project);
    return { ok: true, snapshotId: sid };
  }
  async exportProject() {
    if (!this.state) return { ok: false as const, error: "no project imported" };
    return { ok: true as const, project: structuredClone(this.state) };
  }
  async applyOp(op: CanonicalEditOp): Promise<ApplyResult> {
    if (this.failNextApply) {
      this.failNextApply = false;
      return { ok: false, error: "simulated host failure", hostStateUnchanged: true };
    }
    const sid = this.snap();
    // Minimal faithful application for the supported ops.
    const st = this.state;
    if (!st) return { ok: false, error: "no project imported", hostStateUnchanged: true };
    const p = op.payload as Record<string, never>;
    if (op.op === "INSERT_CLIP") st.clips.push(p.clip as never);
    else if (op.op === "DELETE_CLIP") {
      const i = st.clips.findIndex((c) => c.id === p.clipId);
      if (i >= 0) st.clips.splice(i, 1);
    } else if (op.op === "MOVE_CLIP") {
      const c = st.clips.find((c) => c.id === p.clipId);
      if (c) c.timelineStartFrame = p.timelineStartFrame as never;
    } else if (op.op === "SET_CLIP_PROPS") {
      const c = st.clips.find((c) => c.id === p.clipId);
      if (c) Object.assign(c, p.props as never);
    } else {
      return { ok: false, error: `op ${op.op} not supported by mock host`, hostStateUnchanged: true };
    }
    st.baseVersion += 1;
    st.editOps.push(op);
    return { ok: true, snapshotId: sid };
  }
  async resolveMedia(ref: string) {
    const h = this.media.get(ref);
    return h ? { ok: true as const, handle: h } : { ok: false as const, error: `unresolved media ${ref}` };
  }
  async restoreSnapshot(snapshotId: string) {
    if (!this.snapshots.has(snapshotId)) return { ok: false as const, error: "unknown snapshot" };
    this.state = this.snapshots.get(snapshotId)!;
    return { ok: true as const };
  }
}
