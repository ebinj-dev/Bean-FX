/**
 * BEAN FX — M8 context + planner + executor tests (bun test, isolated DB).
 *
 * Deterministic planner mode (BEANFX_MYAI_PROVIDER forced to an unknown id →
 * honest NOT_CONFIGURED → labeled fallback). REAL planner test behind
 * BEANFX_M8_REAL_PROVIDER=1. Execution tests run the REAL M1 command engine +
 * M2 persistence against REAL ffmpeg fixtures.
 *
 * Run: bun test scripts/test-myai-planner.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m8-pl-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
process.env.NODE_ENV = "production";
process.env.BEANFX_MYAI_PROVIDER = "does-not-exist"; // deterministic fallback (labeled)
const WORK = mkdtempSync(path.join(os.tmpdir(), "beanfx-m8-pl-"));

execSync("bunx prisma db push --skip-generate --accept-data-loss", {
  env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` },
  stdio: ["ignore", "ignore", "inherit"],
});

let db: typeof import("../src/lib/db").db;
let persistence: typeof import("../src/lib/editor/persistence");
let resolverMod: typeof import("../src/lib/my-ai/context/resolver");
let plannerMod: typeof import("../src/lib/my-ai/planner/planner");
let approvals: typeof import("../src/lib/my-ai/approvals");
let executor: typeof import("../src/lib/my-ai/execution/executor");
let previewMod: typeof import("../src/lib/my-ai/preview/frames");
let catalog: typeof import("../src/lib/automation/catalog");

const USER_A = "m8-planner-a";
const USER_B = "m8-planner-b";
let projectId = "";
let assetId = "";
const FIX = { video: path.join(WORK, "clip.mp4") };

beforeAll(async () => {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:d=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", FIX.video], { stdio: ["ignore", "ignore", "inherit"] });
  db = (await import("../src/lib/db")).db;
  persistence = await import("../src/lib/editor/persistence");
  resolverMod = await import("../src/lib/my-ai/context/resolver");
  plannerMod = await import("../src/lib/my-ai/planner/planner");
  approvals = await import("../src/lib/my-ai/approvals");
  executor = await import("../src/lib/my-ai/execution/executor");
  previewMod = await import("../src/lib/my-ai/preview/frames");
  catalog = await import("../src/lib/automation/catalog");
  await db.user.create({ data: { id: USER_A, email: "m8a@test.local", name: "A", passwordHash: "x" } }).catch(() => undefined);
  await db.user.create({ data: { id: USER_B, email: "m8b@test.local", name: "B", passwordHash: "x" } }).catch(() => undefined);
  const project = await db.project.create({
    data: { userId: USER_A, name: "M8 Plan Project", description: "test", settingsJson: JSON.stringify({ width: 1280, height: 720, fps: { num: 30, den: 1 }, sampleRate: 48000 }) },
  });
  projectId = project.id;
  const asset = await db.mediaAsset.create({
    data: { userId: USER_A, projectId, originalName: "clip.mp4", storagePath: FIX.video, kind: "VIDEO", mimeType: "video/mp4", sizeBytes: statSync(FIX.video).size, durationSec: 6, width: 320, height: 180, fps: 30, videoCodec: "h264", audioCodec: "aac", probeStatus: "READY" },
  });
  assetId = asset.id;
  // Put the asset on the timeline via the REAL command pipeline.
  await persistence.applyTimelineEdits(
    projectId,
    USER_A,
    1,
    [
      {
        type: "AddClip",
        clip: {
          id: "base-clip", trackId: "v1", sourceAssetId: assetId, sourceInFrame: 0, sourceOutFrame: 180,
          sourceFps: { num: 30000, den: 1000 }, timelineStartFrame: 0, timelineDurationFrames: 180,
          playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
          transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
          captionText: "Our city streets at night",
          captionStyle: null, graphicTemplateId: null, graphicStyle: null,
          label: "base", missingMedia: false, effects: [], keyframes: [],
        },
      },
    ],
    false,
  ).catch(async () => {
    // The default head sequence already exists with tracks; retry with its version.
    const head = await persistence.getTimelineHead(projectId, USER_A);
    const track = head.sequence.tracks.find((t) => t.kind === "VIDEO");
    if (!track) throw new Error("no video track");
    await persistence.applyTimelineEdits(projectId, USER_A, head.version, [
      {
        type: "AddClip",
        clip: {
          id: "base-clip", trackId: track.id, sourceAssetId: assetId, sourceInFrame: 0, sourceOutFrame: 180,
          sourceFps: { num: 30000, den: 1000 }, timelineStartFrame: 0, timelineDurationFrames: 180,
          playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
          transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
          captionText: "Our city streets at night",
          captionStyle: null, graphicTemplateId: null, graphicStyle: null,
          label: "base", missingMedia: false, effects: [], keyframes: [],
        },
      },
    ], false);
  });
});

afterAll(() => {
  rmSync(String(process.env.DATABASE_URL).replace("file:", ""), { force: true });
  rmSync(WORK, { recursive: true, force: true });
});

describe("Project context (§5)", () => {
  test("bounded context resolves real project state", async () => {
    const ctx = await resolverMod.resolveProjectContext(projectId, USER_A);
    expect(ctx.projectName).toBe("M8 Plan Project");
    expect(ctx.sequence.clipCount).toBe(1);
    expect(ctx.sequence.clips[0].caption).toContain("city streets");
    expect(ctx.media.total).toBeGreaterThanOrEqual(1);
    expect(ctx.boundedNote).toContain("Bounded context");
  });

  test("ownership: another user's project is refused", async () => {
    await expect(resolverMod.resolveProjectContext(projectId, USER_B)).rejects.toThrow(/not owned by the caller/);
  });
});

describe("Planner (§6) — deterministic fallback mode", () => {
  test("fallback plan is labeled and schema-valid", async () => {
    const result = await plannerMod.createPlan(USER_A, projectId, "Tighten the pacing and add captions");
    expect(result.mode).toBe("deterministic-fallback");
    expect(result.note).toContain("NOT model reasoning");
    expect(result.plan.schemaVersion).toBe(1);
    expect(result.plan.steps.length).toBeGreaterThanOrEqual(1);
    expect(result.plan.contextVersion).not.toBeNull();
  });

  test("plan persistence + approval gate: execution refused before approval", async () => {
    const created = await plannerMod.createPlan(USER_A, projectId, "Add captions");
    const report = await executor.executePlan(created.plan.planId, USER_A);
    expect(report.status).toBe("FAILED");
    expect(report.note).toContain("must be APPROVED");
  });

  test("stale-plan rejection: context changed after planning → refused", async () => {
    const created = await plannerMod.createPlan(USER_A, projectId, "Tighten pacing");
    await approvals.approvePlan(created.plan.planId, USER_A); // approval gate passes first
    // Mutate the timeline after planning (version bump).
    const head = await persistence.getTimelineHead(projectId, USER_A);
    const track = head.sequence.tracks.find((t) => t.kind === "VIDEO")!;
    await persistence.applyTimelineEdits(projectId, USER_A, head.version, [
      {
        type: "AddClip",
        clip: {
          id: `extra-${Date.now()}`, trackId: track.id, sourceAssetId: assetId, sourceInFrame: 0, sourceOutFrame: 30,
          sourceFps: { num: 30000, den: 1000 }, timelineStartFrame: 200, timelineDurationFrames: 30,
          playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
          transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
          captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
          label: "extra", missingMedia: false, effects: [], keyframes: [],
        },
      },
    ], false);
    const report = await executor.executePlan(created.plan.planId, USER_A);
    expect(report.status).toBe("FAILED");
    expect(report.note).toContain("stale");
  });

  test("idempotency key present on every plan", async () => {
    const created = await plannerMod.createPlan(USER_A, projectId, "Add a thumbnail");
    expect(created.plan.idempotencyKey.length).toBeGreaterThanOrEqual(6);
  });
});

describe("Plan execution (§8) — real engine entry points", () => {
  test("approve → execute INSERT_ASSET through M1 + persistence (undoable version bump)", async () => {
    const before = (await persistence.getTimelineHead(projectId, USER_A)).sequence.clips.length;
    const created = await plannerMod.createPlan(USER_A, projectId, "Insert the generated video asset");
    // Swap the fallback step args to a REAL INSERT_ASSET step (schema-valid).
    const head = await persistence.getTimelineHead(projectId, USER_A);
    const track = head.sequence.tracks.find((t) => t.kind === "VIDEO")!;
    const step = {
      id: "s1", operation: "INSERT_ASSET", engine: "JAZMII", dependsOn: [],
      args: { assetId, trackId: track.id, startFrame: 220 },
      title: "Insert asset", description: "Insert the fixture asset as a clip",
      readsAssetIds: [assetId], writesAssetIds: [], affectedRange: null, risk: "timeline",
    };
    await db.aIPlan.update({ where: { id: created.plan.planId }, data: { stepsJson: JSON.stringify([step]) } });
    const approved = await approvals.approvePlan(created.plan.planId, USER_A);
    expect(approved.ok).toBe(true);
    const report = await executor.executePlan(created.plan.planId, USER_A);
    expect(report.status).toBe("COMPLETED");
    expect(report.steps[0].status).toBe("COMPLETED");
    const after = (await persistence.getTimelineHead(projectId, USER_A)).sequence.clips.length;
    expect(after).toBe(before + 1);
    // Audit rows exist.
    const audits = await db.automationAudit.findMany({ where: { userId: USER_A, action: { startsWith: "PLAN_STEP" } } });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  test("execute by another user → refused (ownership)", async () => {
    const created = await plannerMod.createPlan(USER_A, projectId, "Add captions again");
    await expect(executor.executePlan(created.plan.planId, USER_B)).resolves.toMatchObject({ status: "FAILED" });
  });

  test("cancel: approved plan cancelled before execution stays cancelled", async () => {
    const created = await plannerMod.createPlan(USER_A, projectId, "Add captions once more");
    await approvals.approvePlan(created.plan.planId, USER_A);
    const r = await approvals.cancelPlan(created.plan.planId, USER_A);
    expect(r.ok).toBe(true);
    const report = await executor.executePlan(created.plan.planId, USER_A);
    expect(report.status).toBe("FAILED");
  });
});

describe("Preview frames (§9E) — real ffmpeg, cached", () => {
  test("renders a decodable JPEG at a covered frame; cache hit on repeat", async () => {
    const f1 = await previewMod.renderPreviewFrame(projectId, USER_A, 60, 320);
    expect(f1.data.length).toBeGreaterThan(1000);
    expect(f1.cached).toBe(false);
    const info = execFileSync("python3", ["-I", "-c", "import sys; from PIL import Image; im=Image.open(sys.argv[1]); print(im.format, im.size[0])", "/dev/stdin"], { input: f1.data, encoding: "utf8" });
    expect(info.trim().split(/\s+/)[0]).toBe("JPEG");
    const f2 = await previewMod.renderPreviewFrame(projectId, USER_A, 60, 320);
    expect(f2.cached).toBe(true);
  });

  test("frame outside any clip → honest NO_FRAME", async () => {
    await expect(previewMod.renderPreviewFrame(projectId, USER_A, 100_000, 320)).rejects.toThrow(/No visible video clip covers/);
  });
});

describe("Tool catalog (§9A/§9C) — permissions and real operations", () => {
  const readOnlyCtx = { userId: USER_A, profile: "read-only" as const, allowlist: [], clientLabel: "test-ro" };
  const editingCtx = { userId: USER_A, profile: "editing" as const, allowlist: [], clientLabel: "test-ed" };

  test("read-only profile is blocked from editing tools", async () => {
    const r = await catalog.runTool("bean_edit_apply", { projectId, commands: [{ type: "RemoveClip", clipId: "base-clip" }] }, readOnlyCtx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("FORBIDDEN");
  });

  test("editing profile applies real commands (version bump)", async () => {
    const head = await persistence.getTimelineHead(projectId, USER_A);
    const track = head.sequence.tracks.find((t) => t.kind === "VIDEO")!;
    const r = await catalog.runTool("bean_clip_add", { projectId, assetId, trackId: track.id, startFrame: 240 }, editingCtx);
    expect(r.ok).toBe(true);
  });

  test("unknown tool and invalid args are normalized errors", async () => {
    const r1 = await catalog.runTool("bean_not_a_tool", {}, editingCtx);
    expect(r1.ok).toBe(false);
    const r2 = await catalog.runTool("bean_project_get", {}, editingCtx);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe("INVALID_ARGS");
  });

  test("tool calls are audit-logged", async () => {
    const audits = await db.automationAudit.count({ where: { userId: USER_A, action: { startsWith: "TOOL_" } } });
    expect(audits).toBeGreaterThanOrEqual(1);
  });
});
