/**
 * BEAN FX — Milestone 3 reliability tests (bun test).
 *
 * Exercises the media pipeline at library level with a scratch SQLite DB and
 * REAL ffmpeg-generated media: signature sniffing, checksums, quotas, deep
 * ffprobe, proxy generation + alignment, worker claim/retry/cancel/recovery,
 * idempotency, dedup refcounts and scratch sweeps.
 *
 * The worker's auto-ticker is disabled (BEANFX_MEDIA_WORKER_AUTOSTART=0) so
 * every queue transition is driven deterministically via tickWorkerOnce().
 *
 * Run: bun test scripts/test-media-pipeline.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdir as fs_mkdir } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, existsSync, statSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// ── environment BEFORE any module that touches the DB ────────────────────────
const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m3-test-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
process.env.BEANFX_USER_QUOTA_BYTES = String(500 * 1024 * 1024); // 500 MB for tests
// Explicit env (the Prisma CLI's .env loading overrides the inherited shell
// value — the M2 e2e hits the same thing and passes env explicitly).
execSync("bunx prisma db push --skip-generate --accept-data-loss", {
  env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` },
  stdio: ["ignore", "ignore", "inherit"],
});

let db: typeof import("../src/lib/db").db;
let storage: typeof import("../src/lib/media-storage");
let helpers: typeof import("../src/lib/job-helpers");
let worker: typeof import("../src/lib/media-worker");
let analysis: typeof import("../src/lib/media-analysis");
let proxy: typeof import("../src/lib/media-proxy");
let jobRunner: typeof import("../src/lib/job-runner");

const WORK = mkdtempSync(path.join(os.tmpdir(), "beanfx-m3-test-"));
const USER_A = "user-a-test";
const USER_B = "user-b-test";

// Fixtures (real ffmpeg output) — generated once for the whole file.
const FIX = {
  fp360: path.join(WORK, "small.mp4"),
  fp720: path.join(WORK, "hd.mp4"),
  fnoAudio: path.join(WORK, "noaudio.mp4"),
  fvfr: path.join(WORK, "vfr.mp4"),
  frot: path.join(WORK, "rotated.mp4"),
  fcorrupt: path.join(WORK, "corrupt.mp4"),
  faudio: path.join(WORK, "tone.wav"),
};

function ffmpeg(args: string, outfile: string) {
  execSync(`ffmpeg -hide_banner -loglevel error -y ${args} "${outfile}"`, { stdio: ["ignore", "ignore", "inherit"] });
  if (!existsSync(outfile) || statSync(outfile).size === 0) throw new Error(`fixture generation failed: ${outfile}`);
}

async function seedUser(id: string) {
  await db.user.create({ data: { id, email: `${id}@m3.test`, passwordHash: "scrypt:x:y", name: id } }).catch(() => undefined);
}

async function seedAsset(userId: string, filePath: string, name: string, kind: "VIDEO" | "AUDIO" = "VIDEO") {
  return db.mediaAsset.create({
    data: {
      userId,
      originalName: name,
      storagePath: filePath,
      kind,
      mimeType: "application/octet-stream",
      sizeBytes: statSync(filePath).size,
      probeStatus: "PENDING",
      proxyStatus: "NONE",
    },
  });
}

/** Drive worker ticks until fn() is true (or fail with a timeout). */
async function tickUntil(fn: () => Promise<boolean> | boolean, maxTicks = 40, what = "condition"): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (await fn()) return;
    await worker.tickWorkerOnce();
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timeout waiting (ticks) for ${what}`);
}

beforeAll(async () => {
  // Real fixtures — every case the reliability matrix demands.
  ffmpeg(`-f lavfi -i testsrc2=duration=2:size=640x360:rate=30 -f lavfi -i sine=frequency=440:duration=2:sample_rate=44100 -c:v libx264 -preset ultrafast -c:a aac -shortest -movflags +faststart`, FIX.fp360);
  ffmpeg(`-f lavfi -i testsrc2=duration=2:size=1280x720:rate=30 -f lavfi -i sine=frequency=440:duration=2:sample_rate=48000 -c:v libx264 -preset ultrafast -c:a aac -shortest -movflags +faststart`, FIX.fp720);
  ffmpeg(`-f lavfi -i testsrc2=duration=1.5:size=1280x720:rate=30 -c:v libx264 -preset ultrafast`, FIX.fnoAudio);
  // VFR: drop a frame span but KEEP the source timestamps — real gaps in pts
  // make avg_frame_rate diverge below r_frame_rate (a re-stamped setpts would
  // just compress duration instead).
  ffmpeg(
    `-f lavfi -i testsrc2=duration=2:size=320x240:rate=30 -vf "select='lt(n,20)+gte(n,40)',setpts='if(lt(N,20), N/(30*TB), (N+20)/(30*TB))'" -fps_mode vfr -c:v libx264 -preset ultrafast`,
    FIX.fvfr
  );
  // Rotation: ffmpeg 7 stores display matrices via stream copy — encode plain,
  // then remux with an input-side display rotation (transcode drops it).
  ffmpeg(`-f lavfi -i testsrc2=duration=1:size=320x240:rate=30 -c:v libx264 -preset ultrafast`, path.join(WORK, "plain.mp4"));
  ffmpeg(`-display_rotation 90 -i "${path.join(WORK, "plain.mp4")}" -c copy`, FIX.frot);
  // Corrupt: first 20 KB of a moov-at-end file — ffprobe must refuse.
  ffmpeg(`-f lavfi -i testsrc2=duration=1:size=320x240:rate=30 -c:v libx264 -preset ultrafast`, path.join(WORK, "full.mp4"));
  writeFileSync(FIX.fcorrupt, readFileSync(path.join(WORK, "full.mp4")).subarray(0, 20_000));
  ffmpeg(`-f lavfi -i sine=frequency=440:duration=1.5:sample_rate=48000 -c:a pcm_s16le`, FIX.faudio);

  const dbm = await import("../src/lib/db");
  db = dbm.db;
  storage = await import("../src/lib/media-storage");
  helpers = await import("../src/lib/job-helpers");
  worker = await import("../src/lib/media-worker");
  analysis = await import("../src/lib/media-analysis");
  proxy = await import("../src/lib/media-proxy");
  jobRunner = await import("../src/lib/job-runner");
  await storage.ensureMediaRoot();
  await seedUser(USER_A);
  await seedUser(USER_B);
});

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
  try {
    rmSync(String(process.env.DATABASE_URL).replace("file:", ""), { force: true });
  } catch {
    /* best effort */
  }
});

// ── 1. container sniffing + checksums ────────────────────────────────────────
describe("M3.1 signature validation", () => {
  test("sniffContainer identifies real containers from magic bytes", () => {
    const mp4 = Buffer.concat([Buffer.alloc(4, 0), Buffer.from("ftypisom"), Buffer.alloc(8, 0)]);
    expect(storage.sniffContainer(mp4)).toEqual({ family: "ftyp", mime: "video/mp4" });
    const qt = Buffer.concat([Buffer.alloc(4, 0), Buffer.from("ftypqt  "), Buffer.alloc(8, 0)]);
    expect(storage.sniffContainer(qt).mime).toBe("video/quicktime");
    expect(storage.sniffContainer(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])).family).toBe("matroska");
    expect(storage.sniffContainer(Buffer.from("OggSabcdef")).family).toBe("ogg");
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4, 0), Buffer.from("WAVE")]);
    expect(storage.sniffContainer(wav)).toEqual({ family: "wav", mime: "audio/wav" });
    expect(storage.sniffContainer(Buffer.from("fLaCxxxx")).family).toBe("flac");
    expect(storage.sniffContainer(Buffer.from("ID3\x04xxx")).family).toBe("mp3");
    expect(storage.sniffContainer(Buffer.from([0xff, 0xf1, 0x00, 0x00])).family).toBe("aac-adts");
    expect(storage.sniffContainer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0])).family).toBe("png");
    expect(storage.sniffContainer(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).family).toBe("jpeg");
    expect(storage.sniffContainer(Buffer.from("this is not media at all............")).family).toBe("unknown");
  });

  test("sniffMatchesClass rejects cross-class uploads (wav masquerading as video)", () => {
    expect(storage.sniffMatchesClass({ family: "wav", mime: "audio/wav" }, "VIDEO")).toBe(false);
    expect(storage.sniffMatchesClass({ family: "wav", mime: "audio/wav" }, "AUDIO")).toBe(true);
    expect(storage.sniffMatchesClass({ family: "ftyp", mime: "video/mp4" }, "AUDIO")).toBe(true); // m4a
    expect(storage.sniffMatchesClass({ family: "ftyp", mime: "video/mp4" }, "VIDEO")).toBe(true);
    expect(storage.sniffMatchesClass({ family: "png", mime: "image/png" }, "VIDEO")).toBe(false);
  });

  test("sha256File produces the NIST vector for 'abc'", async () => {
    const p = path.join(WORK, "abc.txt");
    writeFileSync(p, "abc");
    expect(await storage.sha256File(p)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

// ── 2. deep probe on real fixtures ───────────────────────────────────────────
describe("M3.2 ffprobe deep analysis", () => {
  test("CFR mp4: dimensions, codecs, fps, mime, no VFR", async () => {
    const probe = await analysis.probeMediaDeep(FIX.fp720);
    expect(probe.width).toBe(1280);
    expect(probe.height).toBe(720);
    expect(probe.videoCodec).toBe("h264");
    expect(probe.audioCodec).toBe("aac");
    expect(probe.sampleRate).toBe(48000);
    expect(probe.hasVideo && probe.hasAudio).toBe(true);
    expect(probe.isVfr).toBe(false);
    expect(probe.formatName).toContain("mp4");
    expect(probe.mime).toBe("video/mp4");
    expect(Math.abs(probe.durationSec! - 2)).toBeLessThan(0.3);
  });

  test("variable frame rate is detected (avg diverges from nominal)", async () => {
    const probe = await analysis.probeMediaDeep(FIX.fvfr);
    expect(probe.hasVideo).toBe(true);
    expect(probe.isVfr).toBe(true);
    expect(probe.fpsNominal).not.toBeNull();
    expect(probe.fpsAvg).not.toBeNull();
    expect(probe.fpsAvg!).toBeLessThan(probe.fpsNominal!);
  });

  test("rotation metadata is read from the display matrix", async () => {
    const probe = await analysis.probeMediaDeep(FIX.frot);
    expect(probe.rotation).toBe(90);
  });

  test("video-only file: hasAudio false", async () => {
    const probe = await analysis.probeMediaDeep(FIX.fnoAudio);
    expect(probe.hasVideo).toBe(true);
    expect(probe.hasAudio).toBe(false);
    expect(probe.audioCodec).toBeNull();
  });

  test("wav: audio-only container", async () => {
    const probe = await analysis.probeMediaDeep(FIX.faudio);
    expect(probe.hasAudio).toBe(true);
    expect(probe.hasVideo).toBe(false);
    expect(probe.mime).toBe("audio/wav");
  });

  test("corrupt file is a permanent failure", async () => {
    await expect(analysis.probeMediaDeep(FIX.fcorrupt)).rejects.toThrow(helpers.PermanentJobError);
  });

  test("proxy eligibility gates on resolution and duration", () => {
    expect(analysis.proxyEligible({ hasVideo: true, width: 1280, height: 720, durationSec: 2 })).toBe(true);
    expect(analysis.proxyEligible({ hasVideo: true, width: 640, height: 360, durationSec: 2 })).toBe(false);
    expect(analysis.proxyEligible({ hasVideo: true, width: 1920, height: 1080, durationSec: 5 * 3600 })).toBe(false);
    expect(analysis.proxyEligible({ hasVideo: false, width: 1920, height: 1080, durationSec: 2 })).toBe(false);
  });

  test("buildProxyPlan: even dims, rotation-aware scale, passthrough, audio guard", () => {
    const out1 = proxy.buildProxyPlan("src.mp4", { width: 1920, height: 1080, rotation: 0, hasAudio: true, durationSec: 10 }, "out.mp4");
    expect(out1.outWidth).toBe(960);
    expect(out1.outHeight).toBe(540);
    expect(out1.outWidth % 2).toBe(0);
    const args1 = out1.args.join(" ");
    expect(args1).toContain("-fps_mode passthrough");
    expect(args1).toContain("-video_track_timescale 90000");
    expect(args1).toContain("-c:a aac");
    const out2 = proxy.buildProxyPlan("src.mp4", { width: 1080, height: 1920, rotation: 0, hasAudio: false, durationSec: 10 }, "out.mp4");
    expect(out2.outHeight).toBe(960);
    expect(out2.outWidth).toBe(540);
    expect(out2.args.join(" ")).not.toContain("-c:a");
    // Rotated 90° landscape source: ffmpeg auto-rotates, so output is portrait.
    const out3 = proxy.buildProxyPlan("src.mp4", { width: 1920, height: 1080, rotation: 90, hasAudio: false, durationSec: 10 }, "out.mp4");
    expect(out3.outWidth).toBeLessThan(out3.outHeight);
  });
});

// ── 3. worker: probe + proxy end to end ──────────────────────────────────────
describe("M3.4 durable worker pipeline", () => {
  test("probe job persists full metadata and queues the proxy for HD sources", async () => {
    const asset = await seedAsset(USER_A, FIX.fp720, "hd.mp4");
    const jobId = await helpers.enqueueMediaJob(USER_A, helpers.JOB_TYPE_MEDIA_PROBE, { mediaId: asset.id });
    await tickUntil(async () => {
      const j = await db.job.findUnique({ where: { id: jobId } });
      return j?.status === "COMPLETED" || j?.status === "FAILED";
    }, 40, "probe completion");
    const job = await db.job.findUnique({ where: { id: jobId } });
    expect(job!.status).toBe("COMPLETED");
    const updated = await db.mediaAsset.findUnique({ where: { id: asset.id } });
    expect(updated!.probeStatus).toBe("READY");
    expect(updated!.width).toBe(1280);
    expect(updated!.videoCodec).toBe("h264");
    expect(updated!.mimeType).toBe("video/mp4");
    expect(updated!.formatName).toContain("mp4");
    const meta = JSON.parse(updated!.probeMetaJson!);
    expect(meta.video.width).toBe(1280);
    expect(updated!.proxyStatus).toBe("QUEUED"); // 720p source → proxy queued
    const proxyJobs = await db.job.findMany({ where: { userId: USER_A, type: helpers.JOB_TYPE_MEDIA_PROXY } });
    expect(proxyJobs.length).toBe(1);
  });

  test("proxy job produces an aligned, smaller proxy (timestamps preserved)", async () => {
    const asset = await db.mediaAsset.findFirst({ where: { userId: USER_A, originalName: "hd.mp4" } });
    await tickUntil(async () => {
      const a = await db.mediaAsset.findUnique({ where: { id: asset!.id } });
      return a?.proxyStatus === "READY" || a?.proxyStatus === "FAILED";
    }, 200, "proxy completion");
    const a = await db.mediaAsset.findUnique({ where: { id: asset!.id } });
    expect(a!.proxyStatus).toBe("READY");
    expect(existsSync(a!.proxyPath!)).toBe(true);
    expect(a!.proxySizeBytes!).toBeGreaterThan(0);
    expect(a!.proxySizeBytes!).toBeLessThan(a!.sizeBytes); // proxy is smaller
    // Alignment: the proxy tracks the source duration (passthrough timestamps).
    const probe = await analysis.probeMediaDeep(a!.proxyPath!);
    expect(Math.abs(probe.durationSec! - a!.durationSec!)).toBeLessThan(0.4);
    expect(Math.abs(a!.proxyDurationSec! - a!.durationSec!)).toBeLessThan(0.4);
  });

  test("sub-HD sources get proxyStatus NONE (original is used for preview)", async () => {
    const asset = await seedAsset(USER_A, FIX.fp360, "small.mp4");
    const jobId = await helpers.enqueueMediaJob(USER_A, helpers.JOB_TYPE_MEDIA_PROBE, { mediaId: asset.id });
    await tickUntil(async () => {
      const j = await db.job.findUnique({ where: { id: jobId } });
      return j?.status === "COMPLETED" || j?.status === "FAILED";
    }, 40, "probe completion (small)");
    const a = await db.mediaAsset.findUnique({ where: { id: asset.id } });
    expect(a!.probeStatus).toBe("READY");
    expect(a!.proxyStatus).toBe("NONE");
  });

  test("VFR source probes isVfr; sub-HD VFR is not proxied", async () => {
    const asset = await seedAsset(USER_A, FIX.fvfr, "vfr.mp4");
    const jobId = await helpers.enqueueMediaJob(USER_A, helpers.JOB_TYPE_MEDIA_PROBE, { mediaId: asset.id });
    await tickUntil(async () => {
      const j = await db.job.findUnique({ where: { id: jobId } });
      return j?.status === "COMPLETED" || j?.status === "FAILED";
    }, 40, "probe completion (vfr)");
    const a = await db.mediaAsset.findUnique({ where: { id: asset.id } });
    expect(a!.probeStatus).toBe("READY");
    expect(a!.isVfr).toBe(true);
    expect(a!.proxyStatus).toBe("NONE"); // 320x240 → not eligible
  });

  test("corrupt media: probe fails permanently (no retries wasted), asset intact", async () => {
    const asset = await seedAsset(USER_A, FIX.fcorrupt, "corrupt.mp4");
    const jobId = await helpers.enqueueMediaJob(USER_A, helpers.JOB_TYPE_MEDIA_PROBE, { mediaId: asset.id });
    await tickUntil(async () => {
      const j = await db.job.findUnique({ where: { id: jobId } });
      return j?.status === "FAILED" || j?.status === "COMPLETED";
    }, 40, "probe failure");
    const job = await db.job.findUnique({ where: { id: jobId } });
    expect(job!.status).toBe("FAILED");
    expect(job!.attempts).toBe(1); // permanent error → first attempt is final
    const a = await db.mediaAsset.findUnique({ where: { id: asset.id } });
    expect(a!.probeStatus).toBe("FAILED");
    expect(a!.probeError!.length).toBeGreaterThan(0);
    expect(existsSync(a!.storagePath)).toBe(true); // original never deleted
  });

  test("proxy failure on unreadable source marks the asset FAILED", async () => {
    const asset = await seedAsset(USER_A, FIX.fcorrupt, "corrupt2.mp4");
    // Pretend the probe passed so the proxy handler runs its real path.
    await db.mediaAsset.update({
      where: { id: asset.id },
      data: { probeStatus: "READY", durationSec: 2, width: 1920, height: 1080, videoCodec: "h264", proxyStatus: "QUEUED" },
    });
    const jobId = await helpers.enqueueMediaJob(USER_A, helpers.JOB_TYPE_MEDIA_PROXY, { mediaId: asset.id });
    await tickUntil(async () => {
      const j = await db.job.findUnique({ where: { id: jobId } });
      return j?.status === "FAILED" || j?.status === "COMPLETED";
    }, 60, "proxy failure");
    const job = await db.job.findUnique({ where: { id: jobId } });
    expect(job!.status).toBe("FAILED");
    const a = await db.mediaAsset.findUnique({ where: { id: asset.id } });
    expect(a!.proxyStatus).toBe("FAILED");
    expect(a!.proxyError).toBeTruthy();
  });

  test("retryable failure requeues with backoff; exhausted attempts fail; permanent fails at once", async () => {
    const jobId = await helpers.enqueueMediaJob(USER_A, helpers.JOB_TYPE_MEDIA_PROBE, { mediaId: "does-not-matter" }, { maxAttempts: 3 });
    // Every handleJobError call mirrors the claim lifecycle: status PROCESSING.
    await db.job.update({ where: { id: jobId }, data: { status: "PROCESSING", attempts: 1, lastHeartbeatAt: new Date() } });
    await helpers.handleJobError(jobId, new Error("transient fs hiccup"), 1, 3, "test");
    let job = await db.job.findUnique({ where: { id: jobId } });
    expect(job!.status).toBe("QUEUED");
    expect(job!.runAfter).not.toBeNull();
    // Next attempt claimed (PROCESSING again) and failed with attempts exhausted.
    await db.job.update({ where: { id: jobId }, data: { status: "PROCESSING", attempts: 3 } });
    await helpers.handleJobError(jobId, new Error("still transient"), 3, 3, "test");
    job = await db.job.findUnique({ where: { id: jobId } });
    expect(job!.status).toBe("FAILED");
    // Permanent error path: fails on the first attempt.
    const jobId2 = await helpers.enqueueMediaJob(USER_A, helpers.JOB_TYPE_MEDIA_PROBE, { mediaId: "x2" });
    await db.job.update({ where: { id: jobId2 }, data: { status: "PROCESSING", attempts: 1 } });
    await helpers.handleJobError(jobId2, new helpers.PermanentJobError("bad media"), 1, 3, "test");
    const job2 = await db.job.findUnique({ where: { id: jobId2 } });
    expect(job2!.status).toBe("FAILED");
  });

  test("queued job cancelled before claim never runs", async () => {
    const asset = await seedAsset(USER_A, FIX.fp360, "cancel-me.mp4");
    const jobId = await helpers.enqueueMediaJob(USER_A, helpers.JOB_TYPE_MEDIA_PROBE, { mediaId: asset.id });
    const cancelled = await jobRunner.jobManager.cancel(jobId, USER_A);
    expect(cancelled).toBe(true);
    await worker.tickWorkerOnce();
    await new Promise((r) => setTimeout(r, 300));
    const job = await db.job.findUnique({ where: { id: jobId } });
    expect(job!.status).toBe("CANCELLED");
    const a = await db.mediaAsset.findUnique({ where: { id: asset.id } });
    expect(a!.probeStatus).toBe("PENDING"); // untouched by the cancelled job
  });

  test("crashed claim recovers: stale heartbeat → requeue with backoff → completes", async () => {
    const asset = await seedAsset(USER_A, FIX.fp360, "crash.mp4");
    const jobId = await helpers.enqueueMediaJob(USER_A, helpers.JOB_TYPE_MEDIA_PROBE, { mediaId: asset.id });
    // Stage a claim that died mid-run (as a killed worker would leave it).
    const stale = new Date(Date.now() - 120_000);
    await db.job.update({
      where: { id: jobId },
      data: { status: "PROCESSING", attempts: 1, claimedAt: stale, lastHeartbeatAt: stale },
    });
    await db.mediaAsset.update({ where: { id: asset.id }, data: { probeStatus: "PROCESSING" } });

    await worker.tickWorkerOnce(); // recovery pass → requeue
    let job = await db.job.findUnique({ where: { id: jobId } });
    expect(job!.status).toBe("QUEUED");
    expect(job!.runAfter).not.toBeNull(); // backoff scheduled
    const a = await db.mediaAsset.findUnique({ where: { id: asset.id } });
    expect(a!.probeStatus).toBe("PENDING"); // asset marker rolled back

    await db.job.update({ where: { id: jobId }, data: { runAfter: null } }); // skip backoff for the test
    await tickUntil(async () => {
      const j = await db.job.findUnique({ where: { id: jobId } });
      return j?.status === "COMPLETED" || j?.status === "FAILED";
    }, 40, "post-recovery completion");
    job = await db.job.findUnique({ where: { id: jobId } });
    expect(job!.status).toBe("COMPLETED");
    expect(job!.attempts).toBe(2); // crashed claim + recovered claim
    const after = await db.mediaAsset.findUnique({ where: { id: asset.id } });
    expect(after!.probeStatus).toBe("READY");
  });

  test("global concurrency cap holds across a tick", async () => {
    const assets = [];
    for (let i = 0; i < 4; i++) {
      const p = path.join(WORK, `cap${i}.mp4`);
      if (!existsSync(p)) ffmpeg(`-f lavfi -i testsrc2=duration=1:size=320x240:rate=30 -c:v libx264 -preset ultrafast`, p);
      assets.push(await seedAsset(USER_B, p, `cap${i}.mp4`));
      await helpers.enqueueMediaJob(USER_B, helpers.JOB_TYPE_MEDIA_PROBE, { mediaId: assets[i].id });
    }
    await worker.tickWorkerOnce(); // claims at most GLOBAL_MAX_ACTIVE (2) in one pass
    const processing = await db.job.count({ where: { userId: USER_B, type: helpers.JOB_TYPE_MEDIA_PROBE, status: "PROCESSING" } });
    expect(processing).toBeLessThanOrEqual(2);
    await tickUntil(async () => {
      const done = await db.job.count({ where: { userId: USER_B, type: helpers.JOB_TYPE_MEDIA_PROBE, status: { in: ["COMPLETED", "FAILED", "CANCELLED"] } } });
      return done === 4;
    }, 80, "cap test completion");
  });
});

// ── 4. quota, dedup refcount, sweeps ────────────────────────────────────────
describe("M3.5 storage quota, dedup and cleanup", () => {
  test("quota accounting sums originals + proxies + exports", async () => {
    const USER_Q = "user-quota-test";
    await seedUser(USER_Q);
    await db.mediaAsset.create({
      data: { userId: USER_Q, originalName: "q.mp4", storagePath: "/nowhere/q.mp4", kind: "VIDEO", mimeType: "video/mp4", sizeBytes: 10_000_000, proxySizeBytes: 2_000_000, probeStatus: "READY" },
    });
    await db.exportFile.create({
      data: { userId: USER_Q, kind: "VIDEO", format: "mp4", filename: "q_export.mp4", storagePath: "/nowhere/q_export.mp4", sizeBytes: 5_000_000 },
    });
    const status = await storage.computeUserUsage(USER_Q);
    expect(status.usedBytes).toBe(17_000_000);
    // Quota is 500 MiB = 524,288,000 bytes — pick boundaries in matching units.
    const over = await storage.hasQuotaFor(USER_Q, 510_000_000);
    expect(over.ok).toBe(false); // 17 MB used + 510 MB > 500 MiB
    const fits = await storage.hasQuotaFor(USER_Q, 500_000_000);
    expect(fits.ok).toBe(true); // 17 MB + 500 MB = 517 MB ≤ 524.29 MB
  });

  test("content-addressed delete: file removed only with the last reference", async () => {
    const shared = path.join(WORK, "originals-shared.wav");
    copyFileSync(FIX.faudio, shared);
    const a = await db.mediaAsset.create({ data: { userId: USER_A, originalName: "a.wav", storagePath: shared, kind: "AUDIO", mimeType: "audio/wav", sizeBytes: 1, sha256: "deadbeef" } });
    const b = await db.mediaAsset.create({ data: { userId: USER_A, originalName: "b.wav", storagePath: shared, kind: "AUDIO", mimeType: "audio/wav", sizeBytes: 1, sha256: "deadbeef" } });
    // Deleting the first of two dedup rows keeps the file (the other refs it).
    expect(await storage.deleteMediaFileIfLastReference(shared, a.id)).toBe(false);
    expect(existsSync(shared)).toBe(true);
    await db.mediaAsset.delete({ where: { id: a.id } });
    expect(await storage.deleteMediaFileIfLastReference(shared, a.id)).toBe(false);
    expect(existsSync(shared)).toBe(true);
    // Deleting the last referencing row removes the bytes exactly once.
    await db.mediaAsset.delete({ where: { id: b.id } });
    expect(await storage.deleteMediaFileIfLastReference(shared, b.id)).toBe(true);
    expect(existsSync(shared)).toBe(false);
  });

  test("sweeps cancel abandoned upload sessions and remove scratch + orphan proxies", async () => {
    const staleDir = path.join(storage.MEDIA_ROOT, "tmp", "up_stale-session-01");
    await fs_mkdir(staleDir, { recursive: true });
    writeFileSync(path.join(staleDir, "000000.part"), "x");
    await db.uploadSession.create({
      data: {
        id: "stale-session-01",
        userId: USER_A,
        originalName: "old.mp4",
        ext: ".mp4",
        kind: "VIDEO",
        declaredSize: 1000n,
        chunkSize: 1000,
        chunkTotal: 1,
        status: "OPEN",
        lastChunkAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      },
    });
    const orphanProxy = path.join(storage.PROXIES_DIR, "no-such-asset.mp4");
    writeFileSync(orphanProxy, "junk");

    const result = await worker.runScratchSweeps();
    expect(result.sessions).toBeGreaterThanOrEqual(1);
    expect(result.orphans).toBeGreaterThanOrEqual(1);
    const session = await db.uploadSession.findUnique({ where: { id: "stale-session-01" } });
    expect(session!.status).toBe("CANCELLED");
    expect(existsSync(staleDir)).toBe(false);
    expect(existsSync(orphanProxy)).toBe(false);
  });
});
