/**
 * M20 §3 — durable long-form rendering validation against a live server.
 * Tests: 60s / 300s / 600s multitrack durable renders, interrupted render
 * recovery (server kill + restart), OOM-aware recovery sweep, cancellation,
 * repeated submission, temp-file cleanup, FFprobe + decode validation, and
 * peak-RSS / wall-time measurement (memory.peak + process sampling).
 *
 * Run: BASE=http://localhost:3117 bun test scripts/test-m20-durable-render.test.ts
 * (long: ~20-25 min; writes JSON results to download/m20-render-logs/)
 */
import { describe, test, expect } from "bun:test";
import { execSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";

// M20 recovery: bun:sqlite direct handles raised SQLITE_MISUSE intermittently
// against the live server's WAL (bad parameter / API misuse). Route the test's
// raw reads/writes through the app's own Prisma engine instead — same SQL,
// no second SQLite binding fighting the server for the WAL index.
const prisma = new PrismaClient({ datasources: { db: { url: "file:/home/z/my-project/db/custom.db" } } });
async function q(sql: string): Promise<Record<string, unknown>[]> {
  return (await prisma.$queryRawUnsafe(sql)) as Record<string, unknown>[];
}
async function q1(sql: string): Promise<string> {
  const rows = await q(sql);
  return rows.length ? String(Object.values(rows[0])[0]) : "";
}
async function exec(sql: string): Promise<void> {
  await prisma.$executeRawUnsafe(sql);
}

const BASE = process.env.BASE ?? "http://localhost:3117";
const OUT = "/home/z/my-project/download/m20-render-logs";
fs.mkdirSync(OUT, { recursive: true });

const STAMP = Date.now().toString(36);
const EMAIL = `m20render-${STAMP}@test.local`;
const PW = "render-pass-99";
let cookie = "";

const results: Record<string, unknown> = { startedAt: new Date().toISOString(), renders: {}, ops: {} };
const save = () => fs.writeFileSync(path.join(OUT, "durable-render-results.json"), JSON.stringify(results, null, 1));

async function api(method: string, p: string, body?: unknown, raw?: Buffer, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extraHeaders };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${p}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const set = res.headers.getSetCookie?.() ?? [];
  for (const c of set) {
    const [k, v] = c.split(";")[0].split("=");
    if (k === "beanfx_session" && v) cookie = `${k}=${v}`;
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

type Peak = { rssPeakMb: number; samples: number };
const rssSamplers = new Map<string, Peak>();
function startRssSampler(key: string) {
  const peak: Peak = { rssPeakMb: 0, samples: 0 };
  rssSamplers.set(key, peak);
  const t = setInterval(() => {
    try {
      const out = execSync("ps -eo rss=,comm=", { encoding: "utf8" });
      let total = 0;
      for (const line of out.split("\n")) {
        const [rss, comm] = line.trim().split(/\s+/);
        if (comm === "ffmpeg" && rss) total += Number(rss);
      }
      peak.samples += 1;
      peak.rssPeakMb = Math.max(peak.rssPeakMb, Math.round(total / 1024));
    } catch { /* sampling is best-effort */ }
  }, 2000);
  return () => clearInterval(t);
}

async function makeFixture(sec: number, tag: string): Promise<string> {
  const p = `/tmp/m20-fixture-${tag}.mp4`;
  execSync(`ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=480x270:rate=30:duration=${sec}" -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=${sec}" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest "${p}"`);
  return p;
}

async function uploadFixture(p: string, role: string): Promise<string> {
  const res = await api("POST", "/api/media", undefined, fs.readFileSync(p), { "x-filename": path.basename(p), "x-role": role, "Content-Type": "application/octet-stream" });
  expect(res.status).toBe(200);
  return (res.json as { media: { id: string } }).media.id;
}

const TRACKS = [
  { id: "v1", name: "V1", kind: "VIDEO", visible: true, muted: false, solo: false, locked: false },
  { id: "v2", name: "V2", kind: "VIDEO", visible: true, muted: false, solo: false, locked: false },
  { id: "a1", name: "A1", kind: "AUDIO", visible: true, muted: false, solo: false, locked: false },
];
function clip(id: string, trackId: string, assetId: string, startSec: number, lenSec: number) {
  return {
    id, trackId, sourceAssetId: assetId, sourceInFrame: 0, sourceOutFrame: Math.round(lenSec * 30),
    sourceFps: { num: 30, den: 1 }, timelineStartFrame: Math.round(startSec * 30), timelineDurationFrames: Math.round(lenSec * 30),
    playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
    keyframes: [], missingMedia: false,
  };
}
async function buildSequence(projectId: string, mainAsset: string, overlayAsset: string, mainLenSec: number, repeats: number) {
  const clips = [];
  for (let i = 0; i < repeats; i++) {
    clips.push(clip(`m${i}`, "v1", mainAsset, i * mainLenSec, mainLenSec));
    clips.push(clip(`a${i}`, "a1", mainAsset, i * mainLenSec, mainLenSec));
  }
  // Overlay track: a shorter clip across the middle third (multitrack compositing).
  clips.push(clip("ov1", "v2", overlayAsset, mainLenSec, Math.min(mainLenSec, (repeats * mainLenSec) / 3)));
  const edits = TRACKS.map((t) => ({ type: "AddTrack", track: t })).concat(clips.map((c) => ({ type: "AddClip", clip: c })));
  // M20 recovery: the previous suite runs left timeline versions behind on the
  // reused named projects — a hardcoded baseVersion: 1 then failed validation
  // with 400. Always build on the CURRENT version number.
  // A fresh project has an EMPTY TimelineVersion table — the GET head (1) is
  // synthesized. applyTimelineEdits accepts 1 for empty history, but rejects
  // baseVersion < 1 outright, so floor the computed head at 1.
  const baseVersion = Math.max(Number(await q1(`SELECT COALESCE(MAX(versionNumber),0) AS v FROM TimelineVersion WHERE projectId='${projectId}'`)) || 0, 1);
  const res = await api("POST", `/api/editor/projects/${projectId}/timeline`, { baseVersion, edits });
  if (res.status !== 200) console.log("buildSequence 400 body:", JSON.stringify(res.json).slice(0, 300), "| baseVersion:", baseVersion);
  expect(res.status).toBe(200);
}

async function submitRender(projectId: string): Promise<string> {
  const res = await api("POST", `/api/editor/projects/${projectId}/render`, {});
  // 202 Accepted: durable jobs acknowledge before execution starts.
  expect([200, 202]).toContain(res.status);
  return (res.json as { jobId: string }).jobId;
}

async function jobState(jobId: string) {
  const res = await api("GET", `/api/exports?jobId=${jobId}`);
  if (res.status !== 200) return null;
  return res.json as { jobs?: Array<{ id: string; status: string; stage: string | null; message: string | null; progress: number }> };
}
// Poll a job by id through the admin-agnostic route: exports list returns jobs? —
// fall back to a direct query via the render GET (jobs list is per project).
async function pollJob(jobId: string, timeoutSec: number, label: string): Promise<{ status: string; message: string | null; wallSec: number; peak: Peak }> {
  const stop = startRssSampler(label);
  const t0 = Date.now();
  let status = "?", message: string | null = null;
  while ((Date.now() - t0) / 1000 < timeoutSec) {
    await new Promise((r) => setTimeout(r, 5000));
    // Direct DB-free status via the render endpoint of ANY project is awkward;
    // use the shared job status surface: /api/jobs/[id] if present, else exports.
    const res = await api("GET", `/api/jobs/${jobId}`);
    if (res.status === 200 && res.json && (res.json as { job?: { status: string } }).job) {
      const j = (res.json as { job: { status: string; message: string | null } }).job;
      status = j.status; message = j.message;
    } else {
      // Fallback: direct DB read (WAL allows concurrent readers).
      const row = await q(`SELECT status, COALESCE(message,'') AS m FROM Job WHERE id='${jobId}'`);
      if (row.length) { status = String(Object.values(row[0])[0]); message = String(Object.values(row[0])[1]); }
    }
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(status)) break;
  }
  stop();
  return { status, message, wallSec: Math.round((Date.now() - t0) / 1000), peak: rssSamplers.get(label) ?? { rssPeakMb: 0, samples: 0 } };
}

async function ffprobeValidate(outId: string, expectSec: number, tolSec: number, label: string) {
  const row = await q(`SELECT storagePath, sizeBytes FROM ExportFile WHERE id='${outId}'`);
  if (!row.length) throw new Error("export row missing");
  const p = String(Object.values(row[0])[0]);
  const size = String(Object.values(row[0])[1]);
  expect(fs.existsSync(p)).toBe(true);
  const dur = Number(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${p}"`, { encoding: "utf8" }).trim());
  const streams = execSync(`ffprobe -v error -show_entries stream=codec_type -of csv=p=0 "${p}"`, { encoding: "utf8" }).trim().split("\n").sort().join(",");
  const decode = execSync(`ffmpeg -v error -i "${p}" -f null - 2>&1 | wc -l`, { encoding: "utf8" }).trim();
  const rec = { path: p, sizeBytes: Number(size), durationSec: dur, streams, decodeErrors: Number(decode) };
  (results.renders as Record<string, unknown>)[label + "_output"] = rec;
  expect(Math.abs(dur - expectSec)).toBeLessThanOrEqual(tolSec);
  expect(streams).toContain("video");
  expect(streams).toContain("audio");
  expect(Number(decode)).toBe(0);
  return rec;
}

async function latestExportFor(projectId: string): Promise<string> {
  return q1(`SELECT id FROM ExportFile WHERE paramsJson LIKE '%${projectId}%' ORDER BY createdAt DESC LIMIT 1`);
}

describe("M20 §3 — durable long-form rendering", () => {
  test("setup: account, fixtures, projects", async () => {
    const reg = await api("POST", "/api/auth/register", { email: EMAIL, password: PW, name: "M20 Render" });
    expect(reg.status).toBe(200);
    const login = await api("POST", "/api/auth/login", { email: EMAIL, password: PW });
    expect(login.status).toBe(200);
    const main60 = await makeFixture(60, "main60");
    const overlay10 = await makeFixture(10, "ov10");
    (results as Record<string, unknown>).mainAsset = await uploadFixture(main60, "BROLL");
    (results as Record<string, unknown>).overlayAsset = await uploadFixture(overlay10, "BROLL");
    for (const name of ["M20 R60", "M20 R300", "M20 R600", "M20 R-INTERRUPT", "M20 R-CANCEL", "M20 R-REPEAT"]) {
      const pr = await api("POST", "/api/projects", { name });
      expect(pr.status).toBe(200);
      (results.ops as Record<string, string>)[name] = (pr.json as { project: { id: string } }).project.id;
    }
    save();
  }, 240000);

  test("T1: 60s durable render — completes, validates, cleans up", async () => {
    const pid = (results.ops as Record<string, string>)["M20 R60"];
    const main = (results as Record<string, unknown>).mainAsset as string;
    const ov = (results as Record<string, unknown>).overlayAsset as string;
    await buildSequence(pid, main, ov, 60, 1);
    const jobId = await submitRender(pid);
    const r = await pollJob(jobId, 600, "r60");
    (results.renders as Record<string, unknown>)["r60"] = { jobId, ...r };
    expect(r.status).toBe("COMPLETED");
    const exportId = await latestExportFor(pid);
    await ffprobeValidate(exportId, 80, 2, "r60") // repeats=1: main 60s + overlay 20s starting at 60s => 80s total;
    // temp cleanup: no seg_/list_ files remain
    const uDir = await q1(`SELECT storagePath FROM ExportFile WHERE id='${exportId}'`);
    const dir = path.dirname(uDir);
    const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("seg_") || f.startsWith("list_"));
    (results.renders as Record<string, unknown>)["r60_leftovers"] = leftovers;
    expect(leftovers.length).toBe(0);
    save();
  }, 700000);

  test("T2: 300s durable render (5 windows) — completes, validates", async () => {
    const pid = (results.ops as Record<string, string>)["M20 R300"];
    const main = (results as Record<string, unknown>).mainAsset as string;
    const ov = (results as Record<string, unknown>).overlayAsset as string;
    await buildSequence(pid, main, ov, 60, 5);
    const jobId = await submitRender(pid);
    const r = await pollJob(jobId, 1500, "r300");
    (results.renders as Record<string, unknown>)["r300"] = { jobId, ...r };
    expect(r.status).toBe("COMPLETED");
    const exportId = await latestExportFor(pid);
    const out = await ffprobeValidate(exportId, 300, 4, "r300");
    expect(out.durationSec).toBeGreaterThan(295);
    save();
  }, 1600000);

  test("T3: 600s multitrack durable render (10 windows + overlay) — completes, validates", async () => {
    const pid = (results.ops as Record<string, string>)["M20 R600"];
    const main = (results as Record<string, unknown>).mainAsset as string;
    const ov = (results as Record<string, unknown>).overlayAsset as string;
    await buildSequence(pid, main, ov, 60, 10);
    const jobId = await submitRender(pid);
    const r = await pollJob(jobId, 3600, "r600");
    (results.renders as Record<string, unknown>)["r600"] = { jobId, ...r };
    expect(r.status).toBe("COMPLETED");
    const exportId = await latestExportFor(pid);
    const out = await ffprobeValidate(exportId, 600, 6, "r600");
    // windowed registration recorded
    const win = await q1(`SELECT paramsJson FROM ExportFile WHERE id='${exportId}'`);
    expect(win).toContain('"windowed":true');
    expect(win).toContain('"windows":10');
    save();
  }, 3700000);
});

describe("M20 §3 — operational resilience", () => {
  test("T4: interrupted render (server SIGKILL mid-render) recovers and completes", async () => {
    const pid = (results.ops as Record<string, string>)["M20 R-INTERRUPT"];
    const main = (results as Record<string, unknown>).mainAsset as string;
    const ov = (results as Record<string, unknown>).overlayAsset as string;
    await buildSequence(pid, main, ov, 60, 10);
    const jobId = await submitRender(pid);
    await new Promise((r) => setTimeout(r, 45000)); // mid window 1
    // Kill the server (worker dies mid-render; ffmpeg becomes orphan).
    const serverPid = execSync("ss -tlnp | grep ':3117 ' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true", { encoding: "utf8" }).trim();
    if (serverPid) execSync(`kill -9 ${serverPid}`);
    else execSync("fuser -k 3117/tcp || true");
    await new Promise((r) => setTimeout(r, 3000));
    // Operational runbook: clear orphaned encoders before restart.
    execSync("pkill -9 ffmpeg || true");
    (results.ops as Record<string, unknown>)["interrupt"] = { killedServerPid: serverPid, jobId };
    // Restart the server.
    const env = { ...process.env, DATABASE_URL: "file:/home/z/my-project/db/custom.db", PORT: "3117", RATE_LIMIT_SCALE: "50" };
    // Capture the respawned server's output — a silent respawn hides worker
    // crashes (run 6's post-T7 tick wedge had no trail because of stdio ignore).
    const srvLog = fs.openSync("/home/z/my-project/m20-respawn-server.log", "a");
    spawn("bash", ["scripts/dev-server.sh"], { env, cwd: "/home/z/my-project", detached: true, stdio: ["ignore", srvLog, srvLog] }).unref();
    let up = false;
    for (let i = 0; i < 90; i++) { // next dev cold start can exceed 60s after port release
      await new Promise((r) => setTimeout(r, 2000));
      try { execSync(`curl -sf -o /dev/null ${BASE}/`); up = true; break; } catch { /* not up yet */ }
    }
    expect(up).toBe(true);
    // Recovery sweep (CLAIM_STALE_MS=90s) must requeue the interrupted job.
    await new Promise((r) => setTimeout(r, 120000));
    const r = await pollJob(jobId, 3600, "interrupt");
    (results.renders as Record<string, unknown>)["interrupt"] = { jobId, ...r };
    expect(r.status).toBe("COMPLETED");
    const exportId = await latestExportFor(pid);
    await ffprobeValidate(exportId, 600, 6, "interrupt");
    save();
  }, 5400000);

  test("T5: OOM-killed job is failed by the recovery sweep, NOT requeued", async () => {
    // Simulate the M19 pathology directly: a stale PROCESSING render whose
    // message records an OOM kill (as runFfmpeg writes) but whose worker died
    // before persisting the failure.
    // q1 is async since the Prisma migration — missing await made realUid the
    // string "[object Promise]" and the FK rejected it (runs 6-7, 787).
    const realUid = await q1(`SELECT id FROM User ORDER BY createdAt LIMIT 1`);
    expect(realUid).toBeTruthy();
        // Heartbeats/timestamps must use Prisma's storage format (integer epoch
    // ms). SQLite datetime('now',...) writes TEXT, which the sweep's
    // integer-bounded comparison never treats as stale (proved by the A/B
    // probe: int-heartbeat row -> FAILED in <15s, text-heartbeat row stuck).
    await exec(`INSERT INTO Job (id,userId,type,status,progress,stage,message,attempts,maxAttempts,lastHeartbeatAt,createdAt,updatedAt) VALUES ('oom${STAMP}','${realUid}','RENDER_TIMELINE','PROCESSING',10,'Rendering timeline window 2/10 (FFmpeg)','The encoder process was killed by the system (signal SIGKILL) — most likely out of memory while rendering this timeline.',1,1,(CAST(strftime('%s','now') AS INTEGER) - 300) * 1000,CAST(strftime('%s','now') AS INTEGER) * 1000,CAST(strftime('%s','now') AS INTEGER) * 1000)`);
    await new Promise((r) => setTimeout(r, 40000)); // sweep period
    const row = await q1(`SELECT status FROM Job WHERE id='oom${STAMP}'`);
    (results.ops as Record<string, unknown>)["oomRecovery"] = { job: `oom${STAMP}`, status: row };
    expect(row).toBe("FAILED");
    save();
  }, 120000);

  test("T6: cancellation mid-render — CANCELLED, media intact", async () => {
    const pid = (results.ops as Record<string, string>)["M20 R-CANCEL"];
    const main = (results as Record<string, unknown>).mainAsset as string;
    const ov = (results as Record<string, unknown>).overlayAsset as string;
    await buildSequence(pid, main, ov, 60, 5);
    const jobId = await submitRender(pid);
    await new Promise((r) => setTimeout(r, 25000));
    // Cancel goes through the durable-job surface: DELETE /api/jobs/:id.
    const res = await api("DELETE", `/api/jobs/${jobId}`, {});
    expect([200, 202]).toContain(res.status);
    const r = await pollJob(jobId, 120, "cancel");
    (results.renders as Record<string, unknown>)["cancel"] = { jobId, ...r };
    expect(r.status).toBe("CANCELLED");
    const media = await api("GET", "/api/media");
    expect(media.status).toBe(200);
    expect(((media.json as { media: unknown[] }).media).length).toBeGreaterThan(0);
    save();
  }, 400000);

  test("T7: repeated submission of the same render — both complete", async () => {
    const pid = (results.ops as Record<string, string>)["M20 R-REPEAT"];
    const main = (results as Record<string, unknown>).mainAsset as string;
    const ov = (results as Record<string, unknown>).overlayAsset as string;
    await buildSequence(pid, main, ov, 60, 1);
    const j1 = await submitRender(pid);
    const j2 = await submitRender(pid);
    const [r1, r2] = await Promise.all([pollJob(j1, 900, "repeat1"), pollJob(j2, 900, "repeat2")]);
    (results.renders as Record<string, unknown>)["repeat"] = { j1, j2, r1: r1.status, r2: r2.status };
    expect(r1.status).toBe("COMPLETED");
    expect(r2.status).toBe("COMPLETED");
    save();
  }, 1000000);
});
