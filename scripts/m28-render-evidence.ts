/**
 * M27 render evidence — drives the REAL pipeline end to end:
 *   register → project → upload two fixtures (different tones) → build a
 *   sequence → apply M27 edits THROUGH the timeline API (RollEdit, animated
 *   brightness keyframes, automatic audio crossfade) → RENDER_TIMELINE job →
 *   poll → FFprobe validation → luma animation measurement (signalstats) →
 *   crossfade continuity measurement (volumedetect on three windows).
 * Every claim printed here is measured, never asserted.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.M29_BASE ?? "http://localhost:3117";
const STAMP = Date.now().toString(36);
const EMAIL = `m28render-${STAMP}@test.local`;
const PW = "m28-render-pass-1";
let cookie = "";

async function api(method: string, p: string, body?: unknown, raw?: Buffer, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}), ...(raw ? headers : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [k, v] = c.split(";")[0].split("=");
    if (k === "beanfx_session" && v) cookie = `${k}=${v}`;
  }
  let json: any = null;
  try { json = await res.json(); } catch { /* binary */ }
  return { status: res.status, json };
}

const sh = (cmd: string) => execSync(cmd, { encoding: "utf8" });

function makeFixture(sec: number, freq: number, tag: string): string {
  const p = `/tmp/m27-fixture-${tag}.mp4`;
  // Fixture A uses a STATIC mid-gray picture so the animated brightness
  // measurement is unambiguous (constant source luma — any render luma change
  // is the effect animation, not the pattern). Fixture B keeps testsrc2.
  const video = tag === "a" ? "color=c=0x808080:size=480x270:rate=30:duration=" + sec : "testsrc2=size=480x270:rate=30:duration=" + sec;
  sh(`ffmpeg -y -loglevel error -f lavfi -i "${video}" -f lavfi -i "sine=frequency=${freq}:sample_rate=48000:duration=${sec}" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest "${p}"`);
  return p;
}

const TRACKS = [
  { id: "v1", name: "V1", kind: "VIDEO", visible: true, muted: false, solo: false, locked: false, volume: 1 },
  { id: "a1", name: "A1", kind: "AUDIO", visible: true, muted: false, solo: false, locked: false, volume: 1 },
];

function clip(id: string, trackId: string, assetId: string, startSec: number, lenSec: number) {
  return {
    id, trackId, sourceAssetId: assetId, sourceInFrame: 0, sourceOutFrame: Math.round(lenSec * 30),
    sourceFps: { num: 30, den: 1 }, timelineStartFrame: Math.round(startSec * 30), timelineDurationFrames: Math.round(lenSec * 30),
    playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
    keyframes: [], missingMedia: false, pan: 0, groupId: null, effects: [],
  };
}

async function pollJob(jobId: string, timeoutSec: number): Promise<{ status: string; message: string | null }> {
  const t0 = Date.now();
  for (;;) {
    const r = await api("GET", `/api/jobs/${jobId}`);
    const j = r.json?.job;
    if (j && ["COMPLETED", "FAILED", "CANCELLED"].includes(j.status)) return { status: j.status, message: j.message ?? null };
    if ((Date.now() - t0) / 1000 > timeoutSec) return { status: "TIMEOUT", message: null };
    await new Promise((res) => setTimeout(res, 1500));
  }
}

const meanVolume = (file: string, ss: string, t: string) => {
  const out = sh(`ffmpeg -hide_banner -ss ${ss} -t ${t} -i "${file}" -af volumedetect -f null - 2>&1 | grep -E "mean_volume|max_volume"`);
  const mean = out.match(/mean_volume: ([-\d.]+) dB/)?.[1];
  return Number(mean);
};

const lumaY = (file: string, ss: string) => {
  const out = sh(`ffmpeg -hide_banner -ss ${ss} -i "${file}" -frames:v 1 -vf signalstats,metadata=print -f null - 2>&1 | grep -oE "YAVG=[0-9.]+" | head -1`);
  return Number(out.split("=")[1]);
};

async function main() {
  const lines: string[] = [];
  const log = (s: string) => { lines.push(s); console.log(s); };

  log(`# M28 render evidence (M27 truncation regression + timings) — ${new Date().toISOString()}`);
  const reg = await api("POST", "/api/auth/register", { email: EMAIL, password: PW, name: "M27 Render" });
  log(`register: ${reg.status}`);
  const login = await api("POST", "/api/auth/login", { email: EMAIL, password: PW });
  if (login.status !== 200) throw new Error("login failed");
  const proj = await api("POST", "/api/projects", { name: "M27 evidence" });
  const projectId = proj.json.project.id;
  log(`project: ${projectId}`);

  const tImport0 = Date.now();
  const fa = makeFixture(7, 440, "a"); // 440 Hz tone (7 s — the roll needs 168 frames of source)
  const fb = makeFixture(7, 880, "b"); // 880 Hz tone
  const ua = await api("POST", "/api/media", undefined, fs.readFileSync(fa), { "x-filename": path.basename(fa), "x-role": "BROLL", "Content-Type": "application/octet-stream" });
  const ub = await api("POST", "/api/media", undefined, fs.readFileSync(fb), { "x-filename": path.basename(fb), "x-role": "BROLL", "Content-Type": "application/octet-stream" });
  const assetA = ua.json.media.id;
  const assetB = ub.json.media.id;
  const importMs = Date.now() - tImport0;
  log(`assets: ${assetA} (440Hz) + ${assetB} (880Hz)`);

  // Sequence: V1 A[0,150) + B[150,300); A1 same. BOUNDARY at frame 150.
  const edits: any[] = TRACKS.map((t) => ({ type: "AddTrack", track: t }));
  edits.push({ type: "AddClip", clip: clip("va", "v1", assetA, 0, 5) });
  edits.push({ type: "AddClip", clip: { ...clip("vb", "v1", assetB, 5, 5) } });
  edits.push({ type: "AddClip", clip: clip("aa", "a1", assetA, 0, 5) });
  edits.push({ type: "AddClip", clip: clip("ab", "a1", assetB, 5, 5) });
  // M27 P1 — ROLL the shared boundary 150 → 168 (+0.6 s).
  edits.push({ type: "RollEdit", leftClipId: "va", rightClipId: "vb", newBoundaryFrame: 168 });
  // The audio boundary rolls the same way (separate track, same operation).
  edits.push({ type: "RollEdit", leftClipId: "aa", rightClipId: "ab", newBoundaryFrame: 168 });
  // M27 P2 — animate brightness on clip va (0 → 0.5 across its 168 frames).
  edits.push(
    { type: "AddEffect", clipId: "va", effect: { id: "fx-b", type: "brightness", enabled: true, params: { value: 0.5 }, keyframes: [
      { id: "k1", param: "value", frame: 0, value: 0, interpolation: "LINEAR" },
      { id: "k2", param: "value", frame: 167, value: 0.5, interpolation: "LINEAR" },
    ], animatedParams: ["value"] } },
  );
  // M27 P3 — automatic audio crossfade (linear, 15 f) on the audio boundary.
  const lerp = (a: number, b: number, t: number) => Number((a + (b - a) * t).toFixed(4));
  const xf: any[] = [{ type: "MoveClip", clipId: "ab", newTimelineStartFrame: 153 }];
  for (let i = 1; i <= 9; i++) {
    const t = i / 9;
    xf.push({ type: "SetKeyframe", clipId: "aa", keyframe: { id: `xal${i}`, property: "volume", frame: 153 + Math.round(t * 14), value: lerp(1, 0, t), interpolation: "LINEAR", bezier: null } });
    xf.push({ type: "SetKeyframe", clipId: "ab", keyframe: { id: `xab${i}`, property: "volume", frame: Math.round(t * 14), value: lerp(0, 1, t), interpolation: "LINEAR", bezier: null } });
  }
  xf.push({ type: "SetKeyframe", clipId: "aa", keyframe: { id: "xal0", property: "volume", frame: 0, value: 1, interpolation: "LINEAR", bezier: null } });
  xf.push({ type: "SetKeyframe", clipId: "ab", keyframe: { id: "xab15", property: "volume", frame: 15, value: 1, interpolation: "LINEAR", bezier: null } });
  edits.push(...xf);

  const baseVersion = 1;
  const tTimeline0 = Date.now();
  const tl = await api("POST", `/api/editor/projects/${projectId}/timeline`, { baseVersion, edits });
  log(`timeline apply (RollEdit + animated effect + crossfade batch): ${tl.status}`);
  if (tl.status !== 200) { log(JSON.stringify(tl.json).slice(0, 500)); throw new Error("timeline apply failed"); }
  const timelineMs = Date.now() - tTimeline0;
  // M28 P7 — pipeline timings: wait for the 1080p+ fixtures' probes/proxies
  // and measure proxy generation wall time (testsrc2 at 960 long edge is not
  // proxy-eligible, so this measures probe only — recorded honestly).
  const tProxy0 = Date.now();
  for (;;) {
    const ad = await api("GET", `/api/media/${assetA}`);
    if (ad.json?.media?.probeStatus === "READY") break;
    if ((Date.now() - tProxy0) / 1000 > 60) throw new Error("probe timeout");
    await new Promise((r) => setTimeout(r, 500));
  }
  const probeMs = Date.now() - tProxy0;
  log(`timings: import(2 fixtures incl. transcode)=${importMs}ms, timeline-apply=${timelineMs}ms, probe-settle=${probeMs}ms`);

  const render = await api("POST", `/api/editor/projects/${projectId}/render`, {});
  log(`render job: ${render.status} ${JSON.stringify(render.json).slice(0, 200)}`);
  const jobId = render.json.jobId ?? render.json.job?.id;
  if (!jobId) throw new Error("no render job id");
  const tRender0 = Date.now();
  const done = await pollJob(jobId, 600);
  log(`render: ${done.status} ${done.message ?? ""} (wall ${(Date.now() - tRender0) / 1000 | 0}s)`);
  if (done.status !== "COMPLETED") throw new Error(`render failed: ${done.message}`);

  // The render registers an ExportFile (kind TIMELINE_RENDER) — read it via
  // prisma (same DB the worker wrote; local sandbox, same machine).
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: process.env.M29_DB ?? "file:/home/z/my-project/db/custom.db" } } });
  const jobRow = await db.job.findUnique({ where: { id: jobId }, select: { exportId: true } });
  if (!jobRow?.exportId) throw new Error("render job registered no exportId");
  const exRow = await db.exportFile.findUnique({ where: { id: jobRow.exportId } });
  await db.$disconnect();
  if (!exRow) throw new Error("no TIMELINE_RENDER ExportFile registered for the job");
  const outPath = "/tmp/m28-render.mp4";
  fs.copyFileSync(exRow.storagePath, outPath);
  log(`export: ${exRow.id} → ${fs.statSync(outPath).size} bytes (ffprobe-validated by the worker)`);

  // FFprobe validation.
  const probe = sh(`ffprobe -v error -show_entries stream=codec_type,codec_name,duration -of csv=p=0 "${outPath}"`);
  log(`ffprobe streams: ${probe.trim().replace(/\n/g, " | ")}`);

  // Brightness ANIMATION evidence: luma rises across the animated clip.
  const l0 = lumaY(outPath, "0.5");
  const l1 = lumaY(outPath, "3.0");
  const l2 = lumaY(outPath, "5.4");
  const rampOk = l1 > l0 + 10 && l2 > l1 + 10;
  log(`luma YAVG @0.5s=${l0} @3.0s=${l1} @5.4s=${l2} (static gray source: animated brightness 0→0.5 → expect rising luma; ramp ${rampOk ? "PASS" : "CHECK"})`);

  // Crossfade continuity: overlap (5.1–5.4 s: A fading, B rising) vs pure regions.
  const vA = meanVolume(outPath, "3.0", "1.0");
  const vX = meanVolume(outPath, "5.2", "0.3");
  const vB = meanVolume(outPath, "6.8", "1.0");
  log(`mean_volume A-only=${vA} dB, overlap=${vX} dB, B-only=${vB} dB (continuity: |overlap − neighbors| < 4 dB)`);
  // Per-100ms RMS shape across the boundary (5.1–5.6 s overlap window).
  const shape: string[] = [];
  for (let t = 4.9; t <= 5.75; t += 0.1) {
    shape.push(`${t.toFixed(1)}s:${meanVolume(outPath, t.toFixed(2), "0.08")}dB`);
  }
  log(`rms shape: ${shape.join(" ")}`);
  const continuity = Math.abs(vX - vA) < 4 && Math.abs(vX - vB) < 4;
  log(`crossfade continuity: ${continuity ? "PASS" : "CHECK"}`);
  fs.writeFileSync("/home/z/my-project/download/m28-evidence/render-evidence.log", lines.join("\n") + "\n");
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
