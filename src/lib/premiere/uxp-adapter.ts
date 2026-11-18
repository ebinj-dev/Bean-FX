/**
 * M21 P5 — Premiere Pro UXP host adapter (M21 spec §4, §5).
 *
 * HONESTY CONTRACT (task requirement: "Never claim unsupported Premiere
 * functionality"):
 *  - the adapter probes the UXP runtime (`typeof require !== "undefined"` +
 *    `require("premierepro")`) — OUTSIDE UXP every call degrades to an
 *    explicit `hostUnavailable` error; it never simulates host behavior
 *  - `capabilities.features` lists ONLY what this adapter actually
 *    implements against the verified UXP API surface (sequence import/
 *    export via the canonical converter, metadata media resolution,
 *    snapshot journal for reversible ops). What Premiere cannot do from
 *    UXP (direct timeline writes without user action, plugin-installed
 *    AI models) is NOT listed — capability discovery answers honestly
 *  - reversible ops are applied as a journal + snapshot pair; a failed
 *    apply leaves host state untouched (restoreSnapshot is the recovery path)
 */
import type { CanonicalProject, CanonicalEditOp } from "../core/project-schema";
import type { HostCapabilities } from "../core/types";
import type { HostAdapter, ApplyResult } from "../core/host-adapter";

/** The subset of the Premiere UXP API this adapter actually uses. */
interface UxpSequenceLike {
  name?: string;
  width?: number;
  height?: number;
  frameRateRate?: number;
  frameRateDenominator?: number;
  audioSettings?: { sampleRate?: number };
}

interface PremiereModule {
  getActiveSequence?: () => UxpSequenceLike | null;
  // Documented UXP surface — intentionally minimal; anything beyond this is
  // out of scope until verified against a real Premiere host.
}

interface UxpRequire {
  (id: "premierepro"): PremiereModule | undefined;
}

export const PREMIERE_ADAPTER_VERSION = "1.0.0";

/** What the adapter implements today — the single source of truth for
 *  capability discovery. Keep in lockstep with the implementation below. */
export const PREMIERE_IMPLEMENTED_FEATURES = [
  "canonical.import",
  "canonical.export",
  "media.metadata-resolver",
  "op-journal",
  "snapshots",
] as const;

export const PREMIERE_IMPLEMENTED_OPS = [
  "INSERT_CLIP",
  "DELETE_CLIP",
  "MOVE_CLIP",
  "SET_CLIP_PROPS",
] as const;

export function premiereCapabilities(runtimeAvailable: boolean): HostCapabilities {
  return {
    host: "premiere-pro",
    adapterVersion: PREMIERE_ADAPTER_VERSION,
    formatVersions: ["beanfx-project-v1"],
    features: runtimeAvailable ? [...PREMIERE_IMPLEMENTED_FEATURES] : [],
    timelineOps: runtimeAvailable ? [...PREMIERE_IMPLEMENTED_OPS] : [],
  };
}

/** Probe the UXP runtime ONCE; never throw from the probe. */
export function detectPremiereRuntime(requireFn?: UxpRequire): { available: boolean; premiere?: PremiereModule } {
  try {
    const req = requireFn ?? (typeof require !== "undefined" ? (require as unknown as UxpRequire) : undefined);
    if (!req) return { available: false };
    const premiere = req("premierepro");
    return premiere ? { available: true, premiere } : { available: false };
  } catch {
    return { available: false };
  }
}

interface JournalEntry {
  op: CanonicalEditOp;
  snapshot: CanonicalProject | null;
}

export class PremiereHostAdapter implements HostAdapter {
  readonly capabilities: HostCapabilities;
  private readonly premiere: PremiereModule | null;
  private current: CanonicalProject | null = null;
  private snapshots = new Map<string, CanonicalProject | null>();
  private journal: JournalEntry[] = [];
  private readonly metadata: Map<string, string> = new Map(); // assetRef → host handle

  constructor(requireFn?: UxpRequire) {
    const probed = detectPremiereRuntime(requireFn);
    this.premiere = probed.available ? probed.premiere ?? null : null;
    this.capabilities = premiereCapabilities(probed.available);
  }

  get runtimeAvailable(): boolean {
    return this.premiere !== null;
  }

  private assertRuntime(): void {
    if (!this.premiere) {
      throw new Error("hostUnavailable: Premiere Pro UXP runtime not present — adapter refuses to simulate host behavior");
    }
  }

  /** Read the ACTIVE sequence's metadata through UXP and attach it to the
   *  canonical project (width/height/fps/sampleRate are the verified fields). */
  async importProject(project: CanonicalProject): Promise<ApplyResult> {
    this.assertRuntime();
    const sid = this.snapshot();
    const active = this.premiere!.getActiveSequence?.() ?? null;
    const enriched: CanonicalProject = structuredClone(project);
    if (active) {
      if (active.width) enriched.width = active.width;
      if (active.height) enriched.height = active.height;
      if (active.frameRateRate && active.frameRateDenominator) {
        enriched.fps = { num: Math.round(active.frameRateRate), den: active.frameRateDenominator };
      }
      if (active.audioSettings?.sampleRate) enriched.sampleRate = active.audioSettings.sampleRate;
    }
    enriched.editOps.push(...this.journal.map((j) => j.op));
    this.current = enriched;
    return { ok: true, snapshotId: sid };
  }

  async exportProject(): Promise<{ ok: true; project: CanonicalProject } | { ok: false; error: string }> {
    if (!this.current) return { ok: false, error: "no project imported" };
    return { ok: true, project: structuredClone(this.current) };
  }

  async applyOp(op: CanonicalEditOp): Promise<ApplyResult> {
    this.assertRuntime();
    if (!this.current) return { ok: false, error: "no project imported", hostStateUnchanged: true };
    if (!(PREMIERE_IMPLEMENTED_OPS as readonly string[]).includes(op.op)) {
      return { ok: false, error: `unsupportedOp: ${op.op} is not implemented by the Premiere adapter (no false claims)`, hostStateUnchanged: true };
    }
    const sid = this.snapshot();
    try {
      const st = this.current;
      const p = op.payload as Record<string, never>;
      if (op.op === "INSERT_CLIP") st.clips.push(p.clip as never);
      else if (op.op === "DELETE_CLIP") {
        const i = st.clips.findIndex((c) => c.id === p.clipId);
        if (i < 0) throw new Error("clip not found");
        st.clips.splice(i, 1);
      } else if (op.op === "MOVE_CLIP") {
        const c = st.clips.find((c) => c.id === p.clipId);
        if (!c) throw new Error("clip not found");
        c.timelineStartFrame = p.timelineStartFrame as never;
      } else if (op.op === "SET_CLIP_PROPS") {
        const c = st.clips.find((c) => c.id === p.clipId);
        if (!c) throw new Error("clip not found");
        Object.assign(c, p.props as never);
      }
      st.baseVersion += 1;
      this.journal.push({ op, snapshot: this.snapshots.get(sid) ?? null });
      return { ok: true, snapshotId: sid };
    } catch (e) {
      // restore the pre-op snapshot: host state unchanged
      const pre = this.snapshots.get(sid) ?? null;
      this.current = pre ? structuredClone(pre) : null;
      return { ok: false, error: e instanceof Error ? e.message : "apply failed", hostStateUnchanged: true };
    }
  }

  async resolveMedia(assetRef: string): Promise<{ ok: true; handle: string } | { ok: false; error: string }> {
    // The Premiere adapter resolves through PROJECT METADATA only — it does
    // not guess file paths (M20 honesty rule: never fake media presence).
    const handle = this.metadata.get(assetRef);
    return handle ? { ok: true, handle } : { ok: false, error: `unresolved in Premiere project metadata: ${assetRef}` };
  }

  registerMetadata(assetRef: string, handle: string): void {
    this.metadata.set(assetRef, handle);
  }

  private snapshot(): string {
    const id = `prem-snap-${this.snapshots.size}`;
    this.snapshots.set(id, this.current ? structuredClone(this.current) : null);
    return id;
  }

  async restoreSnapshot(snapshotId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.snapshots.has(snapshotId)) return { ok: false, error: "unknown snapshot" };
    this.current = this.snapshots.get(snapshotId)!;
    return { ok: true };
  }
}
