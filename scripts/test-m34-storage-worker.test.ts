/**
 * M34 Track D — storage lifecycle & render-worker recovery scenarios that the
 * M20 durable-render suite does not already cover. The M20 contract remains
 * authoritative: one durable Job queue, claim+heartbeat, recovery sweep.
 *
 * Covered here (each against a real server on :3129, scratch DB + data dir):
 *   R1  invalid media (non-MP4 bytes with an .mp4 name) → honest refusal /
 *       probe failure, job never lies about success
 *   R2  missing source media at render time → job FAILED with an honest
 *       message; no partial export published; tmp intermediates cleaned
 *   R3  successful render after the R2 failure → COMPLETED, ffprobe-validated
 *   R4  quota/upload limits are the documented constants; originals preserved
 *   R5  storage lifecycle layout — originals/proxies/exports/tmp under one
 *       root, nothing at the root itself
 *
 * Run: bun test scripts/test-m34-storage-worker.test.ts  (spawns :3129)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { scratchLegacyDb } from "./legacy-fixture";

const PORT = process.env.M34_PORT ?? "3129";
const BASE = `http://localhost:${PORT}`;
const DB_URL = scratchLegacyDb("m34-storage-worker");
const DATA_DIR = `/tmp/m34-sw-store-${Date.now().toString(36)}`;
const STAMP = Date.now().toString(36);
const EMAIL = `m34sw-${STAMP}@test.local`;
const PW = `m34sw-${STAMP}-p1`;

let jar = "";

async function api(method: string, p: string, body?: unknown, raw?: Buffer, hdr: Record<string, string> = {}) {
  const headers: Record<string, string> = {
    ...(raw ? { "Content-Type": "application/octet-stream" } : body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(jar ? { cookie: jar } : {}),
    ...hdr,
  };
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers,
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    redirect: "manual",
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) { const [k, v] = c.split(";")[0].split("="); if (k === "beanfx_session") jar = `${k}=${v}`; }
  return { status: res.status, json: await res.json().catch(() => null), res };
}

function makeFixture(seconds: number, name: string): string {
  const out = `/tmp/m34sw-${name}-${STAMP}.mp4`;
  execSync(`ffmpeg -y -loglevel error -f lavfi -i testsrc=size=320x240:rate=30:duration=${seconds} -pix_fmt yuv420p -c:v libx264 "${out}"`, { timeout: 120_000 });
  return out;
}

const TRACKS = [
  { id: "v1", name: "V1", kind: "VIDEO", visible: true, muted: false, solo: false, locked: false },
  { id: "a1", name: "A1", kind: "AUDIO", visible: true, muted: false, solo: false, locked: false },
];

function clip(id: string, trackId: string, assetId: string, lenSec: number) {
  return {
    id, trackId, sourceAssetId: assetId, sourceInFrame: 0, sourceOutFrame: Math.round(lenSec * 30),
    sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: Math.round(lenSec * 30),
    playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
    keyframes: [], missingMedia: false,
  };
}

let serverProc: ReturnType<typeof spawn> | null = null;

beforeAll(async () => {
  serverProc = spawn("bash", ["scripts/dev-server.sh"], {
    env: { ...process.env, DATABASE_URL: DB_URL, BEANFX_DATA_DIR: DATA_DIR, PORT, RATE_LIMIT_SCALE: "50", PUBLIC_APP_URL: BASE, BEANFX_ZAI_BIN: "z-ai" },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: process.cwd(),
  });
  serverProc.stdout?.on("data", (d) => fs.appendFileSync("/tmp/m34-sw-server.log", String(d)));
  serverProc.stderr?.on("data", (d) => fs.appendFileSync("/tmp/m34-sw-server.log", String(d)));
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/`); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`M34 storage-worker server failed to start on :${PORT} — see /tmp/m34-sw-server.log`);
}, 180_000);

afterAll(async () => {
  const pid = execSync(`ss -tlnp 2>/dev/null | grep ':${PORT} ' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true`, { encoding: "utf8" }).trim();
  if (pid) { try { execSync(`kill -9 ${pid}`); } catch { /* already gone */ } }
  if (serverProc) { try { serverProc.kill(9); } catch { /* gone */ } }
});

async function registerAndLogin() {
  const reg = await api("POST", "/api/auth/register", { email: EMAIL, password: PW, name: "M34 SW" });
  expect(reg.status).toBe(200);
  const login = await api("POST", "/api/auth/login", { email: EMAIL, password: PW });
  expect(login.status).toBe(200);
}

async function upload(file: string, role = "BROLL") {
  return api("POST", "/api/media", undefined, fs.readFileSync(file), { "x-filename": path.basename(file), "x-role": role });
}

async function makeProject(name: string): Promise<string> {
  const pr = await api("POST", "/api/projects", { name });
  expect(pr.status).toBe(200);
  return (pr.json as { project: { id: string } }).project.id;
}

async function buildTimeline(projectId: string, assetId: string, lenSec = 2) {
  const head = await api("GET", `/api/editor/projects/${projectId}/timeline`);
  const cur = (head.json as { version?: { versionNumber?: number } } | null)?.version?.versionNumber ?? 1;
  const edits = TRACKS.map((t) => ({ type: "AddTrack", track: t })).concat([
    { type: "AddClip", clip: clip("c1", "v1", assetId, lenSec) },
    { type: "AddClip", clip: clip("a1", "a1", assetId, lenSec) },
  ]);
  const res = await api("POST", `/api/editor/projects/${projectId}/timeline`, { baseVersion: cur, edits });
  expect([200, 201]).toContain(res.status);
}

async function submitRender(projectId: string): Promise<string> {
  const r = await api("POST", `/api/editor/projects/${projectId}/render`, {});
  expect([200, 202]).toContain(r.status);
  return (r.json as { jobId: string }).jobId;
}

async function pollJob(jobId: string, maxSec = 180): Promise<{ status: string; message: string | null }> {
  const t0 = Date.now();
  for (;;) {
    const r = await api("GET", `/api/jobs/${jobId}`);
    const j = r.json as { job?: { status: string; message: string | null } } | null;
    if (r.status === 200 && j?.job && ["COMPLETED", "FAILED", "CANCELLED"].includes(j.job.status)) return j.job;
    if ((Date.now() - t0) / 1000 > maxSec) return { status: "TIMEOUT", message: `poll exceeded ${maxSec}s` };
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function withDb<T>(fn: (db: import("@prisma/client").PrismaClient) => Promise<T>): Promise<T> {
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: DB_URL } }, log: [] });
  try { return await fn(db); } finally { await db.$disconnect(); }
}

describe("M34 Track D — storage & worker recovery", () => {
  test("setup: account + 2s fixture uploaded through the real endpoint", async () => {
    await registerAndLogin();
    const fx = makeFixture(2, "src");
    const up = await upload(fx);
    expect(up.status).toBe(200);
    expect((up.json as { media?: { id: string } }).media?.id).toBeTruthy();
  }, 120_000);

  test("R1: invalid media (text bytes named .mp4) → honest refusal, no fake asset", async () => {
    const bogus = `/tmp/m34sw-bogus-${STAMP}.mp4`;
    fs.writeFileSync(bogus, "this is not a video file, it is plain text claiming to be mp4");
    const up = await upload(bogus);
    // Either an immediate 4xx refusal or a 2xx whose probe marks the asset
    // unusable — never a silently "usable" video asset.
    if (up.status >= 400) {
      expect(String(up.json ?? "")).not.toMatch(/"media":\s*\{\s*"id"/); // no fake success payload
    } else {
      const assetId = (up.json as { media?: { id: string } }).media!.id;
      await new Promise((r) => setTimeout(r, 8000));
      const row = await withDb(async (db) => await db.mediaAsset.findUnique({ where: { id: assetId } }) as { kind: string; validationStatus: string; storagePath: string } | null);
      if (row) expect(["IMAGE", "OTHER", "UNUSABLE", "INVALID", "DOCUMENT"]).toContain(row.kind);
    }
  }, 120_000);

  test("R2: missing source media → job FAILED honestly, no partial export, tmp cleaned", async () => {
    const fx = makeFixture(2, "missing");
    const up = await upload(fx);
    expect(up.status).toBe(200);
    const assetId = (up.json as { media?: { id: string } }).media!.id;
    const pid = await makeProject(`M34 SW missing-${STAMP}`);
    await buildTimeline(pid, assetId);
    const row = await withDb(async (db) => await db.mediaAsset.findUnique({ where: { id: assetId } }) as { storagePath: string } | null);
    expect(row?.storagePath).toBeTruthy();
    fs.rmSync(row!.storagePath, { force: true });
    const jobId = await submitRender(pid);
    const job = await pollJob(jobId, 180);
    expect(job.status).toBe("FAILED");
    expect((job.message ?? "").length).toBeGreaterThan(5); // honest reason recorded
    const exports_ = await withDb(async (db) => await db.exportFile.count({ where: { paramsJson: { contains: pid } } }));
    expect(exports_).toBe(0);
    const leftovers: string[] = [];
    const walk = (d: string) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/^(seg_|list_)/.test(f.name)) leftovers.push(p); } };
    if (fs.existsSync(path.join(DATA_DIR, "tmp"))) walk(path.join(DATA_DIR, "tmp"));
    expect(leftovers).toEqual([]);
  }, 300_000);

  test("R3: retry after failure → real completion, ffprobe-validated export", async () => {
    const fx = makeFixture(2, "retry");
    const up = await upload(fx);
    const assetId = (up.json as { media?: { id: string } }).media!.id;
    const pid = await makeProject(`M34 SW retry-${STAMP}`);
    await buildTimeline(pid, assetId);
    const jobId = await submitRender(pid);
    const job = await pollJob(jobId, 180);
    expect(job.status).toBe("COMPLETED");
    const exportId = await withDb(async (db) => {
      const e = await db.exportFile.findFirst({ where: { paramsJson: { contains: pid } }, orderBy: { createdAt: "desc" } });
      return (e as { id: string; storagePath: string } | null);
    });
    expect(exportId).toBeTruthy();
    expect(fs.existsSync(exportId!.storagePath)).toBe(true);
    const probe = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${exportId!.storagePath}"`, { encoding: "utf8" }).trim();
    expect(Number(probe)).toBeGreaterThan(1.5);
  }, 300_000);

  test("R4: documented upload/quota constants hold; originals preserved on disk", async () => {
    const { USER_QUOTA_BYTES, MAX_UPLOAD_BYTES } = await import("../src/lib/media-storage");
    expect(USER_QUOTA_BYTES).toBe(5 * 1024 * 1024 * 1024);
    expect(MAX_UPLOAD_BYTES).toBe(250 * 1024 * 1024);
    const origDir = path.join(DATA_DIR, "originals");
    expect(fs.existsSync(origDir)).toBe(true);
    // Content-addressed dedupe means byte-identical fixtures share one stored
    // original; the source footage of the FAILED R2 render stays deleted only
    // because the TEST removed it. At least one original must remain.
    expect(fs.readdirSync(origDir).length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  test("R5: storage lifecycle layout — originals/proxies/exports/tmp under one root", () => {
    for (const d of ["originals", "proxies", "exports", "tmp"]) {
      expect(fs.existsSync(path.join(DATA_DIR, d))).toBe(true);
    }
    const rootFiles = fs.readdirSync(DATA_DIR).filter((f) => fs.statSync(path.join(DATA_DIR, f)).isFile());
    expect(rootFiles).toEqual([]);
  });
});
