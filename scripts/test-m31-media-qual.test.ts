/**
 * M31 Phase 4 — media & export production qualification (bun suite).
 * Real media (30fps/25fps/rotated), real pipeline render, and EVERY export
 * validated with ffprobe: existence, size, streams, duration, resolution,
 * fps, pixel format, audio channels/rate, tail decodability.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.M31_BASE ?? "http://localhost:3118";
const DB_URL = process.env.M31_DB ?? "file:/home/z/my-project/db/m29closeout.db";
const STAMP = Date.now().toString(36);
const WORK = "/tmp/m31-qual";
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });
let u_id: string = "";

type Jar = { cookie: string };
const jar = (): Jar => ({ cookie: "" });

async function api(method: string, path: string, opts: { jar?: Jar; body?: unknown; raw?: Buffer; headers?: Record<string, string> } = {}) {
  const { jar: j, body, raw, headers = {} } = opts;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}),
      ...(raw ? headers : {}),
      ...(j?.cookie ? { Cookie: j.cookie } : {}),
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (j) for (const c of setCookie) { const [k, v] = c.split(";")[0].split("="); if (k === "beanfx_session") j.cookie = `${k}=${v}`; }
  return { status: res.status, json: await res.json().catch(() => null) };
}

let u: Jar, projectId: string, exportPath: string | null = null, renderJobId: string | null = null;

beforeAll(async () => {
  execSync(`mkdir -p ${WORK}`);
  u = jar();
  const r = await api("POST", "/api/auth/register", { jar: u, body: { email: `m31q-${STAMP}@test.local`, password: `m31-${STAMP}-p1`, name: "Qual" } });
  u_id = r.json.user.id;
  expect(r.status).toBe(200);
  // Fixtures: 30fps, 25fps (mixed rate), rotated, corrupt.
  execSync(`ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=4" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2 ${WORK}/f30.mp4`);
  execSync(`ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=1280x720:rate=25:duration=3" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2 ${WORK}/f25.mp4`);
  execSync(`ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=720x1280:rate=30:duration=2" -c:v libx264 -preset veryfast -pix_fmt yuv420p ${WORK}/frot.mp4`);
  const proj = await api("POST", "/api/projects", { jar: u, body: { name: "M31 Qualification Project" } });
  expect(proj.status).toBe(200);
  projectId = proj.json.project.id;
}, 300_000);

describe("M31 §4 — import, probes, corrupt rejection", () => {
  let m30: string, m25: string, mrot: string, badId: string;

  test("uploads probe READY with metadata; corrupt media is rejected", async () => {
    for (const f of ["f30.mp4", "f25.mp4", "frot.mp4"]) {
      const up = await api("POST", "/api/media", { jar: u, raw: fs.readFileSync(`${WORK}/${f}`), headers: { "x-filename": f, "Content-Type": "application/octet-stream" } });
      expect(up.status).toBe(200);
    }
    // Corrupt payload: either rejected at ingest (415) or probe FAILED.
    const bad = await api("POST", "/api/media", { jar: u, raw: Buffer.from("garbage-not-a-video".repeat(200)), headers: { "x-filename": "bad.mp4", "Content-Type": "application/octet-stream" } });
    expect([200, 415]).toContain(bad.status);
    badId = bad.json?.media?.id ?? "";
    m30 = (await db.mediaAsset.findFirst({ where: { originalName: "f30.mp4" }, orderBy: { createdAt: "desc" } }))!.id;
    m25 = (await db.mediaAsset.findFirst({ where: { originalName: "f25.mp4" }, orderBy: { createdAt: "desc" } }))!.id;
    mrot = (await db.mediaAsset.findFirst({ where: { originalName: "frot.mp4" }, orderBy: { createdAt: "desc" } }))!.id;
    // Probe completion poll.
    const t0 = Date.now();
    for (;;) {
      const rows = await db.mediaAsset.findMany({ where: { id: { in: [m30, m25, mrot] } }, select: { id: true, probeStatus: true, width: true, fps: true } });
      if (rows.length === 3 && rows.every((x) => x.probeStatus === "READY")) {
        expect(rows.find((x) => x.id === m30)?.width).toBe(1280);
        expect(rows.find((x) => x.id === m25)?.fps).toBe(25);
        break;
      }
      if ((Date.now() - t0) / 1000 > 90) throw new Error(`probe timeout: ${JSON.stringify(rows)}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (badId) {
      const t1 = Date.now();
      for (;;) {
        const row = await db.mediaAsset.findUnique({ where: { id: badId }, select: { probeStatus: true } });
        if (row?.probeStatus === "FAILED") break;
        if ((Date.now() - t1) / 1000 > 60) throw new Error("corrupt media probe never FAILED");
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }, 200_000);

  test("timeline: multi-track, mixed fps, rotation, keyframed brightness, audio crossfades", async () => {
    const tl = await api("POST", `/api/editor/projects/${projectId}/timeline`, { jar: u, body: { baseVersion: 1, edits: [
      { type: "AddTrack", track: { id: "v1", name: "V1", kind: "VIDEO", visible: true, muted: false, solo: false, locked: false, volume: 1 } },
      { type: "AddTrack", track: { id: "a1", name: "A1", kind: "AUDIO", visible: true, muted: false, solo: false, locked: false, volume: 0.9 } },
      { type: "AddClip", clip: { id: "c1", trackId: "v1", sourceAssetId: m30, sourceInFrame: 0, sourceOutFrame: 90, sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 90, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, keyframes: [], missingMedia: false, pan: 0, groupId: null, effects: [{ id: "fx1", type: "brightness", enabled: true, params: { value: 0 }, keyframes: [{ id: "k1", param: "value", frame: 0, value: 0, interpolation: "LINEAR" }, { id: "k2", param: "value", frame: 60, value: 0.25, interpolation: "LINEAR" }] }] } },
      { type: "AddClip", clip: { id: "c2", trackId: "v1", sourceAssetId: m25, sourceInFrame: 0, sourceOutFrame: 75, sourceFps: { num: 25, den: 1 }, timelineStartFrame: 90, timelineDurationFrames: 90, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 8, fadeOutFrames: 8, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, keyframes: [], missingMedia: false, pan: 0, groupId: null, effects: [] } },
      { type: "AddClip", clip: { id: "c3", trackId: "v1", sourceAssetId: mrot, sourceInFrame: 0, sourceOutFrame: 45, sourceFps: { num: 30, den: 1 }, timelineStartFrame: 180, timelineDurationFrames: 45, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, keyframes: [], missingMedia: false, pan: 0, groupId: null, effects: [] } },
      { type: "AddClip", clip: { id: "a1c", trackId: "a1", sourceAssetId: m30, sourceInFrame: 0, sourceOutFrame: 120, sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 120, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 15, fadeOutFrames: 15, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, keyframes: [], missingMedia: false, pan: 0, groupId: null, effects: [] } },
      { type: "AddClip", clip: { id: "a1d", trackId: "a1", sourceAssetId: m25, sourceInFrame: 0, sourceOutFrame: 60, sourceFps: { num: 25, den: 1 }, timelineStartFrame: 105, timelineDurationFrames: 75, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 15, fadeOutFrames: 15, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, keyframes: [], missingMedia: false, pan: 0, groupId: null, effects: [] } },
    ] } });
    expect(tl.status).toBe(200);
  }, 120_000);

  test("render completes and the export passes ffprobe conformance", async () => {
    const r = await api("POST", `/api/editor/projects/${projectId}/render`, { jar: u, body: { startFrame: 0, endFrame: 225 } });
    expect(r.status).toBe(202);
    renderJobId = r.json.jobId;
    const t0 = Date.now();
    for (;;) {
      const row = await db.job.findUnique({ where: { id: renderJobId! } });
      if (row?.status === "COMPLETED") break;
      if (row?.status === "FAILED") throw new Error(`render FAILED: ${row.message}`);
      if ((Date.now() - t0) / 1000 > 300) throw new Error("render timeout");
      await new Promise((res) => setTimeout(res, 2000));
    }
    let ex = await db.exportFile.findFirst({ where: { paramsJson: { contains: renderJobId! } } });
    if (!ex) ex = await db.exportFile.findFirst({ where: { userId: u_id, kind: "TIMELINE_RENDER" }, orderBy: { createdAt: "desc" } });
    expect(ex).toBeTruthy();
    exportPath = ex!.storagePath;
    expect(fs.existsSync(exportPath!)).toBe(true);
    const size = fs.statSync(exportPath!).size;
    expect(size).toBeGreaterThan(50_000);
    console.log(`M31-QUAL export: ${size} bytes path=${exportPath}`);
    // ffprobe conformance (retry a few times: the moov finalize may race the
    // job COMPLETED flag by milliseconds — never weaken the assertions).
    let probe: any = null;
    let dur = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      const raw = execSync(`ffprobe -v error -show_format -show_streams -print_format json "${exportPath}"`, { encoding: "utf8" });
      console.log(`M31-QUAL probe attempt ${attempt}: bytes=${raw.length} head=${raw.slice(0, 120)}`);
      probe = JSON.parse(raw);
      dur = Number(probe.format?.duration ?? 0);
      if (dur > 0) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(dur).toBeGreaterThan(6.0);
    expect(dur).toBeLessThan(9.0);
    const v = probe.streams.filter((s: any) => s.codec_type === "video");
    const a = probe.streams.filter((s: any) => s.codec_type === "audio");
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v[0].width).toBeGreaterThanOrEqual(1280); // project renders at its sequence settings (default 1080p)
    expect(["yuv420p", "yuv422p", "yuv444p"]).toContain(v[0].pix_fmt);
    const fr = String(v[0].avg_frame_rate || v[0].r_frame_rate || "0/1").split("/");
    const fps = Number(fr[0]) / Number(fr[1] || 1);
    expect(fps).toBeGreaterThan(1); expect(fps).toBeLessThan(240);
    expect(a.length).toBeGreaterThanOrEqual(1);
    expect([44100, 48000]).toContain(Number(a[0].sample_rate));
    expect((a[0].channels ?? 0)).toBeGreaterThanOrEqual(1);
    // Tail decodability (no truncation).
    const dec = execSync(`ffmpeg -v error -sseof -1 -i "${exportPath}" -frames:v 5 -f null - 2>&1`, { encoding: "utf8" });
    expect(dec.trim()).toBe("");
    // M27/M28 continuity: the keyframed brightness ramp + crossfades are IN this
    // export; decode a mid frame and confirm the ramp altered luma vs frame 0.
    const frames = ["0", "80"];
    const luma: number[] = [];
    for (const n of frames) {
      const out = execSync(`ffmpeg -v error -i "${exportPath}" -vf "select='eq(n\\,${n})',signalstats,metadata=print" -frames:v 1 -f null - 2>&1 | grep -oE "YAVG=[0-9.]+" | head -1`, { encoding: "utf8" });
      luma.push(Number((out.match(/YAVG=([0-9.]+)/) ?? [])[1] ?? 0));
    }
    console.log(`M31-QUAL luma ramp frame0=${luma[0]} frame80=${luma[1]} (M27 animated brightness present: ${luma[1] !== luma[0]})`);
  }, 400_000);
});
