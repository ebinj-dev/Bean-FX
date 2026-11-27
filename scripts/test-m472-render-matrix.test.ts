/**
 * M47.2-A (M46.1) — REAL-MEDIA RENDER INTEGRITY MATRIX (cases A–J + negative K).
 *
 * Every case drives the REAL application: register → project → real upload →
 * canonical timeline commands → durable RENDER_TIMELINE job → download the
 * export → ffprobe + per-frame RGB sampling + decoded-audio loudness analysis.
 * A valid container is NOT proof — frames must contain the intended imagery
 * and audio must be non-silent (or intentionally silent).
 *
 * Source media (generated with ffmpeg, commands recorded in evidence):
 *   t2.mp4        testsrc2 6 s  + sine 440 Hz (motion + original audio)
 *   cycler.mp4    red→green→blue 2 s each + sine 440 Hz (content-addressable)
 *   silent.mp4    testsrc2 4 s, VIDEO-ONLY (-an)
 *   smpte.mp4     smptebars 4 s + sine 523 Hz
 *   mandel.mp4    mandelbrot 4 s + sine 659 Hz
 *   music.wav     sine 880 Hz 4 s PCM
 *   red.png/blue.png solid-colour stills
 *   longcycler.mp4 red/green/blue 84 s each + sine (252 s > 240 s threshold)
 *
 * Run (server on :3118):
 *   M472_BASE=http://localhost:3118 bun test scripts/test-m472-render-matrix.test.ts
 */
import { describe, test, expect, beforeAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const BASE = process.env.M472_BASE ?? "http://localhost:3118";
const MEDIA = "/tmp/m472-media";
const EVIDENCE = "/home/z/my-project/download/m472-evidence/render-matrix";
const STAMP = Date.now().toString(36);
fs.mkdirSync(EVIDENCE, { recursive: true });

let cookie = "";

async function api(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      ...(body !== undefined && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function uploadMedia(name: string, file: string, role = "SOURCE_FOOTAGE"): Promise<string> {
  // The upload route streams the RAW request body to disk (headers carry the
  // metadata) — no multipart envelope. Sending FormData would corrupt the file.
  const bytes = fs.readFileSync(path.join(MEDIA, file));
  const mime = file.endsWith(".mp4") ? "video/mp4" : file.endsWith(".wav") ? "audio/wav" : file.endsWith(".png") ? "image/png" : "application/octet-stream";
  const res = await fetch(`${BASE}/api/media`, {
    method: "POST",
    headers: {
      "Content-Type": mime,
      "x-project-id": currentProjectId,
      "x-filename": name,
      "x-asset-role": role,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: bytes,
  });
  const json = await res.json().catch(() => null);
  if (res.status >= 300) console.log(`UPLOAD ERROR ${name}:`, JSON.stringify(json).slice(0, 300));
  expect(res.status).toBeLessThan(300);
  const id = json?.asset?.id ?? json?.media?.id ?? json?.id;
  expect(id).toBeTruthy();
  return id as string;
}

let currentProjectId = "";

async function newProject(name: string): Promise<string> {
  const r = await api("POST", "/api/projects", { name });
  expect(r.status).toBeLessThan(300);
  const id = r.json?.project?.id ?? r.json?.id;
  expect(id).toBeTruthy();
  currentProjectId = id as string;
  return id;
}

interface Head { baseVersion: number; sequence: { tracks: Array<{ id: string; kind: string; name: string }>; fps: { num: number; den: number }; width: number; height: number } }

async function head(): Promise<Head> {
  const r = await api("GET", `/api/editor/projects/${currentProjectId}/timeline`);
  expect(r.status).toBe(200);
  // Route shape: { version, sequence, isAutosave } — `version` IS the baseVersion.
  const j = r.json as { version: number; sequence: Head["sequence"] };
  return { baseVersion: j.version, sequence: j.sequence };
}

/** First track id of the given kind in the current head sequence. */
async function trackId(kind: string): Promise<string> {
  const h = await head();
  const t = h.sequence.tracks.find((x) => x.kind === kind);
  if (!t) throw new Error(`no ${kind} track in head sequence`);
  return t.id;
}

const FPS = 30;
const clipCore = (o: Record<string, unknown>) => ({
  id: `c_${Math.random().toString(36).slice(2, 9)}`,
  trackId: "v1",
  sourceAssetId: "",
  sourceInFrame: 0,
  sourceOutFrame: 60,
  sourceFps: { num: 30, den: 1 },
  timelineStartFrame: 0,
  timelineDurationFrames: 60,
  playbackSpeed: 1,
  volume: 1,
  muted: false,
  fadeInFrames: 0,
  fadeOutFrames: 0,
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
  label: null, missingMedia: false, pan: 0, groupId: null, effects: [], keyframes: [],
  ...o,
});

async function setTimeline(clips: unknown[], extraTracks: unknown[] = [], transitions: unknown[] = []) {
  const h = await head();
  const videoTrack = h.sequence.tracks.find((x) => x.kind === "VIDEO")!.id;
  // Any clip still targeting the literal "v1" gets remapped to the real
  // VIDEO track id (default sequences generate composite ids).
  for (const c of clips as Array<Record<string, unknown>>) {
    if (c.trackId === "v1") c.trackId = videoTrack;
  }
  const edits = [
    ...extraTracks.map((t) => ({ type: "AddTrack", track: t })),
    ...clips.map((c) => ({ type: "AddClip", clip: c })),
    // Transitions arrive as complete AddTransition COMMANDS (the command
    // schema takes transitionId/trackId/kind/startFrame/durationFrames).
    ...transitions,
  ];
  const r = await api("POST", `/api/editor/projects/${currentProjectId}/timeline`, { baseVersion: h.baseVersion, edits });
  if (r.status >= 300) console.log("TIMELINE ERROR", JSON.stringify(r.json).slice(0, 400));
  expect(r.status).toBeLessThan(300);
}

async function renderAndWait(format?: string, timeoutSec = 600): Promise<{ exportPath: string; jobId: string; exportId: string; jobLog: unknown }> {
  const r = await api("POST", `/api/editor/projects/${currentProjectId}/render`, format ? { format } : {});
  if (r.status >= 300) console.log("RENDER ERROR", JSON.stringify(r.json).slice(0, 400));
  expect(r.status).toBe(202);
  const jobId = r.json?.jobId as string;
  expect(jobId).toBeTruthy();
  const t0 = Date.now();
  let status = "PROCESSING";
  let exportId: string | null = null;
  let message: string | null = null;
  for (;;) {
    const g = await api("GET", `/api/jobs/${jobId}`);
    const job = g.json?.job ?? g.json;
    status = String(job?.status ?? "");
    message = job?.message ?? null;
    exportId = job?.exportId ?? null;
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(status)) break;
    if ((Date.now() - t0) / 1000 > timeoutSec) throw new Error(`render timeout: ${status} ${message}`);
    await new Promise((res) => setTimeout(res, 1500));
  }
  const jobLog = { jobId, status, message, exportId };
  if (status !== "COMPLETED" || !exportId) throw new Error(`Render did not complete: ${JSON.stringify(jobLog)}`);
  const dl = await fetch(`${BASE}/api/exports/${exportId}/file`, { headers: { Cookie: cookie } });
  expect(dl.status).toBe(200);
  const buf = Buffer.from(await dl.arrayBuffer());
  const exportPath = path.join(EVIDENCE, `out_${jobId}.${(format ?? "mp4") === "wav" ? "wav" : format === "mp3" ? "mp3" : format === "mov" ? "mov" : "mp4"}`);
  fs.writeFileSync(exportPath, buf);
  return { exportPath, jobId, exportId, jobLog };
}

// ── verification helpers ─────────────────────────────────────────────────────
function ffprobeJson(f: string): { streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string; duration?: string }>; format: { duration: string } } {
  const out = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", f], { encoding: "utf8" });
  return JSON.parse(out.stdout);
}

/** Average RGB of an 8×8 downscale of the frame at time t (real decoded pixels). */
function frameRGB(f: string, t: number): { r: number; g: number; b: number } {
  const out = spawnSync("ffmpeg", ["-ss", String(t), "-i", f, "-frames:v", "1", "-vf", "scale=8:8", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 4096 });
  const d = out.stdout as Buffer;
  if (!d || d.length < 3) throw new Error(`no frame data at t=${t}: ${String(out.stderr).slice(0, 200)}`);
  let r = 0, g = 0, b = 0;
  const n = d.length / 3;
  for (let i = 0; i < d.length; i += 3) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

/**
 * Spatial spread of an 8×8 downsample: max over channels of (max − min across
 * cells). Black or solid-colour frames score ≈ 0; multi-colour content
 * (testsrc2 etc.) scores high. Proves REAL decoded imagery, not just
 * non-blackness.
 */
function frameSpread(f: string, t: number): number {
  const out = spawnSync("ffmpeg", ["-ss", String(t), "-i", f, "-frames:v", "1", "-vf", "scale=8:8", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 4096 });
  const d = out.stdout as Buffer;
  if (!d || d.length < 3) throw new Error(`no frame data at t=${t}`);
  let min = [255, 255, 255], max = [0, 0, 0];
  for (let i = 0; i < d.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      if (d[i + c] < min[c]) min[c] = d[i + c];
      if (d[i + c] > max[c]) max[c] = d[i + c];
    }
  }
  return Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

function frameIsNear(c: { r: number; g: number; b: number }, ref: { r: number; g: number; b: number }, tol = 70): boolean {
  return Math.abs(c.r - ref.r) <= tol && Math.abs(c.g - ref.g) <= tol && Math.abs(c.b - ref.b) <= tol;
}

/** Decoded-audio loudness via volumedetect — NOT merely the existence of a stream. */
function audioLevels(f: string): { mean: number; max: number } | null {
  const out = spawnSync("ffmpeg", ["-i", f, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  const s = String(out.stderr);
  const mean = Number((s.match(/mean_volume:\s*(-?[\d.]+) dB/) ?? [])[1] ?? NaN);
  const max = Number((s.match(/max_volume:\s*(-?[\d.]+) dB/) ?? [])[1] ?? NaN);
  if (Number.isNaN(mean)) return null;
  return { mean, max };
}

function saveEvidence(name: string, data: unknown) {
  fs.writeFileSync(path.join(EVIDENCE, name), JSON.stringify(data, null, 2));
}

const RED = { r: 255, g: 0, b: 0 };
const GREEN = { r: 0, g: 128, b: 0 };
const BLUE = { r: 0, g: 0, b: 255 };

let sharedAssets: Record<string, string> = {};

beforeAll(async () => {
  const reg = await api("POST", "/api/auth/register", {
    email: `m472-matrix-${STAMP}@beanfx.test`,
    password: `Mtx${STAMP}9z`,
    name: "M47.2 Render Matrix",
    // M47.2-C — explicit draft acknowledgement (server-enforced).
    acceptedDraftTerms: true,
  });
  expect(reg.status).toBeLessThan(300);
  // A dedicated project whose ONLY purpose is the render matrix (labelled test data).
  const pr = await api("POST", "/api/projects", { name: "M47.2 RENDER MATRIX — test data, safe to delete" });
  currentProjectId = pr.json?.project?.id;
  expect(currentProjectId).toBeTruthy();
  sharedAssets = {
    t2: await uploadMedia("t2.mp4", "t2.mp4"),
    cycler: await uploadMedia("cycler.mp4", "cycler.mp4"),
    silent: await uploadMedia("silent.mp4", "silent.mp4"),
    smpte: await uploadMedia("smpte.mp4", "smpte.mp4"),
    mandel: await uploadMedia("mandel.mp4", "mandel.mp4"),
    music: await uploadMedia("music.wav", "music.wav", "AUDIO_MUSIC"),
    red: await uploadMedia("red.png", "red.png", "REFERENCE_IMAGE"),
    blue: await uploadMedia("blue.png", "blue.png", "REFERENCE_IMAGE"),
    longcycler: await uploadMedia("longcycler.mp4", "longcycler.mp4"),
  };
  saveEvidence("uploaded-assets.json", { projectId: currentProjectId, assets: sharedAssets });
});

describe("M46.1 real-media render integrity matrix", () => {
  test("A: one video clip with visible motion and original audio", async () => {
    await newProject("M47.2-A motion+audio");
    const v = sharedAssets.t2;
    await setTimeline([clipCore({ trackId: "v1", sourceAssetId: v, sourceInFrame: 0, sourceOutFrame: 150, timelineDurationFrames: 150 })]);
    const { exportPath, jobLog } = await renderAndWait();
    const probe = ffprobeJson(exportPath);
    const video = probe.streams.find((s) => s.codec_type === "video");
    const audio = probe.streams.find((s) => s.codec_type === "audio");
    const frames = [0.5, 2.5, 4.5].map((t) => frameRGB(exportPath, t));
    const spreads = [0.5, 2.5, 4.5].map((t) => frameSpread(exportPath, t));
    const lvl = audioLevels(exportPath);
    const result = {
      case: "A", jobLog, durationSec: probe.format.duration,
      videoCodec: video?.codec_name, audioCodec: audio?.codec_name,
      dims: `${video?.width}x${video?.height}`, fps: video?.r_frame_rate,
      frameSamples: frames, spatialSpread: spreads, audio: lvl,
    };
    saveEvidence("case-A.json", result);
    expect(video?.codec_name).toBe("h264");
    expect(audio?.codec_name).toBe("aac");
    expect(Number(probe.format.duration)).toBeGreaterThan(4.4);
    // Frames are NOT black, and each carries REAL multi-colour content
    // (testsrc2's moving regions — a black frame would score ≈ 0 spread).
    for (const f of frames) expect(f.r + f.g + f.b).toBeGreaterThan(60);
    for (const sp of spreads) expect(sp).toBeGreaterThan(50);
    // Original audio actually decoded — not just an AAC stream.
    expect(lvl?.max).toBeGreaterThan(-40);
  }, 240_000);

  test("B: one video clip with original audio disabled → intentionally silent", async () => {
    await newProject("M47.2-B muted source audio");
    await setTimeline([clipCore({ trackId: "v1", sourceAssetId: sharedAssets.t2, sourceInFrame: 0, sourceOutFrame: 120, timelineDurationFrames: 120, muted: true })]);
    const { exportPath, jobLog } = await renderAndWait();
    const probe = ffprobeJson(exportPath);
    const lvl = audioLevels(exportPath);
    const result = { case: "B", jobLog, durationSec: probe.format.duration, audio: lvl, frame: frameRGB(exportPath, 1) };
    saveEvidence("case-B.json", result);
    // The AAC stream exists (silence bed), but decoded signal is digital silence.
    expect(lvl?.max).toBeLessThan(-70);
    // Video content still present (muted ≠ black).
    expect(result.frame.r + result.frame.g + result.frame.b).toBeGreaterThan(60);
  }, 240_000);

  test("C: one video source reused multiple times — each range shows ITS intended imagery", async () => {
    await newProject("M47.2-C reused source");
    const v = sharedAssets.cycler; // 0–2 s red, 2–4 s green, 4–6 s blue
    await setTimeline([
      clipCore({ id: "cc1", trackId: "v1", sourceAssetId: v, sourceInFrame: 0, sourceOutFrame: 60, timelineStartFrame: 0, timelineDurationFrames: 60 }),
      clipCore({ id: "cc2", trackId: "v1", sourceAssetId: v, sourceInFrame: 60, sourceOutFrame: 120, timelineStartFrame: 60, timelineDurationFrames: 60 }),
      clipCore({ id: "cc3", trackId: "v1", sourceAssetId: v, sourceInFrame: 120, sourceOutFrame: 180, timelineStartFrame: 120, timelineDurationFrames: 60 }),
    ]);
    const { exportPath, jobLog } = await renderAndWait();
    const samples = { red: frameRGB(exportPath, 1), green: frameRGB(exportPath, 3), blue: frameRGB(exportPath, 5) };
    const lvl = audioLevels(exportPath);
    const result = { case: "C", jobLog, samples, audio: lvl };
    saveEvidence("case-C.json", result);
    expect(frameIsNear(samples.red, RED)).toBe(true);
    expect(frameIsNear(samples.green, GREEN, 90)).toBe(true);
    expect(frameIsNear(samples.blue, BLUE)).toBe(true);
    expect(lvl?.max).toBeGreaterThan(-40); // source audio present in every reuse
  }, 240_000);

  test("D: multiple distinct sources in sequence — each segment from its own source", async () => {
    await newProject("M47.2-D distinct sources");
    await setTimeline([
      clipCore({ id: "d1", trackId: "v1", sourceAssetId: sharedAssets.smpte, sourceInFrame: 0, sourceOutFrame: 90, timelineStartFrame: 0, timelineDurationFrames: 90 }),
      clipCore({ id: "d2", trackId: "v1", sourceAssetId: sharedAssets.mandel, sourceInFrame: 0, sourceOutFrame: 90, timelineStartFrame: 90, timelineDurationFrames: 90 }),
      clipCore({ id: "d3", trackId: "v1", sourceAssetId: sharedAssets.t2, sourceInFrame: 0, sourceOutFrame: 90, timelineStartFrame: 180, timelineDurationFrames: 90 }),
    ]);
    const { exportPath, jobLog } = await renderAndWait();
    const s1 = frameRGB(exportPath, 1);
    const s2 = frameRGB(exportPath, 4);
    const s3 = frameRGB(exportPath, 7);
    const result = { case: "D", jobLog, samples: [s1, s2, s3], audio: audioLevels(exportPath) };
    saveEvidence("case-D.json", result);
    const dist = (a: typeof s1, b: typeof s1) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
    // Segments differ pairwise (each source really supplied its own imagery).
    expect(dist(s1, s2)).toBeGreaterThan(30);
    expect(dist(s2, s3)).toBeGreaterThan(30);
    expect(dist(s1, s3)).toBeGreaterThan(30);
    expect(result.audio?.max).toBeGreaterThan(-40);
  }, 240_000);

  test("E: video WITH source audio + separate music — both signals audible", async () => {
    await newProject("M47.2-E video+music");
    const audioTrack = { id: "a1", name: "A1", kind: "AUDIO", visible: true, muted: false, solo: false, locked: false, volume: 1 };
    await setTimeline(
      [clipCore({ id: "e1", trackId: "v1", sourceAssetId: sharedAssets.cycler, sourceInFrame: 0, sourceOutFrame: 120, timelineDurationFrames: 120 })],
      [audioTrack],
    );
    // Add the music clip onto the audio track (A1 exists in the default sequence too; use it).
    const h = await head();
    const aTrack = h.sequence.tracks.find((t) => t.kind === "AUDIO");
    await setTimeline([clipCore({ id: "e2", trackId: aTrack!.id, sourceAssetId: sharedAssets.music, sourceInFrame: 0, sourceOutFrame: 120, timelineDurationFrames: 120 })]);
    const { exportPath, jobLog } = await renderAndWait();
    const lvl = audioLevels(exportPath);
    const result = { case: "E", jobLog, audio: lvl, eMean: lvl!.mean };
    saveEvidence("case-E.json", result);
    expect(lvl?.max).toBeGreaterThan(-40);
  }, 240_000);

  test("F: video WITHOUT source audio + music — music only (level below E's summed mix)", async () => {
    await newProject("M47.2-F silentvideo+music");
    await setTimeline([clipCore({ id: "f1", trackId: "v1", sourceAssetId: sharedAssets.silent, sourceInFrame: 0, sourceOutFrame: 120, timelineDurationFrames: 120 })]);
    const h = await head();
    const aTrack = h.sequence.tracks.find((t) => t.kind === "AUDIO");
    await setTimeline([clipCore({ id: "f2", trackId: aTrack!.id, sourceAssetId: sharedAssets.music, sourceInFrame: 0, sourceOutFrame: 120, timelineDurationFrames: 120 })]);
    const { exportPath, jobLog } = await renderAndWait();
    const lvl = audioLevels(exportPath);
    const e = JSON.parse(fs.readFileSync(path.join(EVIDENCE, "case-E.json"), "utf8")) as { eMean: number };
    const result = { case: "F", jobLog, audio: lvl, eMeanForComparison: e.eMean };
    saveEvidence("case-F.json", result);
    expect(lvl?.max).toBeGreaterThan(-40); // music present
    // E summed two independent signals (+3 dB power); F carries music only.
    expect(e.eMean - lvl!.mean).toBeGreaterThan(1.5);
    // Video content from the video-only source is present.
    expect(frameRGB(exportPath, 1).r + frameRGB(exportPath, 1).g + frameRGB(exportPath, 1).b).toBeGreaterThan(60);
  }, 240_000);

  test("G: audio-only timeline → WAV export with real signal, no video stream", async () => {
    await newProject("M47.2-G audio-only");
    const h = await head();
    const aTrack = h.sequence.tracks.find((t) => t.kind === "AUDIO");
    await setTimeline([clipCore({ id: "g1", trackId: aTrack!.id, sourceAssetId: sharedAssets.music, sourceInFrame: 0, sourceOutFrame: 120, timelineDurationFrames: 120 })]);
    const { exportPath, jobLog } = await renderAndWait("wav");
    const probe = ffprobeJson(exportPath);
    const lvl = audioLevels(exportPath);
    const result = { case: "G", jobLog, streams: probe.streams.map((s) => s.codec_type), audio: lvl, durationSec: probe.format.duration };
    saveEvidence("case-G.json", result);
    expect(probe.streams.some((s) => s.codec_type === "video")).toBe(false);
    expect(probe.streams.find((s) => s.codec_type === "audio")?.codec_name).toBe("pcm_s16le");
    expect(lvl?.max).toBeGreaterThan(-40);
    expect(Math.abs(Number(probe.format.duration) - 4)).toBeLessThan(0.5);
  }, 240_000);

  test("H: image base + image overlay composition — both images visible in their windows", async () => {
    await newProject("M47.2-H image overlay");
    const overlayTrack = { id: "ov1", name: "OV1", kind: "OVERLAY", visible: true, muted: false, solo: false, locked: false };
    await setTimeline([
      clipCore({ id: "h1", trackId: "v1", sourceAssetId: sharedAssets.red, sourceInFrame: 0, sourceOutFrame: 120, timelineDurationFrames: 120, sourceFps: { num: 30, den: 1 } }),
    ], [overlayTrack]);
    await setTimeline([
      clipCore({ id: "h2", trackId: "ov1", sourceAssetId: sharedAssets.blue, sourceInFrame: 0, sourceOutFrame: 120, timelineDurationFrames: 120, sourceFps: { num: 30, den: 1 }, timelineStartFrame: 60 }),
    ]);
    const { exportPath, jobLog } = await renderAndWait();
    const early = frameRGB(exportPath, 1); // base only → red
    const late = frameRGB(exportPath, 3); // blue overlay on top → blue
    const result = { case: "H", jobLog, early, late, audio: audioLevels(exportPath) };
    saveEvidence("case-H.json", result);
    expect(frameIsNear(early, RED)).toBe(true);
    expect(frameIsNear(late, BLUE)).toBe(true);
  }, 240_000);

  test("I: transition between multiple clips — real cross-dissolve blend, correct duration", async () => {
    await newProject("M47.2-I transitions");
    const vTrack = (await head()).sequence.tracks.find((t) => t.kind === "VIDEO")!.id;
    // Overlap semantics: A ends at the transition END (75), B starts at the
    // transition START (60) — a real 15-frame cross-dissolve range.
    const c1 = clipCore({ id: "i1", trackId: vTrack, sourceAssetId: sharedAssets.cycler, sourceInFrame: 0, sourceOutFrame: 75, timelineStartFrame: 0, timelineDurationFrames: 75 });
    const c2 = clipCore({ id: "i2", trackId: vTrack, sourceAssetId: sharedAssets.cycler, sourceInFrame: 75, sourceOutFrame: 150, timelineStartFrame: 60, timelineDurationFrames: 75 });
    await setTimeline([c1, c2], [], [{ type: "AddTransition", transitionId: "tr1", trackId: vTrack, kind: "CROSS_DISSOLVE", startFrame: 60, durationFrames: 15 }]);
    const { exportPath, jobLog } = await renderAndWait();
    const probe = ffprobeJson(exportPath);
    const before = frameRGB(exportPath, 1.2); // inside clip 1 → red-ish
    const mid = frameRGB(exportPath, 2.25); // mid-transition (67.5f) → blend, not pure
    const after = frameRGB(exportPath, 3.4); // inside clip 2 → green-ish
    const result = { case: "I", jobLog, durationSec: probe.format.duration, before, mid, after };
    saveEvidence("case-I.json", result);
    expect(Math.abs(Number(probe.format.duration) - 4.5)).toBeLessThan(0.6);
    expect(frameIsNear(before, RED)).toBe(true);
    expect(frameIsNear(after, GREEN, 90)).toBe(true);
    // Mid-dissolve is a BLEND: measurably different from both pure colours.
    const midIsPureRed = frameIsNear(mid, RED, 30);
    const midIsPureGreen = frameIsNear(mid, GREEN, 30);
    expect(midIsPureRed || midIsPureGreen).toBe(false);
    expect(mid.r + mid.g + mid.b).toBeGreaterThan(60); // not black either
  }, 240_000);

  test("J: long-form render >240 s — windowed path, content correct across windows", async () => {
    await newProject("M47.2-J long-form");
    await setTimeline([clipCore({ id: "j1", trackId: "v1", sourceAssetId: sharedAssets.longcycler, sourceInFrame: 0, sourceOutFrame: 7560, timelineDurationFrames: 7560 })]);
    const { exportPath, jobLog } = await renderAndWait(undefined, 900);
    const probe = ffprobeJson(exportPath);
    // longcycler: red 0–84 s, green 84–168 s, blue 168–252 s — sample inside
    // three different 60 s render windows (window boundaries at 60/120/180/240).
    const red = frameRGB(exportPath, 30);   // window 1
    const green = frameRGB(exportPath, 120); // window 3
    const blue = frameRGB(exportPath, 240); // window 5
    const lvl = audioLevels(exportPath);
    const result = { case: "J", jobLog, durationSec: probe.format.duration, samples: { red, green, blue }, audio: lvl };
    saveEvidence("case-J.json", result);
    expect(Math.abs(Number(probe.format.duration) - 252)).toBeLessThan(252 * 0.02);
    expect(frameIsNear(red, RED)).toBe(true);
    expect(frameIsNear(green, GREEN, 90)).toBe(true);
    expect(frameIsNear(blue, BLUE)).toBe(true);
    expect(lvl?.max).toBeGreaterThan(-40);
  }, 900_000);

  test("K (negative): timeline referencing a missing asset FAILS clearly — never black output", async () => {
    await newProject("M47.2-K missing asset negative");
    // Build a real clip, then point its asset id at a row that does not exist.
    await setTimeline([clipCore({ id: "k1", trackId: "v1", sourceAssetId: "does_not_exist_asset", sourceInFrame: 0, sourceOutFrame: 60, timelineDurationFrames: 60 })]);
    const r = await api("POST", `/api/editor/projects/${currentProjectId}/render`, {});
    expect(r.status).toBe(202);
    const jobId = r.json?.jobId as string;
    for (;;) {
      const g = await api("GET", `/api/jobs/${jobId}`);
      const job = g.json?.job ?? g.json;
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(String(job?.status))) {
        const result = { case: "K-negative", jobId, status: job?.status, message: job?.message };
        saveEvidence("case-K.json", result);
        expect(job?.status).toBe("FAILED");
        expect(String(job?.message)).toMatch(/could not be resolved|missing/i);
        break;
      }
      await new Promise((res) => setTimeout(res, 1000));
    }
  }, 180_000);
});
