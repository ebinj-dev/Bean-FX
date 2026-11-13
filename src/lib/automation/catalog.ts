/**
 * Automation tool catalog (M8 §9A/§9C) — THE shared service layer behind both
 * the MCP server and the JSON-RPC automation API. One implementation, two
 * transports; no second editing engine.
 *
 * Rules enforced here:
 *  - Only REAL, implemented backend operations are exposed (§9A).
 *  - Typed zod input schemas; structured responses; normalized errors.
 *  - Permission profile per tool (read-only tools available to both profiles;
 *    mutating tools require the "editing" profile).
 *  - Every tool call is audit-logged with the caller + project scope.
 *  - No filesystem/shell/SQL/FFmpeg-pass-through tools exist.
 */
import { z } from "zod";
import { db } from "@/lib/db";
import { getTimelineHead, listTimelineVersions, applyTimelineEdits } from "@/lib/editor/persistence";
import { capabilityCatalog } from "@/lib/my-ai/discovery/effects";
import { renderPreviewFrame } from "@/lib/my-ai/preview/frames";
import { createPlan } from "@/lib/my-ai/planner/planner";
import { approvePlan, cancelPlan, expireStalePlans, loadOwnedPlan, planApprovalSummary } from "@/lib/my-ai/approvals";
import { executePlan } from "@/lib/my-ai/execution/executor";
import { ffprobe } from "@/lib/media-storage";
import { jobManager } from "@/lib/job-runner";
import { proposeNikki } from "@/lib/nikki/proposal";

export type ToolProfile = "read-only" | "editing";

export interface ToolContext {
  userId: string;
  profile: ToolProfile;
  allowlist: string[];
  /** Audit destination (token id or "session"). */
  clientLabel: string;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  profile: ToolProfile;
  inputSchema: z.ZodType<Record<string, unknown>>;
  /** Returns a JSON-serializable structured result. */
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

class ToolError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

async function ownedProject(projectId: string, userId: string): Promise<{ id: string; name: string; settingsJson: string | null }> {
  const p = await db.project.findFirst({ where: { id: projectId, userId } });
  if (!p) throw new ToolError("PROJECT_NOT_FOUND", "Project not found or not owned by this token's user.");
  return p as unknown as { id: string; name: string; settingsJson: string | null };
}

/** Head sequence for an owned project (shared by read + edit tools). */
async function headSequence(projectId: string, userId: string) {
  const head = await getTimelineHead(projectId, userId);
  return head;
}

const ProjectId = z.object({ projectId: z.string().min(1).max(64) });

export const TOOL_CATALOG: ToolDef[] = [
  // ── Projects ──────────────────────────────────────────────────────────────
  {
    name: "bean_project_list", title: "List projects", profile: "read-only",
    description: "List the caller's projects (id, name, timestamps).",
    inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
    async handler(args, ctx) {
      const rows = await db.project.findMany({
        where: { userId: ctx.userId },
        orderBy: { updatedAt: "desc" },
        take: Math.min(50, Number(args.limit ?? 20)),
        select: { id: true, name: true, description: true, createdAt: true, updatedAt: true },
      });
      return { projects: rows };
    },
  },
  {
    name: "bean_project_create", title: "Create project", profile: "editing",
    description: "Create a new project owned by the token's user.",
    inputSchema: z.object({ name: z.string().min(1).max(120), description: z.string().max(500).optional() }),
    async handler(args, ctx) {
      const row = await db.project.create({
        data: { userId: ctx.userId, name: String(args.name).slice(0, 120), description: args.description ? String(args.description).slice(0, 500) : null, settingsJson: JSON.stringify({ width: 1280, height: 720, fps: { num: 30, den: 1 }, sampleRate: 48000 }) },
      });
      return { project: { id: row.id, name: row.name } };
    },
  },
  {
    name: "bean_project_get", title: "Get project", profile: "read-only",
    description: "Project header + bounded timeline summary.",
    inputSchema: ProjectId,
    async handler(args, ctx) {
      const p = await ownedProject(String(args.projectId), ctx.userId);
      const head = await headSequence(p.id, ctx.userId);
      const seq = head.sequence;
      return {
        project: { id: p.id, name: p.name },
        sequence: { fps: seq.fps, width: seq.width, height: seq.height, version: head.version, tracks: seq.tracks.length, clips: seq.clips.length, durationFrames: seq.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0) },
      };
    },
  },
  {
    name: "bean_project_versions", title: "List timeline versions", profile: "read-only",
    description: "Version history (number, autosave flag, edit count, timestamp).",
    inputSchema: ProjectId,
    async handler(args, ctx) {
      const p = await ownedProject(String(args.projectId), ctx.userId);
      const versions = await listTimelineVersions(p.id, ctx.userId, 30);
      return { versions };
    },
  },

  // ── Timeline reading ──────────────────────────────────────────────────────
  {
    name: "bean_timeline_read", title: "Read timeline", profile: "read-only",
    description: "The current sequence snapshot (bounded: full tracks, clips trimmed).",
    inputSchema: ProjectId.extend({ maxClips: z.number().int().min(1).max(200).default(60) }),
    async handler(args, ctx) {
      const p = await ownedProject(String(args.projectId), ctx.userId);
      const head = await headSequence(p.id, ctx.userId);
      const seq = head.sequence;
      const max = Math.min(200, Number(args.maxClips ?? 60));
      return {
        version: head.version,
        fps: seq.fps,
        width: seq.width,
        height: seq.height,
        tracks: seq.tracks,
        transitions: seq.transitions,
        clips: seq.clips.slice(0, max).map((c) => ({ ...c, keyframes: undefined, effects: c.effects })),
        clipsTotal: seq.clips.length,
      };
    },
  },
  {
    name: "bean_timeline_get_tracks", title: "Get tracks", profile: "read-only",
    description: "Track list with kinds and lock/mute/visibility state.",
    inputSchema: ProjectId,
    async handler(args, ctx) {
      const p = await ownedProject(String(args.projectId), ctx.userId);
      const head = await headSequence(p.id, ctx.userId);
      return { tracks: head.sequence.tracks, version: head.version };
    },
  },
  {
    name: "bean_timeline_get_clips", title: "Get clips", profile: "read-only",
    description: "Clips (optionally filtered by track) with positions and source refs.",
    inputSchema: ProjectId.extend({ trackId: z.string().max(64).optional() }),
    async handler(args, ctx) {
      const p = await ownedProject(String(args.projectId), ctx.userId);
      const head = await headSequence(p.id, ctx.userId);
      const clips = head.sequence.clips.filter((c) => (args.trackId ? c.trackId === args.trackId : true));
      return { clips: clips.slice(0, 200), total: clips.length, version: head.version };
    },
  },
  {
    name: "bean_timeline_get_playhead", title: "Get playhead info", profile: "read-only",
    description: "Sequence duration + the server-side 'current version' marker. The live playhead is editor-session state; this tool reports the timeline state instead (documented).",
    inputSchema: ProjectId,
    async handler(args, ctx) {
      const p = await ownedProject(String(args.projectId), ctx.userId);
      const head = await headSequence(p.id, ctx.userId);
      const seq = head.sequence;
      const fps = seq.fps.num / seq.fps.den;
      return { version: head.version, durationFrames: seq.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0), durationSec: Number((seq.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0) / fps).toFixed(3)), note: "The playhead is per-editor-session state and is not stored server-side." };
    },
  },

  // ── Media ─────────────────────────────────────────────────────────────────
  {
    name: "bean_media_list", title: "List media", profile: "read-only",
    description: "The caller's media assets (bounded list, kind filter).",
    inputSchema: z.object({ kind: z.enum(["VIDEO", "AUDIO", "IMAGE", "SUBTITLE"]).optional(), limit: z.number().int().min(1).max(100).default(30) }),
    async handler(args, ctx) {
      const rows = await db.mediaAsset.findMany({
        where: { userId: ctx.userId, ...(args.kind ? { kind: args.kind } : {}) },
        orderBy: { createdAt: "desc" },
        take: Math.min(100, Number(args.limit ?? 30)),
        select: { id: true, originalName: true, kind: true, mimeType: true, sizeBytes: true, durationSec: true, width: true, height: true, createdBy: true, provider: true, createdAt: true },
      });
      return { assets: rows };
    },
  },
  {
    name: "bean_media_probe", title: "Probe media", profile: "read-only",
    description: "Real ffprobe of an owned asset's stored file.",
    inputSchema: z.object({ mediaId: z.string().min(1).max(64) }),
    async handler(args, ctx) {
      const a = await db.mediaAsset.findFirst({ where: { id: String(args.mediaId), userId: ctx.userId } });
      if (!a) throw new ToolError("MEDIA_NOT_FOUND", "Asset not found or not owned.");
      const probe = await ffprobe(a.storagePath);
      return { asset: { id: a.id, name: a.originalName, kind: a.kind, mimeType: a.mimeType, sizeBytes: a.sizeBytes }, probe };
    },
  },
  {
    name: "bean_media_get_metadata", title: "Media metadata", profile: "read-only",
    description: "Stored metadata + provenance (createdBy/provider/prompt) for an owned asset.",
    inputSchema: z.object({ mediaId: z.string().min(1).max(64) }),
    async handler(args, ctx) {
      const a = await db.mediaAsset.findFirst({ where: { id: String(args.mediaId), userId: ctx.userId } });
      if (!a) throw new ToolError("MEDIA_NOT_FOUND", "Asset not found or not owned.");
      return {
        id: a.id, name: a.originalName, kind: a.kind, mimeType: a.mimeType, sizeBytes: a.sizeBytes,
        durationSec: a.durationSec, width: a.width, height: a.height, fps: a.fps,
        sha256: a.sha256, createdBy: a.createdBy, provider: a.provider, model: a.model, prompt: a.prompt, license: a.license, attribution: a.attribution, referenceAssetId: a.referenceAssetId,
      };
    },
  },

  // ── Editing (editing profile; all through the M1 command engine) ──────────
  {
    name: "bean_edit_apply", title: "Apply edit commands", profile: "editing",
    description: "Apply validated M1 commands to the timeline (versioned; conflicts rejected).",
    inputSchema: ProjectId.extend({ commands: z.array(z.record(z.string(), z.unknown())).min(1).max(100) }),
    async handler(args, ctx) {
      const p = await ownedProject(String(args.projectId), ctx.userId);
      const head = await headSequence(p.id, ctx.userId);
      // Pre-validate through the command engine BEFORE persistence.
      const rawCommands = (args.commands ?? []) as unknown[];
      const commands = rawCommands.map((c) => parseCommandStrict(c));
      let seq = head.sequence;
      for (const c of commands) seq = applyCommandLocal(seq, c).sequence;
      const result = await applyTimelineEdits(p.id, ctx.userId, head.version, rawCommands, false);
      return { ok: true, version: result.version, applied: commands.length, warnings: result.warnings };
    },
  },
  {
    name: "bean_clip_add", title: "Add clip", profile: "editing",
    description: "Add a clip of an owned asset to a track (AddClip through the command engine).",
    inputSchema: ProjectId.extend({ assetId: z.string().min(1).max(64), trackId: z.string().min(1).max(64), startFrame: z.number().int().min(0).max(2_000_000).default(0), durationFrames: z.number().int().min(1).max(2_000_000).optional() }),
    async handler(args, ctx) {
      const p = await ownedProject(String(args.projectId), ctx.userId);
      const asset = await db.mediaAsset.findFirst({ where: { id: String(args.assetId), userId: ctx.userId } });
      if (!asset) throw new ToolError("MEDIA_NOT_FOUND", "Asset not found or not owned.");
      const head = await headSequence(p.id, ctx.userId);
      const seq = head.sequence;
      const track = seq.tracks.find((t) => t.id === args.trackId);
      if (!track) throw new ToolError("TRACK_NOT_FOUND", `Track ${String(args.trackId)} not found.`);
      if (track.locked) throw new ToolError("TRACK_LOCKED", `Track ${track.name} is locked.`);
      const fpsNum = asset.fps && asset.fps > 0 ? asset.fps : seq.fps.num / seq.fps.den;
      const dur = Number(args.durationFrames ?? (asset.kind === "IMAGE" ? Math.round((seq.fps.num / seq.fps.den) * 5) : Math.max(12, Math.round((asset.durationSec ?? 5) * fpsNum))));
      const command = {
        type: "AddClip",
        clip: {
          id: `auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          trackId: track.id,
          sourceAssetId: asset.id,
          sourceInFrame: 0,
          sourceOutFrame: dur,
          sourceFps: { num: Math.round(fpsNum * 1000), den: 1000 },
          timelineStartFrame: Math.max(0, Number(args.startFrame ?? 0)),
          playbackSpeed: 1,
          volume: 1,
          muted: false,
          fadeInFrames: 0,
          fadeOutFrames: 0,
          transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
          captionText: null,
          captionStyle: null,
          graphicTemplateId: null,
          graphicStyle: null,
          label: `automation: ${asset.originalName}`.slice(0, 120),
          missingMedia: false,
          effects: [],
          keyframes: [],
        },
      };
      const result = await applyTimelineEdits(p.id, ctx.userId, head.version, [command], false);
      return { ok: true, version: result.version, clipId: (command.clip as { id: string }).id };
    },
  },
  {
    name: "bean_clip_trim", title: "Trim clip", profile: "editing",
    description: "Trim a clip's source range (TrimClip).",
    inputSchema: ProjectId.extend({ clipId: z.string().min(1).max(64), newSourceInFrame: z.number().int().min(0).optional(), newSourceOutFrame: z.number().int().min(1).optional() }),
    async handler(args, ctx) {
      const p = await ownedProject(String(args.projectId), ctx.userId);
      const head = await headSequence(p.id, ctx.userId);
      const clip = head.sequence.clips.find((c) => c.id === args.clipId);
      if (!clip) throw new ToolError("CLIP_NOT_FOUND", `Clip ${String(args.clipId)} not found.`);
      const command = { type: "TrimClip", clipId: clip.id, ...(args.newSourceInFrame !== undefined ? { newSourceInFrame: args.newSourceInFrame } : {}), ...(args.newSourceOutFrame !== undefined ? { newSourceOutFrame: args.newSourceOutFrame } : {}) };
      const result = await applyTimelineEdits(p.id, ctx.userId, head.version, [command], false);
      return { ok: true, version: result.version };
    },
  },
  {
    name: "bean_clip_split", title: "Split clip", profile: "editing",
    description: "Split a clip at an absolute timeline frame (SplitClip).",
    inputSchema: ProjectId.extend({ clipId: z.string().min(1).max(64), atTimelineFrame: z.number().int().min(0).max(2_000_000) }),
    async handler(args, ctx) {
      const p = await ownedProject(String(args.projectId), ctx.userId);
      const head = await headSequence(p.id, ctx.userId);
      const clip = head.sequence.clips.find((c) => c.id === args.clipId);
      if (!clip) throw new ToolError("CLIP_NOT_FOUND", `Clip ${String(args.clipId)} not found.`);
      const stamp = Date.now().toString(36);
      const result = await applyTimelineEdits(p.id, ctx.userId, head.version, [{ type: "SplitClip", clipId: clip.id, atTimelineFrame: Number(args.atTimelineFrame), newLeftId: `split-l-${stamp}`, newRightId: `split-r-${stamp}` }], false);
      return { ok: true, version: result.version, newLeftId: `split-l-${stamp}`, newRightId: `split-r-${stamp}` };
    },
  },
  {
    name: "bean_clip_move", title: "Move clip", profile: "editing",
    description: "Move a clip to a new track/position (MoveClip).",
    inputSchema: ProjectId.extend({ clipId: z.string().min(1).max(64), toTrackId: z.string().min(1).max(64).optional(), newTimelineStartFrame: z.number().int().min(0).max(2_000_000) }),
    async handler(args, ctx) {
      const p = await ownedProject(String(args.projectId), ctx.userId);
      const head = await headSequence(p.id, ctx.userId);
      const clip = head.sequence.clips.find((c) => c.id === args.clipId);
      if (!clip) throw new ToolError("CLIP_NOT_FOUND", `Clip ${String(args.clipId)} not found.`);
      const command: Record<string, unknown> = { type: "MoveClip", clipId: clip.id, newTimelineStartFrame: Number(args.newTimelineStartFrame) };
      if (args.toTrackId !== undefined) command.newTrackId = String(args.toTrackId);
      const result = await applyTimelineEdits(p.id, ctx.userId, head.version, [command], false);
      return { ok: true, version: result.version };
    },
  },
  {
    name: "bean_clip_remove", title: "Remove clip", profile: "editing",
    description: "Remove a clip (RemoveClip).",
    inputSchema: ProjectId.extend({ clipId: z.string().min(1).max(64) }),
    async handler(args, ctx) {
      const p = await ownedProject(String(args.projectId), ctx.userId);
      const head = await headSequence(p.id, ctx.userId);
      const clip = head.sequence.clips.find((c) => c.id === args.clipId);
      if (!clip) throw new ToolError("CLIP_NOT_FOUND", `Clip ${String(args.clipId)} not found.`);
      const result = await applyTimelineEdits(p.id, ctx.userId, head.version, [{ type: "RemoveClip", clipId: clip.id }], false);
      return { ok: true, version: result.version };
    },
  },
  {
    name: "bean_clip_transform", title: "Set clip transform", profile: "editing",
    description: "Update a clip's transform (x/y/scale/rotation/opacity) via UpdateClip.",
    inputSchema: ProjectId.extend({
      clipId: z.string().min(1).max(64),
      x: z.number().min(-100000).max(100000).optional(), y: z.number().min(-100000).max(100000).optional(),
      scale: z.number().min(0.01).max(20).optional(), rotation: z.number().min(-360).max(360).optional(),
      opacity: z.number().min(0).max(1).optional(),
    }),
    async handler(args, ctx) {
      const p = await ownedProject(String(args.projectId), ctx.userId);
      const head = await headSequence(p.id, ctx.userId);
      const clip = head.sequence.clips.find((c) => c.id === args.clipId);
      if (!clip) throw new ToolError("CLIP_NOT_FOUND", `Clip ${String(args.clipId)} not found.`);
      const transform = { ...clip.transform };
      if (args.x !== undefined) transform.x = Number(args.x);
      if (args.y !== undefined) transform.y = Number(args.y);
      if (args.scale !== undefined) transform.scale = Number(args.scale);
      if (args.rotation !== undefined) transform.rotation = Number(args.rotation);
      if (args.opacity !== undefined) transform.opacity = Number(args.opacity);
      const result = await applyTimelineEdits(p.id, ctx.userId, head.version, [{ type: "UpdateClipProperties", clipId: clip.id, transform }], false);
      return { ok: true, version: result.version, transform };
    },
  },

  // ── Effects / animation / templates ───────────────────────────────────────
  {
    name: "bean_effects_list", title: "List effects and capabilities", profile: "read-only",
    description: "Full capability catalog: effects, transitions, NIIKI templates, GANGZII presets, commands, engine capabilities, unsupported list.",
    inputSchema: z.object({}),
    async handler() {
      return capabilityCatalog();
    },
  },
  {
    name: "bean_effect_apply", title: "Add effect to clip", profile: "editing",
    description: "Attach a validated effect (from the capability catalog) to a clip via AddEffect.",
    inputSchema: ProjectId.extend({ clipId: z.string().min(1).max(64), effectType: z.enum(["opacity", "volume", "flipH", "flipV", "grayscale", "blur"]), params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}) }),
    async handler(args, ctx) {
      const p = await ownedProject(String(args.projectId), ctx.userId);
      const head = await headSequence(p.id, ctx.userId);
      const clip = head.sequence.clips.find((c) => c.id === args.clipId);
      if (!clip) throw new ToolError("CLIP_NOT_FOUND", `Clip ${String(args.clipId)} not found.`);
      const result = await applyTimelineEdits(p.id, ctx.userId, head.version, [{ type: "AddEffect", clipId: clip.id, effect: { id: `fx-${Date.now().toString(36)}`, type: args.effectType, enabled: true, params: args.params } }], false);
      return { ok: true, version: result.version };
    },
  },
  {
    name: "bean_keyframe_set", title: "Set keyframe", profile: "editing",
    description: "Set a transform-property keyframe on a clip (SetKeyframe).",
    inputSchema: ProjectId.extend({ clipId: z.string().min(1).max(64), property: z.enum(["x", "y", "scale", "rotation", "opacity"]), frame: z.number().int().min(0).max(2_000_000), value: z.number(), interpolation: z.enum(["LINEAR", "EASE_IN", "EASE_OUT", "EASE_IN_OUT", "STEP", "BEZIER"]).default("EASE_IN_OUT") }),
    async handler(args, ctx) {
      const p = await ownedProject(String(args.projectId), ctx.userId);
      const head = await headSequence(p.id, ctx.userId);
      const clip = head.sequence.clips.find((c) => c.id === args.clipId);
      if (!clip) throw new ToolError("CLIP_NOT_FOUND", `Clip ${String(args.clipId)} not found.`);
      const result = await applyTimelineEdits(p.id, ctx.userId, head.version, [{ type: "SetKeyframe", clipId: clip.id, keyframe: { id: `kf-${Date.now().toString(36)}`, property: args.property, frame: args.frame, value: args.value, interpolation: args.interpolation, bezier: null } }], false);
      return { ok: true, version: result.version };
    },
  },
  {
    name: "bean_keyframe_clear", title: "Clear keyframe", profile: "editing",
    description: "Remove a keyframe from a clip (RemoveKeyframe).",
    inputSchema: ProjectId.extend({ clipId: z.string().min(1).max(64), keyframeId: z.string().min(1).max(64) }),
    async handler(args, ctx) {
      const p = await ownedProject(String(args.projectId), ctx.userId);
      const head = await headSequence(p.id, ctx.userId);
      const clip = head.sequence.clips.find((c) => c.id === args.clipId);
      if (!clip) throw new ToolError("CLIP_NOT_FOUND", `Clip ${String(args.clipId)} not found.`);
      const result = await applyTimelineEdits(p.id, ctx.userId, head.version, [{ type: "RemoveKeyframe", clipId: clip.id, keyframeId: String(args.keyframeId) }], false);
      return { ok: true, version: result.version };
    },
  },
  {
    name: "bean_template_list", title: "List NIIKI templates", profile: "read-only",
    description: "Registered NIIKI motion-graphic templates with categories.",
    inputSchema: z.object({}),
    async handler() {
      const cat = capabilityCatalog();
      return { templates: cat.niikiTemplates };
    },
  },
  {
    name: "bean_template_apply", title: "Apply NIIKI template", profile: "editing",
    description: "Generate a NIIKI template proposal and apply its commands (server-side).",
    inputSchema: ProjectId.extend({ templateId: z.string().min(1).max(64), atFrame: z.number().int().min(0).max(2_000_000).default(0) }),
    async handler(args, ctx) {
      const p = await ownedProject(String(args.projectId), ctx.userId);
      const head = await headSequence(p.id, ctx.userId);
      const seq = head.sequence;
      const proposal = proposeNikki(`apply template ${String(args.templateId)}`, {
        seqFps: seq.fps,
        seqWidth: seq.width,
        seqHeight: seq.height,
        newId: (kind) => `mcp-nikki-${kind}-${Date.now().toString(36)}`,
        atFrame: Math.max(0, Number(args.atFrame ?? 0)),
        availableFrames: 900,
        selectedGraphicClipId: null,
        selectedGraphicStyle: null,
      });
      if (!proposal || proposal.commands.length === 0) throw new ToolError("NO_PROPOSAL", `No NIIKI proposal for template ${String(args.templateId)} — check bean_template_list for valid ids.`);
      const result = await applyTimelineEdits(p.id, ctx.userId, head.version, proposal.commands, false);
      return { ok: true, version: result.version, applied: proposal.commands.length };
    },
  },

  // ── Engines ───────────────────────────────────────────────────────────────
  {
    name: "bean_riishe_analyze", title: "Queue RIISHE analysis", profile: "editing",
    description: "Queue an autocut/transcription analysis job for an owned media asset (M4 pipeline).",
    inputSchema: z.object({ mediaId: z.string().min(1).max(64) }),
    async handler(args, ctx) {
      const a = await db.mediaAsset.findFirst({ where: { id: String(args.mediaId), userId: ctx.userId } });
      if (!a) throw new ToolError("MEDIA_NOT_FOUND", "Asset not found or not owned.");
      const jobId = await jobManager.createJob(ctx.userId, "autocut-analysis", { mediaId: a.id });
      return { ok: true, jobId, note: "Poll bean_export_status-style job state via /api/jobs/{jobId} (session) or bean_export_status with this jobId." };
    },
  },
  {
    name: "bean_gangzii_analyze", title: "Queue GANGZII analysis", profile: "editing",
    description: "Create a GANGZII ANALYSIS process row + durable job for an owned asset (M5).",
    inputSchema: z.object({ mediaId: z.string().min(1).max(64) }),
    async handler(args, ctx) {
      const a = await db.mediaAsset.findFirst({ where: { id: String(args.mediaId), userId: ctx.userId } });
      if (!a) throw new ToolError("MEDIA_NOT_FOUND", "Asset not found or not owned.");
      const row = await db.gangziiProcess.create({ data: { userId: ctx.userId, sourceAssetId: a.id, kind: "ANALYSIS", status: "QUEUED", name: "automation analysis" } });
      const jobId = await jobManager.createJob(ctx.userId, "GANGZII_ANALYZE", { processId: row.id });
      return { ok: true, processId: row.id, jobId };
    },
  },
  {
    name: "bean_gangzii_process", title: "Queue GANGZII processing", profile: "editing",
    description: "Create a GANGZII PROCESS row + durable job with a validated preset (M5).",
    inputSchema: z.object({ mediaId: z.string().min(1).max(64), preset: z.string().min(1).max(40) }),
    async handler(args, ctx) {
      const a = await db.mediaAsset.findFirst({ where: { id: String(args.mediaId), userId: ctx.userId } });
      if (!a) throw new ToolError("MEDIA_NOT_FOUND", "Asset not found or not owned.");
      const cat = capabilityCatalog();
      if (!cat.gangziiPresets.some((p) => p.id === args.preset)) throw new ToolError("UNKNOWN_PRESET", `Unknown preset ${String(args.preset)} — see bean_effects_list → gangziiPresets.`);
      const row = await db.gangziiProcess.create({ data: { userId: ctx.userId, sourceAssetId: a.id, kind: "PROCESS", status: "QUEUED", name: `automation: ${String(args.preset)}`, paramsJson: JSON.stringify({ preset: args.preset, params: {} }) } });
      const jobId = await jobManager.createJob(ctx.userId, "GANGZII_PROCESS", { processId: row.id });
      return { ok: true, processId: row.id, jobId };
    },
  },
  {
    name: "bean_niiki_create_graphic", title: "Create NIIKI graphic", profile: "editing",
    description: "Generate a NIIKI graphic proposal from an instruction and apply its commands.",
    inputSchema: ProjectId.extend({ instruction: z.string().min(1).max(300), atFrame: z.number().int().min(0).max(2_000_000).default(0) }),
    async handler(args, ctx) {
      const p = await ownedProject(String(args.projectId), ctx.userId);
      const head = await headSequence(p.id, ctx.userId);
      const seq = head.sequence;
      const proposal = proposeNikki(String(args.instruction), {
        seqFps: seq.fps, seqWidth: seq.width, seqHeight: seq.height,
        newId: (kind) => `mcp-nikki-${kind}-${Date.now().toString(36)}`,
        atFrame: Math.max(0, Number(args.atFrame ?? 0)),
        availableFrames: 900,
        selectedGraphicClipId: null,
        selectedGraphicStyle: null,
      });
      if (!proposal || proposal.commands.length === 0) throw new ToolError("NO_PROPOSAL", "NIIKI produced no valid proposal for this instruction.");
      const result = await applyTimelineEdits(p.id, ctx.userId, head.version, proposal.commands, false);
      return { ok: true, version: result.version, applied: proposal.commands.length, explanation: proposal.explanation };
    },
  },
  {
    name: "bean_jazmii_generate_video", title: "Queue JAZMII video generation", profile: "editing",
    description: "Queue a durable JAZMII generation job (metered external provider; provenance-registered output).",
    inputSchema: z.object({ projectId: z.string().max(64).optional(), prompt: z.string().min(3).max(2000), durationSec: z.enum(["5", "10"]).default("5"), size: z.enum(["1920x1080", "1280x720", "1080x1920", "720x1280"]).default("1920x1080"), fps: z.enum(["30", "60"]).default("30"), quality: z.enum(["speed", "quality"]).default("speed") }),
    async handler(args, ctx) {
      const { jobManager: jm } = await import("@/lib/job-runner");
      const { JOB_TYPE_JAZMII_GENERATE } = await import("@/lib/job-helpers");
      const { JazmiiGenerateParamsSchema } = await import("@/lib/jazmii/types");
      const parsed = JazmiiGenerateParamsSchema.safeParse({ prompt: args.prompt, operation: "textToVideo", referenceAssetId: null, quality: args.quality, size: args.size, fps: args.fps, durationSec: args.durationSec, withAudio: false, projectId: args.projectId ?? null });
      if (!parsed.success) throw new ToolError("INVALID_ARGS", parsed.error.issues.map((i) => i.message).join("; "));
      const jobId = await jm.createJob(ctx.userId, JOB_TYPE_JAZMII_GENERATE, parsed.data);
      return { ok: true, jobId, note: "External provider processing — metered. Output registers with provenance when complete." };
    },
  },
  {
    name: "bean_laxii_generate_image", title: "Queue LAXII image generation", profile: "editing",
    description: "Queue a durable LAXII generation job (metered external provider).",
    inputSchema: z.object({ projectId: z.string().max(64).optional(), prompt: z.string().min(3).max(2000), size: z.enum(["1024x1024", "768x1344", "864x1152", "1344x768", "1152x864", "1440x720", "720x1440"]).default("1344x768"), count: z.number().int().min(1).max(4).default(1), aspect: z.enum(["original", "16:9", "9:16", "1:1", "4:5"]).default("original") }),
    async handler(args, ctx) {
      const { jobManager: jm } = await import("@/lib/job-runner");
      const { JOB_TYPE_LAXII_GENERATE } = await import("@/lib/job-helpers");
      const { LaxiiGenerateParamsSchema } = await import("@/lib/laxii/types");
      const parsed = LaxiiGenerateParamsSchema.safeParse({ prompt: args.prompt, mode: "generate", referenceAssetId: null, size: args.size, count: args.count, aspect: args.aspect, projectId: args.projectId ?? null });
      if (!parsed.success) throw new ToolError("INVALID_ARGS", parsed.error.issues.map((i) => i.message).join("; "));
      const jobId = await jm.createJob(ctx.userId, JOB_TYPE_LAXII_GENERATE, parsed.data);
      return { ok: true, jobId, note: "External provider processing — metered. Output registers with provenance when complete." };
    },
  },

  // ── MY AI plans ───────────────────────────────────────────────────────────
  {
    name: "bean_ai_plan", title: "Create an editing plan", profile: "read-only",
    description: "Run the MY AI planner for a natural-language request (plan is approval-gated; nothing executes).",
    inputSchema: ProjectId.extend({ request: z.string().min(3).max(500) }),
    async handler(args, ctx) {
      const result = await createPlan(ctx.userId, String(args.projectId), String(args.request));
      const summary = planApprovalSummary(JSON.stringify(result.plan.steps), JSON.stringify(result.plan.warnings), JSON.stringify(result.plan.engines));
      return { planId: result.plan.planId, mode: result.mode, note: result.note, steps: summary.steps, warnings: summary.warnings, approvalRequired: true };
    },
  },
  {
    name: "bean_ai_get_plan", title: "Get plan", profile: "read-only",
    description: "Plan status + step outcomes (or the approval summary when not yet executed).",
    inputSchema: z.object({ planId: z.string().min(1).max(64) }),
    async handler(args, ctx) {
      await expireStalePlans();
      const row = await loadOwnedPlan(String(args.planId), ctx.userId);
      if (!row) throw new ToolError("PLAN_NOT_FOUND", "Plan not found or not owned.");
      const approval = row.status === "AWAITING_APPROVAL" ? planApprovalSummary(row.stepsJson, null, null) : null;
      return { planId: row.id, status: row.status, steps: approval?.steps ?? null, result: row.resultJson ? JSON.parse(row.resultJson) : null };
    },
  },
  {
    name: "bean_ai_approve_plan", title: "Approve plan", profile: "editing",
    description: "Explicitly approve a plan (required before execution).",
    inputSchema: z.object({ planId: z.string().min(1).max(64) }),
    async handler(args, ctx) {
      const r = await approvePlan(String(args.planId), ctx.userId);
      if (!r.ok) throw new ToolError("APPROVAL_FAILED", r.error ?? "approval failed");
      return { ok: true, status: r.status };
    },
  },
  {
    name: "bean_ai_execute_plan", title: "Execute approved plan", profile: "editing",
    description: "Execute an APPROVED plan through the engine entry points (partial failures reported truthfully).",
    inputSchema: z.object({ planId: z.string().min(1).max(64) }),
    async handler(args, ctx) {
      return executePlan(String(args.planId), ctx.userId);
    },
  },
  {
    name: "bean_ai_cancel_plan", title: "Cancel plan", profile: "editing",
    description: "Cancel an awaiting/approved/running plan.",
    inputSchema: z.object({ planId: z.string().min(1).max(64) }),
    async handler(args, ctx) {
      const r = await cancelPlan(String(args.planId), ctx.userId);
      if (!r.ok) throw new ToolError("CANCEL_FAILED", r.error ?? "cancel failed");
      return { ok: true };
    },
  },

  // ── Preview / export ──────────────────────────────────────────────────────
  {
    name: "bean_preview_frame", title: "Render an inspection frame", profile: "read-only",
    description: "Single-source JPEG frame at a timeline frame (topmost video clip; cached; never sent to providers).",
    inputSchema: ProjectId.extend({ frame: z.number().int().min(0).max(2_000_000), maxWidth: z.number().int().min(160).max(1280).default(640) }),
    async handler(args, ctx) {
      const p = await ownedProject(String(args.projectId), ctx.userId);
      const r = await renderPreviewFrame(p.id, ctx.userId, Math.max(0, Number(args.frame)), Math.max(160, Number(args.maxWidth ?? 640)));
      return { frame: r.frame, mediaId: r.mediaId, width: r.width, height: r.height, cached: r.cached, note: r.note, jpegBase64: r.data.toString("base64").slice(0, 4_000_000) };
    },
  },
  {
    name: "bean_export_start", title: "Start export render", profile: "editing",
    description: "Queue a full-timeline render of the current version through the NIKKI render pipeline.",
    inputSchema: ProjectId.extend({ name: z.string().max(120).optional() }),
    async handler(args, ctx) {
      const p = await ownedProject(String(args.projectId), ctx.userId);
      const head = await headSequence(p.id, ctx.userId);
      const seq = head.sequence;
      if (seq.clips.length === 0) throw new ToolError("EMPTY_TIMELINE", "Nothing to render: the sequence has no clips.");
      const { JOB_TYPE_NIKKI_RENDER } = await import("@/lib/job-helpers");
      const jobId = await jobManager.createJob(ctx.userId, JOB_TYPE_NIKKI_RENDER, { sequence: seq, projectId: p.id, name: String(args.name ?? "automation export"), sourceAssetId: null });
      return { ok: true, jobId };
    },
  },
  {
    name: "bean_export_status", title: "Job status", profile: "read-only",
    description: "Durable job status (owned by the token's user).",
    inputSchema: z.object({ jobId: z.string().min(1).max(64) }),
    async handler(args, ctx) {
      const j = await db.job.findFirst({ where: { id: String(args.jobId), userId: ctx.userId } });
      if (!j) throw new ToolError("JOB_NOT_FOUND", "Job not found or not owned.");
      return { id: j.id, type: j.type, status: j.status, progress: j.progress, stage: j.stage, message: j.message, exportId: j.exportId };
    },
  },
  {
    name: "bean_export_cancel", title: "Cancel job", profile: "editing",
    description: "Cancel an owned queued/processing job.",
    inputSchema: z.object({ jobId: z.string().min(1).max(64) }),
    async handler(args, ctx) {
      const ok = await jobManager.cancel(String(args.jobId), ctx.userId);
      if (!ok) throw new ToolError("CANCEL_FAILED", "Job cannot be cancelled (state or ownership).");
      return { ok: true };
    },
  },
];

// Local command-engine imports used by bean_edit_apply (validated pre-persistence).
import { applyCommand, parseCommand } from "@/lib/editor/commands";
import type { Sequence } from "@/lib/editor/model";
import type { Command } from "@/lib/editor/commands";

function parseCommandStrict(raw: unknown): Command {
  return parseCommand(raw);
}
function applyCommandLocal(seq: Sequence, command: Command) {
  return applyCommand(seq, command);
}

export function toolByName(name: string): ToolDef | null {
  return TOOL_CATALOG.find((t) => t.name === name) ?? null;
}

/** Profile + allowlist gate (§9B). */
export function authorizeTool(tool: ToolDef, ctx: ToolContext): { ok: boolean; error?: string } {
  if (tool.profile === "editing" && ctx.profile !== "editing") {
    return { ok: false, error: `Tool "${tool.name}" requires the editing permission profile (this token is read-only).` };
  }
  if (ctx.allowlist.length > 0 && !ctx.allowlist.includes(tool.name)) {
    return { ok: false, error: `Tool "${tool.name}" is not on this token's allowlist.` };
  }
  return { ok: true };
}

/** Run one tool with validation, auth gate and audit. */
export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<{ ok: true; result: unknown } | { ok: false; code: string; error: string }> {
  const tool = toolByName(name);
  if (!tool) return { ok: false, code: "TOOL_NOT_FOUND", error: `Unknown tool "${name}".` };
  const auth = authorizeTool(tool, ctx);
  if (!auth.ok) return { ok: false, code: "FORBIDDEN", error: auth.error ?? "forbidden" };
  const parsed = tool.inputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, code: "INVALID_ARGS", error: `Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ")}` };
  }
  const audit = (outcome: string, detail: Record<string, unknown>): void => {
    void db.automationAudit
      .create({ data: { userId: ctx.userId, projectId: (args.projectId as string) ?? null, action: `TOOL_${name}_${outcome}`, detailJson: JSON.stringify({ client: ctx.clientLabel, profile: ctx.profile, ...detail }) } })
      .catch(() => undefined);
  };
  try {
    const result = await tool.handler(parsed.data as Record<string, unknown>, ctx);
    audit("OK", {});
    return { ok: true, result };
  } catch (err) {
    if (err instanceof ToolError) {
      audit("ERR", { code: err.code });
      return { ok: false, code: err.code, error: err.message };
    }
    audit("ERR", { code: "TOOL_FAILURE" });
    return { ok: false, code: "TOOL_FAILURE", error: err instanceof Error ? err.message.slice(0, 300) : "tool failed" };
  }
}
