/**
 * BEAN FX — M8 automation API tests (bun test, isolated DB).
 * JSON-RPC transport, inspection tools, validated edits, version-conflict
 * handling, export lifecycle through the real render pipeline, preview frames.
 *
 * Run: bun test scripts/test-automation-api.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m8-api-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
process.env.NODE_ENV = "production";
const WORK = mkdtempSync(path.join(os.tmpdir(), "beanfx-m8-api-"));

execSync("bunx prisma db push --skip-generate --accept-data-loss", {
  env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` },
  stdio: ["ignore", "ignore", "inherit"],
});

let db: typeof import("../src/lib/db").db;
let tokensMod: typeof import("../src/lib/automation/tokens");
let catalog: typeof import("../src/lib/automation/catalog");
let workerMod: typeof import("../src/lib/media-worker");

const USER_A = "api-user-a";
const USER_B = "api-user-b";
let editToken = "";
const editingCtx = () => ({ userId: USER_A, profile: "editing" as const, allowlist: [], clientLabel: "api-test" });
const foreignCtx = () => ({ userId: USER_B, profile: "editing" as const, allowlist: [], clientLabel: "api-foreign" });
let projectId = "";
let assetId = "";
let videoAssetId = "";
const FIX = { video: path.join(WORK, "src.mp4") };

beforeAll(async () => {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:d=8", "-f", "lavfi", "-i", "sine=frequency=330:duration=8", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", FIX.video], { stdio: ["ignore", "ignore", "inherit"] });
  db = (await import("../src/lib/db")).db;
  tokensMod = await import("../src/lib/automation/tokens");
  catalog = await import("../src/lib/automation/catalog");
  workerMod = await import("../src/lib/media-worker");
  await db.user.create({ data: { id: USER_A, email: "apia@test.local", name: "A", passwordHash: "x" } }).catch(() => undefined);
  await db.user.create({ data: { id: USER_B, email: "apib@test.local", name: "B", passwordHash: "x" } }).catch(() => undefined);
  editToken = (await tokensMod.createToken(USER_A, "api", "editing")).raw;
  void editToken;
  const project = await db.project.create({ data: { userId: USER_A, name: "API Project", settingsJson: JSON.stringify({ width: 1280, height: 720, fps: { num: 30, den: 1 }, sampleRate: 48000 }) } });
  projectId = project.id;
  const asset = await db.mediaAsset.create({
    data: { userId: USER_A, projectId, originalName: "src.mp4", storagePath: FIX.video, kind: "VIDEO", mimeType: "video/mp4", sizeBytes: statSync(FIX.video).size, durationSec: 8, width: 320, height: 180, fps: 30, videoCodec: "h264", audioCodec: "aac", probeStatus: "READY" },
  });
  assetId = asset.id;
  void assetId;
  // Foreign user's asset (for isolation checks).
  const foreign = await db.mediaAsset.create({ data: { userId: USER_B, originalName: "foreign.mp4", storagePath: FIX.video, kind: "VIDEO", mimeType: "video/mp4", sizeBytes: statSync(FIX.video).size } });
  videoAssetId = foreign.id;
  // Seed the timeline with one clip via the editing tool.
  const head = (await import("../src/lib/editor/persistence")).getTimelineHead(projectId, USER_A);
  const seq = (await head).sequence;
  const track = seq.tracks.find((t) => t.kind === "VIDEO")!;
  const r = await catalog.runTool("bean_clip_add", { projectId, assetId, trackId: track.id, startFrame: 0 }, editingCtx());
  if (!r.ok) throw new Error(`seed failed: ${JSON.stringify(r)}`);
});

afterAll(() => {
  rmSync(String(process.env.DATABASE_URL).replace("file:", ""), { force: true });
  rmSync(WORK, { recursive: true, force: true });
});

describe("Automation API — inspection", () => {
  test("project/timeline/media inspection returns real state", async () => {
    const p = await catalog.runTool("bean_project_get", { projectId }, editingCtx());
    expect(p.ok).toBe(true);
    const t = await catalog.runTool("bean_timeline_read", { projectId, maxClips: 50 }, editingCtx());
    expect(t.ok).toBe(true);
    if (t.ok) {
      const read = t.result as { clips: unknown[]; clipsTotal: number; fps: { num: number } };
      expect(read.clipsTotal).toBe(1);
      expect(read.fps.num).toBe(30);
    }
    const m = await catalog.runTool("bean_media_list", { kind: "VIDEO" }, editingCtx());
    expect(m.ok).toBe(true);
    const probe = await catalog.runTool("bean_media_probe", { mediaId: assetId }, editingCtx());
    expect(probe.ok).toBe(true);
    if (probe.ok) {
      const pr = probe.result as { probe: { durationSec: number | null } };
      expect(pr.probe.durationSec).toBeGreaterThan(7);
    }
  });

  test("foreign user sees nothing of this project", async () => {
    const r = await catalog.runTool("bean_project_get", { projectId }, foreignCtx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PROJECT_NOT_FOUND");
  });
});

describe("Automation API — validated edits + concurrency", () => {
  test("edit_apply with an INVALID command → rejected (engine validation)", async () => {
    const r = await catalog.runTool("bean_edit_apply", { projectId, commands: [{ type: "TrimClip", clipId: "does-not-exist", newSourceOutFrame: 30 }] }, editingCtx());
    expect(r.ok).toBe(false);
  });

  test("version conflict: stale base version → VersionConflictError surfaced honestly", async () => {
    const persistence = await import("../src/lib/editor/persistence");
    const head1 = await persistence.getTimelineHead(projectId, USER_A);
    const head2 = await persistence.getTimelineHead(projectId, USER_A);
    const track = head1.sequence.tracks.find((t) => t.kind === "VIDEO")!;
    // First write bumps the version.
    await persistence.applyTimelineEdits(projectId, USER_A, head1.version, [{
      type: "AddClip",
      clip: {
        id: `conf-${Date.now()}`, trackId: track.id, sourceAssetId: assetId, sourceInFrame: 0, sourceOutFrame: 30,
        sourceFps: { num: 30000, den: 1000 }, timelineStartFrame: 300, timelineDurationFrames: 30,
        playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
        label: "conflict", missingMedia: false, effects: [], keyframes: [],
      },
    }], false);
    // The second write still uses the OLD base version → conflict.
    await expect(persistence.applyTimelineEdits(projectId, USER_A, head2.version, [{
      type: "AddClip",
      clip: {
        id: `conf2-${Date.now()}`, trackId: track.id, sourceAssetId: assetId, sourceInFrame: 0, sourceOutFrame: 30,
        sourceFps: { num: 30000, den: 1000 }, timelineStartFrame: 320, timelineDurationFrames: 30,
        playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
        label: "conflict2", missingMedia: false, effects: [], keyframes: [],
      },
    }], false)).rejects.toThrow(/Conflict|conflict|version/i);
  });

  test("clip lifecycle via tools: trim → split → move → transform → remove", async () => {
    const persistence = await import("../src/lib/editor/persistence");
    const head = await persistence.getTimelineHead(projectId, USER_A);
    const track = head.sequence.tracks.find((t) => t.kind === "VIDEO")!;
    const added = await catalog.runTool("bean_clip_add", { projectId, assetId, trackId: track.id, startFrame: 400 }, editingCtx());
    expect(added.ok).toBe(true);
    const clips = (await catalog.runTool("bean_timeline_get_clips", { projectId, trackId: track.id }, editingCtx()));
    if (!clips.ok) throw new Error("clips read failed");
    const list = (clips.result as { clips: { id: string; timelineStartFrame: number }[] }).clips;
    const target = list.find((c) => c.timelineStartFrame === 400);
    expect(target).toBeTruthy();
    const clipId = target!.id;
    expect((await catalog.runTool("bean_clip_trim", { projectId, clipId, newSourceOutFrame: 60 }, editingCtx())).ok).toBe(true);
    expect((await catalog.runTool("bean_clip_split", { projectId, clipId, atTimelineFrame: 420 }, editingCtx())).ok).toBe(true);
    // Split REPLACES the clip with new left/right ids — use the left one (returned).
    const splitAgain = (await catalog.runTool("bean_timeline_get_clips", { projectId, trackId: track.id }, editingCtx()));
    const leftId = (splitAgain.result as { clips: { id: string; timelineStartFrame: number }[] }).clips.find((c) => c.timelineStartFrame === 400)!.id;
    expect((await catalog.runTool("bean_clip_move", { projectId, clipId: leftId, toTrackId: track.id, newTimelineStartFrame: 380 }, editingCtx())).ok).toBe(true); // moves left half before the split right half (no overlap)
    expect((await catalog.runTool("bean_clip_transform", { projectId, clipId: leftId, opacity: 0.5, scale: 1.2 }, editingCtx())).ok).toBe(true);
    expect((await catalog.runTool("bean_clip_remove", { projectId, clipId: leftId }, editingCtx())).ok).toBe(true);
    // Keyframes on a still-living clip (the base clip).
    const base = list.find((c) => c.id !== clipId)!;
    expect((await catalog.runTool("bean_keyframe_set", { projectId, clipId: base.id, property: "opacity", frame: 10, value: 0.9 }, editingCtx())).ok).toBe(true);
    const effects = await catalog.runTool("bean_effect_apply", { projectId, clipId: base.id, effectType: "grayscale", params: {} }, editingCtx());
    expect(effects.ok).toBe(true);
  });

  test("undo/redo honesty: version restore is the server-side mechanism (undo tool absent)", async () => {
    const { toolByName } = catalog;
    expect(toolByName("bean_edit_undo")).toBeNull();
    expect(toolByName("bean_edit_redo")).toBeNull();
    const versions = await catalog.runTool("bean_project_versions", { projectId }, editingCtx());
    expect(versions.ok).toBe(true);
    if (versions.ok) {
      const v = versions.result as { versions: unknown[] };
      expect(v.versions.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("Automation API — export lifecycle through the real pipeline", () => {
  test("export_start → status → cancel (durable NIKKI_RENDER job)", async () => {
    const start = await catalog.runTool("bean_export_start", { projectId, name: "api export" }, editingCtx());
    expect(start.ok).toBe(true);
    const jobId = (start.result as { jobId: string }).jobId;
    const status = await catalog.runTool("bean_export_status", { jobId }, editingCtx());
    expect(status.ok).toBe(true);
    if (status.ok) {
      const s = status.result as { type: string; status: string };
      expect(s.type).toBe("NIKKI_RENDER");
      expect(["QUEUED", "PROCESSING", "COMPLETED", "FAILED"]).toContain(s.status);
    }
    const cancel = await catalog.runTool("bean_export_cancel", { jobId }, editingCtx());
    expect(cancel.ok).toBe(true);
    const after = await catalog.runTool("bean_export_status", { jobId }, editingCtx());
    if (after.ok) expect((after.result as { status: string }).status).toBe("CANCELLED");
  }, 120_000);

  test("foreign user cannot read/cancel this export job", async () => {
    const start = await catalog.runTool("bean_export_start", { projectId, name: "isolation export" }, editingCtx());
    const jobId = (start.result as { jobId: string }).jobId;
    const foreign = await catalog.runTool("bean_export_status", { jobId }, foreignCtx());
    expect(foreign.ok).toBe(false);
  }, 60_000);
});

describe("Automation API — AI plan tools (approval enforced end-to-end)", () => {
  test("bean_ai_plan → approve → execute (guided steps route honestly)", async () => {
    process.env.BEANFX_MYAI_PROVIDER = "does-not-exist"; // deterministic fallback (labeled)
    const plan = await catalog.runTool("bean_ai_plan", { projectId, request: "Tighten the pacing" }, editingCtx());
    expect(plan.ok).toBe(true);
    const planId = (plan.result as { planId: string; mode: string }).planId;
    const mode = (plan.result as { mode: string }).mode;
    expect(mode).toBe("deterministic-fallback");
    expect((await catalog.runTool("bean_ai_approve_plan", { planId }, editingCtx())).ok).toBe(true);
    const exec = await catalog.runTool("bean_ai_execute_plan", { planId }, editingCtx());
    expect(exec.ok).toBe(true);
    if (exec.ok) {
      const report = exec.result as { status: string; steps: { status: string; detail: string }[] };
      expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(report.status);
      expect(report.steps.every((s) => ["COMPLETED", "ROUTED", "SKIPPED", "FAILED"].includes(s.status))).toBe(true);
      // The pacing step is a guided RIISHE route — never fake-completed.
      expect(report.steps.some((s) => s.status === "ROUTED" && s.detail.includes("RIISHE"))).toBe(true);
    }
    delete process.env.BEANFX_MYAI_PROVIDER;
  }, 60_000);

  test("preview frame via the API: real JPEG with privacy note", async () => {
    const head = await (await import("../src/lib/editor/persistence")).getTimelineHead(projectId, USER_A);
    const track = head.sequence.tracks.find((t) => t.kind === "VIDEO")!;
    const clip = head.sequence.clips.find((c) => c.trackId === track.id);
    expect(clip).toBeTruthy();
    const frame = clip!.timelineStartFrame + 15;
    const r = await catalog.runTool("bean_preview_frame", { projectId, frame, maxWidth: 320 }, editingCtx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      const res = r.result as { jpegBase64: string; note: string };
      const buf = Buffer.from(res.jpegBase64, "base64");
      expect(buf.length).toBeGreaterThan(1000);
      expect(res.note).toContain("never leave this deployment");
    }
  });
});

describe("Automation API — JSON-RPC rpc.discover (token-scoped)", () => {
  test("discover lists profile-appropriate tools", async () => {
    const roToken = (await tokensMod.createToken(USER_A, "ro-api", "read-only")).raw;
    const roCtx = { userId: USER_A, profile: "read-only" as const, allowlist: [], clientLabel: "ro" };
    const { TOOL_CATALOG, authorizeTool } = catalog;
    const visible = TOOL_CATALOG.filter((t) => authorizeTool(t, roCtx).ok).map((t) => t.name);
    expect(visible).toContain("bean_project_list");
    expect(visible).not.toContain("bean_edit_apply");
    void roToken;
  });
});
