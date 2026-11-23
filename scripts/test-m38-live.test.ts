/**
 * BEAN FX — M38 live integration: batch multi-format export + storage GC.
 *
 * Against a REAL server (BASE env, default :3119) with real FFmpeg:
 *  - a 2-format batch (mp4 + wav) renders through the durable RENDER_TIMELINE
 *    pipeline, validates with ffprobe (mp4: h264+aac; wav: audio-only pcm),
 *  - duplicate submission reuses the active/completed jobs,
 *  - per-item states surface through GET /render/batch with truthful batch
 *    completion (no false 100%),
 *  - GC dry-run identifies seeded stale artifacts WITHOUT touching bytes;
 *    execute reclaims exactly them while exports/originals survive.
 *
 * Run (server on :3119 with an isolated DB):
 *   BASE=http://127.0.0.1:3119 bun test scripts/test-m38-live.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:3119";
const STAMP = Date.now().toString(36);
const EMAIL = `m38batch-${STAMP}@test.local`;
const ADMIN_EMAIL = `m38admin-${STAMP}@test.local`;
const PW = "batch-pass-99";
let cookie = "";
let adminCookie = "";
const OUT = "/home/z/my-project/m38-evidence";
fs.mkdirSync(OUT, { recursive: true });

async function api(method: string, p: string, body?: unknown, raw?: Buffer, extraHeaders: Record<string, string> = {}, asAdmin = false) {
  const headers: Record<string, string> = { ...extraHeaders };
  const c = asAdmin ? adminCookie : cookie;
  if (c) headers.Cookie = c;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${p}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const set = res.headers.getSetCookie?.() ?? [];
  for (const kv of set) {
    const [k, v] = kv.split(";")[0].split("=");
    if (k === "beanfx_session" && v) {
      if (asAdmin) adminCookie = `${k}=${v}`;
      else cookie = `${k}=${v}`;
    }
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

function makeFixture(sec: number, tag: string): string {
  const p = `/tmp/m38-fixture-${tag}.mp4`;
  execSync(`ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=480x270:rate=30:duration=${sec}" -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=${sec}" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest "${p}"`);
  return p;
}

const TRACKS = [
  { id: "v1", name: "V1", kind: "VIDEO", visible: true, muted: false, solo: false, locked: false },
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

interface BatchItem { format: string; jobId: string; status: string; progress: number; stage: string | null; export: { id: string; filename: string; sizeBytes: number; durationSec: number | null; format: string } | null }
interface BatchState { items: BatchItem[]; batch: { total: number; completed: number; failed: number; cancelled: number; active: number; batchComplete: boolean; allSucceeded: boolean } }

async function batchState(projectId: string): Promise<BatchState> {
  const res = await api("GET", `/api/editor/projects/${projectId}/render/batch`);
  expect(res.status).toBe(200);
  return res.json as BatchState;
}

async function waitBatch(projectId: string, timeoutMs: number): Promise<BatchState> {
  const t0 = Date.now();
  let last: BatchState | null = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await batchState(projectId);
    if (last.batch.batchComplete) return last;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return last as BatchState;
}

beforeAll(async () => {
  const reg = await api("POST", "/api/auth/register", { email: EMAIL, password: PW, name: "M38 Batch" });
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register failed: ${reg.status} ${reg.text.slice(0, 200)}`);
  await api("POST", "/api/auth/login", { email: EMAIL, password: PW });
});

describe("M38 live — batch multi-format export through the durable pipeline", () => {
  let projectId = "";

  test("setup: project, real media fixture, sequence", async () => {
    const proj = await api("POST", "/api/projects", { name: `M38 batch ${STAMP}` });
    expect([200, 201]).toContain(proj.status);
    projectId = (proj.json as { project: { id: string } }).project.id;
    const fixture = makeFixture(3, STAMP);
    const up = await api("POST", "/api/media", undefined, fs.readFileSync(fixture), { "x-filename": "main.mp4", "x-role": "FOOTAGE", "Content-Type": "application/octet-stream" });
    expect(up.status).toBe(200);
    const assetId = (up.json as { media: { id: string } }).media.id;
    const edits = TRACKS.map((t) => ({ type: "AddTrack", track: t })).concat([
      { type: "AddClip", clip: clip("m0", "v1", assetId, 0, 3) },
      { type: "AddClip", clip: clip("a0", "a1", assetId, 0, 3) },
    ]);
    const seq = await api("POST", `/api/editor/projects/${projectId}/timeline`, { baseVersion: 1, edits });
    expect(seq.status).toBe(200);
  });

  test("2-format batch (mp4+wav) enqueues two independent durable jobs", async () => {
    const res = await api("POST", `/api/editor/projects/${projectId}/render/batch`, { formats: ["mp4", "wav"] });
    expect(res.status).toBe(202);
    const body = res.json as { batch: Array<{ format: string; jobId: string; reused: boolean }> };
    expect(body.batch.length).toBe(2);
    expect(body.batch.map((b) => b.format).sort()).toEqual(["mp4", "wav"]);
    expect(body.batch.every((b) => !b.reused && b.jobId)).toBe(true);
    fs.writeFileSync(path.join(OUT, `batch-${STAMP}.json`), JSON.stringify(body, null, 1));
  });

  test("duplicate submission is protected (reused, no new jobs)", async () => {
    const res = await api("POST", `/api/editor/projects/${projectId}/render/batch`, { formats: ["wav", "wav"] });
    expect(res.status).toBe(202);
    const body = res.json as { batch: Array<{ format: string; reused: boolean }> };
    expect(body.batch.length).toBe(1); // deduped to the unique format
    expect(body.batch[0].reused).toBe(true);
  });

  test("both items complete with VALIDATED outputs (real ffmpeg + ffprobe)", async () => {
    const state = await waitBatch(projectId, 180_000);
    expect(state.batch.batchComplete).toBe(true);
    expect(state.batch.allSucceeded).toBe(true);
    expect(state.batch.completed).toBe(2);
    fs.writeFileSync(path.join(OUT, `batch-final-${STAMP}.json`), JSON.stringify(state, null, 1));
    for (const item of state.items) {
      expect(item.export, item.format).toBeTruthy();
      const file = `/tmp/m38-out-${item.format}-${STAMP}.${item.format}`;
      const dl = await fetch(`${BASE}/api/exports/${item.export!.id}/file`, { headers: { Cookie: cookie } });
      expect(dl.status).toBe(200);
      fs.writeFileSync(file, Buffer.from(await dl.arrayBuffer()));
      const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file]).toString()) as { streams: Array<{ codec_type: string; codec_name: string; width?: number }> };
      if (item.format === "mp4") {
        expect(probe.streams.some((s) => s.codec_type === "video" && s.codec_name === "h264")).toBe(true);
        expect(probe.streams.some((s) => s.codec_type === "audio")).toBe(true);
      } else if (item.format === "wav") {
        expect(probe.streams.length).toBe(1);
        expect(probe.streams[0].codec_type).toBe("audio");
        expect(probe.streams[0].codec_name).toBe("pcm_s16le");
      }
    }
  });

  test("storage GC live: dry-run reports stale artifacts without touching bytes; execute reclaims exactly them", async () => {
    const admin = await api("POST", "/api/auth/register", { email: ADMIN_EMAIL, password: PW, name: "M38 Admin" }, undefined, {}, true);
    expect([200, 201]).toContain(admin.status);
    // Grant the admin role directly in the isolated DB (dev/test bootstrap;
    // production grants are an owner action).
    const { db } = await import("../src/lib/db");
    await db.user.update({ where: { email: ADMIN_EMAIL }, data: { role: "admin" } });
    await db.$disconnect();
    const login = await api("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: PW }, undefined, {}, true);
    expect(login.status).toBe(200);

    // Seed a stale, unreferenced render artifact (48 h old) next to REAL data.
    const dataDir = process.env.BEANFX_DATA_DIR!;
    const staleDir = path.join(dataDir, "timeline-renders", "u_staleseed");
    fs.mkdirSync(staleDir, { recursive: true });
    const stalePath = path.join(staleDir, "seq_abandoned_seed.mp4");
    fs.writeFileSync(stalePath, Buffer.alloc(512 * 1024, 5)); // 512 KB
    const old = new Date(Date.now() - 48 * 3600_000);
    fs.utimesSync(stalePath, old, old);
    const bytesBefore = execSync(`du -sb '${dataDir}'`, { encoding: "utf8" }).split("\t")[0];

    // Dry-run: the candidate appears; NOTHING changes on disk.
    const dry = await api("POST", "/api/admin/storage/lifecycle", { mode: "dry-run" }, undefined, {}, true);
    expect(dry.status).toBe(200);
    const dryReport = (dry.json as { report: { eligibleFiles: number; reclaimableBytes: number; candidates: Array<{ relPath: string; protectedReason: string | null }> } }).report;
    const seeded = dryReport.candidates.find((c) => c.relPath.includes("seq_abandoned_seed"));
    expect(seeded).toBeDefined();
    expect(seeded!.protectedReason).toBeNull();
    expect(existsSync(stalePath)).toBe(true);
    const bytesAfterDry = execSync(`du -sb '${dataDir}'`, { encoding: "utf8" }).split("\t")[0];
    expect(bytesAfterDry).toBe(bytesBefore);

    // Non-admin (ordinary user) is refused — no public cleanup endpoint.
    const forbidden = await api("POST", "/api/admin/storage/lifecycle", { mode: "dry-run" });
    expect([401, 403]).toContain(forbidden.status);

    // Execute: the stale artifact is reclaimed; real exports + originals stay.
    const exec = await api("POST", "/api/admin/storage/lifecycle", { mode: "execute", maxFiles: 100 }, undefined, {}, true);
    expect(exec.status).toBe(200);
    const report = (exec.json as { report: { deletedFiles: number; reclaimedBytes: number; outcomes: Array<{ relPath: string; status: string }> } }).report;
    const seededOutcome = report.outcomes.find((o) => o.relPath.includes("seq_abandoned_seed"));
    expect(seededOutcome?.status).toBe("deleted");
    expect(existsSync(stalePath)).toBe(false);
    const bytesAfterExec = execSync(`du -sb '${dataDir}'`, { encoding: "utf8" }).split("\t")[0];
    expect(Number(bytesAfterExec)).toBeLessThan(Number(bytesAfterDry));
    // Protected: this batch's real outputs and the fixture source are intact.
    const state = await batchState(projectId);
    for (const item of state.items) {
      expect(item.export).toBeTruthy();
      const head = await fetch(`${BASE}/api/exports/${item.export!.id}/file`, { method: "HEAD", headers: { Cookie: cookie } });
      expect(head.status).toBe(200);
    }
    fs.writeFileSync(path.join(OUT, `gc-${STAMP}.json`), JSON.stringify({ deleted: report.deletedFiles, reclaimedBytes: report.reclaimedBytes, seeded: seededOutcome }, null, 1));
  });
});

function existsSync(p: string): boolean {
  return fs.existsSync(p);
}

afterAll(() => {
  try { fs.rmSync(`/tmp/m38-fixture-${STAMP}.mp4`, { force: true }); } catch { /* cleanup best-effort */ }
});
