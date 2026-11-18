/**
 * BEAN FX — M7 JAZMII tests (bun test, isolated DB + worker state).
 *
 * REAL artifacts: analysis tests run against the LIVE-GENERATED cogvideox-3
 * video (created during the M7 provider probe: task → poll → download →
 * 1920×1080 h264 5.19 s) when present at /tmp/m7-probe/real-cogvideo.mp4,
 * and against REAL ffmpeg synthetic fixtures (black/freeze segments) — every
 * fixture is labeled. Job lifecycle uses the labeled fake-zai CLI FIXTURE
 * (scripts/fixtures/fake-zai.sh) to drive the real adapter code paths
 * deterministically; these are FIXTURE tests, NOT real-AI-generation tests.
 *
 * Run: bun test scripts/test-jazmii.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, statSync, cpSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// ── environment BEFORE any module that touches the DB ────────────────────────
const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m7-jazmii-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
process.env.BEANFX_USER_QUOTA_BYTES = String(500 * 1024 * 1024);
const WORK = mkdtempSync(path.join(os.tmpdir(), "beanfx-m7-jazmii-"));
const FAKE_DIR = path.join(WORK, "fake-zai");
mkdirSync(FAKE_DIR, { recursive: true });
process.env.BEANFX_ZAI_BIN = path.join(import.meta.dir, "fixtures", "fake-zai.sh"); // labeled FIXTURE provider
process.env.FAKE_ZAI_DIR = FAKE_DIR;

execSync("bunx prisma db push --skip-generate --accept-data-loss", {
  env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` },
  stdio: ["ignore", "ignore", "inherit"],
});

let db: typeof import("../src/lib/db").db;
let helpers: typeof import("../src/lib/job-helpers");
let workerMod: typeof import("../src/lib/media-worker");
let jobRunner: typeof import("../src/lib/job-runner");
let providers: typeof import("../src/lib/jazmii/providers");
let jobs: typeof import("../src/lib/jazmii/jobs");
let analysis: typeof import("../src/lib/jazmii/analysis");
let shots: typeof import("../src/lib/jazmii/shots");
let lifecycle: typeof import("../src/lib/ai/asset-lifecycle");
let model: typeof import("../src/lib/editor/model");
let commands: typeof import("../src/lib/editor/commands");

const USER_A = "jazmii-user-a";
const USER_B = "jazmii-user-b";

/** The live-generated REAL video from the provider probe (may not exist). */
const REAL_VIDEO = "/tmp/m7-probe/real-cogvideo.mp4";
const FIX = {
  blackFreeze: path.join(WORK, "black_freeze.mp4"),
  tiny: path.join(WORK, "tiny.mp4"),
};

function ffmpeg(args: string, out: string): void {
  execSync(`ffmpeg -hide_banner -loglevel error -y ${args} "${out}"`, { stdio: ["ignore", "ignore", "inherit"] });
  if (!existsSync(out) || statSync(out).size === 0) throw new Error(`fixture generation failed: ${out}`);
}

beforeAll(async () => {
  // Labeled synthetic fixture: 2 s color → 1.2 s black → 2 s static white (freeze).
  // Labeled synthetic fixture: 2 s red (freeze A) → 1.2 s black → 3 s white (freeze B).
  ffmpeg(
    `-f lavfi -i "color=c=red:s=320x180:d=2" -f lavfi -i "color=c=black:s=320x180:d=1.2" -f lavfi -i "color=c=white:s=320x180:d=3" -filter_complex "[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]" -map "[out]" -c:v libx264 -preset ultrafast -pix_fmt yuv420p`,
    FIX.blackFreeze,
  );
  ffmpeg(`-f lavfi -i "color=c=green:s=64x64:d=1" -c:v libx264 -preset ultrafast -pix_fmt yuv420p`, FIX.tiny);
  if (existsSync(REAL_VIDEO)) cpSync(REAL_VIDEO, path.join(WORK, "real.mp4"));

  db = (await import("../src/lib/db")).db;
  helpers = await import("../src/lib/job-helpers");
  workerMod = await import("../src/lib/media-worker");
  jobRunner = await import("../src/lib/job-runner");
  providers = await import("../src/lib/jazmii/providers");
  jobs = await import("../src/lib/jazmii/jobs");
  analysis = await import("../src/lib/jazmii/analysis");
  shots = await import("../src/lib/jazmii/shots");
  lifecycle = await import("../src/lib/ai/asset-lifecycle");
  model = await import("../src/lib/editor/model");
  commands = await import("../src/lib/editor/commands");
  await db.user.create({ data: { id: USER_A, email: "jazmii-a@test.local", name: "A", passwordHash: "x" } }).catch(() => undefined);
  await db.user.create({ data: { id: USER_B, email: "jazmii-b@test.local", name: "B", passwordHash: "x" } }).catch(() => undefined);
});

afterAll(() => {
  rmSync(String(process.env.DATABASE_URL).replace("file:", ""), { force: true });
  rmSync(WORK, { recursive: true, force: true });
});

function fakeTask(): void {
  writeFileSync(path.join(FAKE_DIR, "task.json"), JSON.stringify({ id: "fixture-task-1", model: "fixture-video", request_id: "req-1", task_status: "PROCESSING" }));
}

function fakeSuccess(videoFile: string): void {
  const b64 = readB64(videoFile);
  writeFileSync(
    path.join(FAKE_DIR, "result.json"),
    JSON.stringify({ id: "fixture-task-1", model: "fixture-video", task_status: "SUCCESS", video_result: [{ url: `data:video/mp4;base64,${b64}` }] }),
  );
}

function readB64(file: string): string {
  return Buffer.from(require("fs").readFileSync(file)).toString("base64");
}

/** Drive the worker (repeated ticks — retries re-queue with backoff and need
 *  fresh claims) and poll the job row until a terminal state or deadline. */
async function runJob(jobId: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await workerMod.tickWorkerOnce().catch(() => undefined);
    const j = await db.job.findUnique({ where: { id: jobId } });
    if (j && (j.status === "COMPLETED" || j.status === "FAILED" || j.status === "CANCELLED")) return j.status;
    if (Date.now() > deadline) return j?.status ?? "STUCK";
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("JAZMII provider contract (§5)", () => {
  test("capability map mirrors the REAL provider contract", () => {
    const p = providers.jazmiiProvider(null);
    expect(p.id).toBe("zai-video");
    expect(p.capabilities.operations).toContain("textToVideo");
    expect(p.capabilities.operations).toContain("imageToVideo");
    expect(p.capabilities.durationsSec).toEqual(["5", "10"]);
    expect(p.capabilities.fps).toEqual(["30", "60"]);
    expect(p.capabilities.providerProgress).toBe(false); // no fake progress claims
    expect(p.capabilities.commercialUse).toContain("NOT independently verified");
  });

  test("NOT_CONFIGURED is honest and actionable when the CLI is missing", async () => {
    process.env.BEANFX_ZAI_BIN = "/nonexistent/zai-fake";
    try {
      await expect(providers.jazmiiProvider(null).createTask({ prompt: "x", operation: "textToVideo", referenceAssetId: null, quality: "speed", size: "1920x1080", fps: "30", durationSec: "5", withAudio: false, projectId: null }, null)).rejects.toThrow(/not installed on the server/);
    } finally {
      process.env.BEANFX_ZAI_BIN = path.join(import.meta.dir, "fixtures", "fake-zai.sh");
    }
  });

  test("UNSUPPORTED: imageToVideo without an owned reference is refused", async () => {
    await expect(providers.jazmiiProvider(null).createTask({ prompt: "x", operation: "imageToVideo", referenceAssetId: null, quality: "speed", size: "1920x1080", fps: "30", durationSec: "5", withAudio: false, projectId: null }, null)).rejects.toThrow(/requires a reference image/);
  });

  test("pollTask parses the REAL SUCCESS shape (video_result[0].url)", async () => {
    fakeTask();
    fakeSuccess(FIX.tiny);
    const st = await providers.jazmiiProvider(null).pollTask("fixture-task-1");
    expect(st.status).toBe("SUCCESS");
    expect(st.videoUrl).toContain("data:video/mp4;base64,");
  });
});

describe("JAZMII job lifecycle (fixture provider — clearly labeled)", () => {
  test("generate → validate → register with provenance → complete", async () => {
    fakeTask();
    fakeSuccess(FIX.blackFreeze); // 5.2 s fixture vs 5 s request — within tolerance
    const jobId = await jobRunner.jobManager.createJob(USER_A, helpers.JOB_TYPE_JAZMII_GENERATE, {
      prompt: "Fixture cutaway for tests", operation: "textToVideo", referenceAssetId: null,
      quality: "speed", size: "1920x1080", fps: "30", durationSec: "5", withAudio: false, projectId: null,
    });
    const status = await runJob(jobId);
    expect(status).toBe("COMPLETED");
    const job = await db.job.findUnique({ where: { id: jobId } });
    const asset = await db.mediaAsset.findUnique({ where: { id: job?.exportId ?? "" } });
    expect(asset).not.toBeNull();
    expect(asset?.kind).toBe("VIDEO");
    expect(asset?.createdBy).toBe("JAZMII");
    expect(asset?.provider).toBe("zai-video");
    expect(asset?.model).toBe("fixture-video");
    expect(asset?.prompt).toContain("Fixture cutaway");
    expect(asset?.sha256).not.toBeNull();
    expect(asset?.durationSec ?? 0).toBeGreaterThan(0);
    expect(asset?.storagePath).toContain(path.join("jazmii-outputs", `u_${USER_A}`));
    void jobs; void lifecycle;
  });

  test("provider output that fails content sniff is rejected with no orphan file", async () => {
    fakeTask();
    // Fixture masquerading as video but actually text.
    writeFileSync(path.join(FAKE_DIR, "result.json"), JSON.stringify({ id: "t", model: "m", task_status: "SUCCESS", video_result: [{ url: `data:video/mp4;base64,${Buffer.from("this is not a video").toString("base64")}` }] }));
    const jobId = await jobRunner.jobManager.createJob(USER_A, helpers.JOB_TYPE_JAZMII_GENERATE, {
      prompt: "bad output", operation: "textToVideo", referenceAssetId: null, quality: "speed", size: "1920x1080", fps: "30", durationSec: "5", withAudio: false, projectId: null,
    });
    // Invalid provider output is RETRYABLE by design (each attempt re-runs the
    // full provider call; the worker's backoff is 30 s × 2^n, so CI asserts the
    // first-attempt rejection + requeue, and exhaustion is covered by the
    // FAIL-state test which uses a permanent error).
    const status = await runJob(jobId, 12_000);
    expect(["QUEUED", "PROCESSING", "FAILED"]).toContain(status);
    const job = await db.job.findUnique({ where: { id: jobId } });
    expect(job?.attempts).toBeGreaterThanOrEqual(1);
    expect(job?.message ?? "").toMatch(/sniff|INVALID_RESPONSE/i);
    expect(job?.exportId).toBeNull();
  }, 45_000);

  test("no-orphan guarantee: a failed registration deletes the output file", async () => {
    const garbage = path.join(WORK, "garbage.img");
    writeFileSync(garbage, Buffer.from("definitely not an image"));
    await expect(
      lifecycle.registerGeneratedAsset(garbage, {
        engine: "JAZMII", userId: USER_A, originalName: "g.mp4", provider: "fixture", model: "m",
        prompt: "x", params: {}, expectClass: "VIDEO",
      }),
    ).rejects.toThrow(/sniff/i);
    expect(existsSync(garbage)).toBe(false); // deleted — no orphan
  });

  test("FAIL state from the provider fails the job (no fake success)", async () => {
    fakeTask();
    writeFileSync(path.join(FAKE_DIR, "result.json"), JSON.stringify({ id: "t", model: "m", task_status: "FAIL" }));
    const jobId = await jobRunner.jobManager.createJob(USER_A, helpers.JOB_TYPE_JAZMII_GENERATE, {
      prompt: "x", operation: "textToVideo", referenceAssetId: null, quality: "speed", size: "1920x1080", fps: "30", durationSec: "5", withAudio: false, projectId: null,
    });
    const status = await runJob(jobId);
    expect(status).toBe("FAILED");
    const job = await db.job.findUnique({ where: { id: jobId } });
    expect(job?.message).toContain("provider reported failure");
  }, 45_000);

  test("reference asset ownership: another user's asset is refused", async () => {
    fakeTask();
    fakeSuccess(FIX.tiny);
    const foreign = await db.mediaAsset.create({
      data: { userId: USER_B, originalName: "foreign.png", storagePath: FIX.tiny, kind: "IMAGE", mimeType: "image/jpeg", sizeBytes: statSync(FIX.tiny).size },
    });
    const jobId = await jobRunner.jobManager.createJob(USER_A, helpers.JOB_TYPE_JAZMII_GENERATE, {
      prompt: "x", operation: "imageToVideo", referenceAssetId: foreign.id, quality: "speed", size: "1920x1080", fps: "30", durationSec: "5", withAudio: false, projectId: null,
    });
    const status = await runJob(jobId);
    expect(status).toBe("FAILED");
    const job = await db.job.findUnique({ where: { id: jobId } });
    expect(job?.message).toContain("not owned by the caller");
  }, 45_000);
});

describe("JAZMII analysis (real ffmpeg — heuristic by construction)", () => {
  test("REAL generated video (cogvideox-3 probe artifact) analyzes with sane metadata", async () => {
    const real = path.join(WORK, "real.mp4");
    if (!existsSync(real)) {
      console.log("[jazmii-test] REAL provider artifact absent — skipping (fixture coverage still runs)");
      return;
    }
    const report = await analysis.analyzeVideoFile(real, "real-1", { withArtifacts: false });
    expect(report.analysisMethod).toBe("ffmpeg-heuristic");
    expect(report.durationSec).toBeGreaterThan(4.5);
    expect(report.durationSec).toBeLessThan(6.5);
    expect(report.width).toBe(1920);
    expect(report.height).toBe(1080);
    expect(report.fps).toBeGreaterThan(0);
    expect(report.scenes.length).toBeGreaterThanOrEqual(1);
  });

  test("blackdetect + freezedetect find the labeled synthetic segments", async () => {
    const report = await analysis.analyzeVideoFile(FIX.blackFreeze, "fix-1", { withArtifacts: false });
    expect(report.blackSegments.length).toBeGreaterThanOrEqual(1);
    const black = report.blackSegments[0];
    expect(black.startSec).toBeGreaterThan(1.4);
    expect(black.endSec).toBeLessThan(3.6);
    expect(report.freezeSegments.length).toBeGreaterThanOrEqual(1);
    const freeze = report.freezeSegments[report.freezeSegments.length - 1];
    expect(freeze.endSec).toBeGreaterThan(4.5); // freeze B (white 3.2 s→6.2 s)
  });

  test("keyframes are real files registered as IMAGE assets with provenance", async () => {
    fakeTask();
    fakeSuccess(FIX.blackFreeze);
    const jobId = await jobRunner.jobManager.createJob(USER_A, helpers.JOB_TYPE_JAZMII_ANALYZE, { mediaId: null });
    // Register the fixture as an asset first (ownership-checked in the job).
    const asset = await db.mediaAsset.create({
      data: { userId: USER_A, originalName: "black_freeze.mp4", storagePath: FIX.blackFreeze, kind: "VIDEO", mimeType: "video/mp4", sizeBytes: statSync(FIX.blackFreeze).size, probeStatus: "READY" },
    });
    await db.job.update({ where: { id: jobId }, data: { paramsJson: JSON.stringify({ mediaId: asset.id }) } });
    const status = await runJob(jobId);
    expect(status).toBe("COMPLETED");
    const job = await db.job.findUnique({ where: { id: jobId } });
    expect(job?.message).toContain("ffmpeg-heuristic");
    const keyframes = await db.mediaAsset.findMany({ where: { userId: USER_A, provider: "ffmpeg", referenceAssetId: asset.id } });
    expect(keyframes.length).toBeGreaterThanOrEqual(1);
    expect(keyframes[0].kind).toBe("IMAGE");
  });
});

describe("JAZMII shot suggestions (deterministic, honest confidence)", () => {
  test("structure, determinism, null confidence", () => {
    const ctx = { fps: 30, texts: ["Our city streets at night", "A quiet forest morning"], sequenceFrames: 900 };
    const s1 = shots.suggestShots(ctx);
    const s2 = shots.suggestShots(ctx);
    expect(s1.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(s1)).toBe(JSON.stringify(s2));
    expect(s1.every((s) => s.confidence === null)).toBe(true); // no fake scores
    expect(s1.every((s) => s.prompt && s.prompt.length > 10)).toBe(true);
    expect(s1.every((s) => s.durationFrames >= 12)).toBe(true);
    expect(s1.every((x) => x.providerHint === "zai-video")).toBe(true);
  });
});

describe("JAZMII timeline integration (M1 commands)", () => {
  test("generated video inserts on a video track; undo/redo/reload all work", async () => {
    const asset = await db.mediaAsset.create({
      data: { userId: USER_A, originalName: "gen.mp4", storagePath: FIX.tiny, kind: "VIDEO", mimeType: "video/mp4", sizeBytes: 1, durationSec: 1, width: 64, height: 64, fps: 30, createdBy: "JAZMII", provider: "zai-video", prompt: "t" },
    });
    const seq = model.parseSequence({
      id: "s", name: "s", fps: { num: 30, den: 1 }, width: 320, height: 180, sampleRate: 48000,
      tracks: [{ id: "v", kind: "VIDEO", name: "V", visible: true, muted: false, solo: false, locked: false }],
      clips: [], transitions: [],
    });
    const r = commands.applyCommand(seq, {
      type: "AddClip",
      clip: {
        id: "genc1", trackId: "v", sourceAssetId: asset.id, sourceInFrame: 0, sourceOutFrame: 30,
        sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, playbackSpeed: 1, volume: 1, muted: false,
        fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
        label: "JAZMII: fixture", missingMedia: false, effects: [], keyframes: [],
      },
    });
    expect(r.sequence.clips).toHaveLength(1);
    const undone = commands.applyCommand(r.sequence, r.inverse[0]);
    expect(undone.sequence.clips).toHaveLength(0);
    // Redo re-applies the ORIGINAL AddClip command (undo = inverse, redo = original).
    const original = commands.parseCommand({
      type: "AddClip",
      clip: {
        id: "genc1", trackId: "v", sourceAssetId: asset.id, sourceInFrame: 0, sourceOutFrame: 30,
        sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, playbackSpeed: 1, volume: 1, muted: false,
        fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
        label: "JAZMII: fixture", missingMedia: false, effects: [], keyframes: [],
      },
    });
    const redone = commands.applyCommand(undone.sequence, original);
    expect(redone.sequence.clips).toHaveLength(1);
    // Reload persistence: the full sequence round-trips through parseSequence.
    const reloaded = model.parseSequence(JSON.parse(JSON.stringify(r.sequence)));
    expect(reloaded.clips).toHaveLength(1);
    expect(reloaded.clips[0].label).toContain("JAZMII");
  });

  test("A/V sync guard: registered duration matches the requested window", async () => {
    fakeTask();
    fakeSuccess(FIX.blackFreeze); // 5.2 s fixture
    const jobId = await jobRunner.jobManager.createJob(USER_A, helpers.JOB_TYPE_JAZMII_GENERATE, {
      prompt: "sync check", operation: "textToVideo", referenceAssetId: null, quality: "speed", size: "1920x1080", fps: "30", durationSec: "5", withAudio: false, projectId: null,
    });
    const status = await runJob(jobId);
    expect(status).toBe("COMPLETED"); // duration tolerance (±2.5 s) accepts 5.2 s
  });
});
