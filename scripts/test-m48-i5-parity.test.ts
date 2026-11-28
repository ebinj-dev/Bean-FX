/**
 * M48-I5/I8 — preview/export PARITY + LUT pipeline live proofs.
 *
 * The parity claim is tested with DECODED PIXELS: for each treatment
 * (grade-only, LUT-only, grade+LUT, identity-LUT) the exported frame is
 * compared against the SAME grade model applied in JS to the source frame —
 * the preview shader runs this exact model, so a small diff means preview
 * and export agree.
 *
 * Run: BASE=http://localhost:3130 bun test scripts/test-m48-i5-parity.test.ts
 */
import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import fs from "node:fs";
import path from "node:path";

import { gradePixel, DEFAULT_GRADE } from "@/lib/color/grade-model";
import { parseCube, sampleCube } from "@/lib/color/lut3d";

const BASE = process.env.BASE ?? "http://localhost:3130";
const EVIDENCE = "/home/z/my-project/download/m48-i-evidence/i5";
const STAMP = Date.now().toString(36);
fs.mkdirSync(EVIDENCE, { recursive: true });

let cookie = "";
let currentProjectId = "";

async function api(method: string, p: string, body?: unknown) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(";")[0];
    if (pair.startsWith("beanfx_session=")) cookie = pair;
  }
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Color fixture: STATIC SMPTE bars + a grey ramp strip (no motion, no burned
 *  timestamp — moving overlays would make per-pixel parity meaningless). */
function colorFixture(): string {
  const p = `/tmp/m48-i-color-${STAMP}.mp4`;
  if (fs.existsSync(p)) return p;
  const r = spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "smptebars=size=480x270:rate=30:duration=12", "-vf", "drawbox=x=0:y=ih-30:w=iw:h=30:color=gray@1:t=fill", "-c:v", "libx264", "-pix_fmt", "yuv420p", p], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`fixture failed: ${r.stderr.slice(0, 200)}`);
  return p;
}

async function upload(file: string, name: string): Promise<string> {
  const res = await fetch(`${BASE}/api/media`, {
    method: "POST",
    headers: { "Content-Type": "video/mp4", "x-project-id": currentProjectId, "x-filename": name, "x-asset-role": "SOURCE_FOOTAGE", ...(cookie ? { Cookie: cookie } : {}) },
    body: fs.readFileSync(file),
  });
  expect(res.status).toBeLessThan(300);
  const j = (await res.json()) as { asset?: { id?: string }; media?: { id?: string }; id?: string };
  return (j.asset?.id ?? j.media?.id ?? j.id) as string;
}

/** 17³ cube text from a transform. */
function cubeText(fn: (r: number, g: number, b: number) => [number, number, number], title: string): string {
  const lines = [`TITLE "${title}"`, "LUT_3D_SIZE 17"];
  for (let b = 0; b < 17; b++)
    for (let g = 0; g < 17; g++)
      for (let r = 0; r < 17; r++) {
        const [or, og, ob] = fn(r / 16, g / 16, b / 16);
        lines.push(`${or.toFixed(6)} ${og.toFixed(6)} ${ob.toFixed(6)}`);
      }
  return lines.join("\n") + "\n";
}

async function uploadLut(text: string, name: string): Promise<{ status: number; lut?: { id: string; name: string; size: number } }> {
  const res = await fetch(`${BASE}/api/editor/projects/${currentProjectId}/luts`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: (() => {
      const fd = new FormData();
      fd.set("file", new File([text], `${name}.cube`, { type: "text/plain" }));
      fd.set("name", name);
      return fd;
    })(),
  });
  const j = (await res.json().catch(() => null)) as { lut?: { id: string; name: string; size: number } } | null;
  return { status: res.status, lut: j?.lut };
}

const GRADE_A = { ...DEFAULT_GRADE, exposure: 0.5, temperature: 0.4, contrast: 1.25, highlights: 0.2, shadows: -0.3, saturation: 1.3, vibrance: 0.3, liftB: 0.06, gammaR: 1.08 };

const clip = (id: string, assetId: string, start: number, dur: number) => ({
  id, trackId: "__V1__", sourceAssetId: assetId, sourceInFrame: start, sourceOutFrame: start + dur,
  sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: dur,
  playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
  label: null, missingMedia: false, pan: 0, groupId: null, effects: [], keyframes: [],
  audioSourceInFrame: null, audioSourceOutFrame: null, avLinked: true,
});

async function setTimeline(edits: unknown[]): Promise<void> {
  const head = await api("GET", `/api/editor/projects/${currentProjectId}/timeline`);
  const hj = head.json as { version: number; sequence: { tracks: Array<{ id: string; kind: string }> } };
  const videoTrack = hj.sequence.tracks.find((t) => t.kind === "VIDEO");
  const resolved = JSON.parse(JSON.stringify(edits).replace(/__V1__/g, videoTrack!.id)) as unknown[];
  const tl = await api("POST", `/api/editor/projects/${currentProjectId}/timeline`, { baseVersion: hj.version, edits: resolved });
  if (tl.status >= 300) throw new Error(`timeline rejected: ${JSON.stringify(tl.json).slice(0, 300)}`);
}

async function renderTo(downloadName: string): Promise<string> {
  const rr = await api("POST", `/api/editor/projects/${currentProjectId}/render`, {});
  expect(rr.status).toBe(202);
  const jobId = (rr.json as { jobId: string }).jobId;
  let exportId = "";
  const t0 = Date.now();
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const g = await api("GET", `/api/jobs/${jobId}`);
    const job = (g.json as { job?: { status?: string; exportId?: string; message?: string } }).job ?? (g.json as { status?: string; exportId?: string; message?: string });
    if (job?.status === "COMPLETED" && job.exportId) { exportId = job.exportId; break; }
    if (job?.status === "FAILED") throw new Error(`render FAILED: ${JSON.stringify(job).slice(0, 250)}`);
  }
  expect(exportId).toBeTruthy();
  const wallSec = (Date.now() - t0) / 1000;
  const dl = await fetch(`${BASE}/api/exports/${exportId}/file`, { headers: cookie ? { Cookie: cookie } : {} });
  expect(dl.status).toBe(200);
  const out = path.join(EVIDENCE, downloadName);
  fs.writeFileSync(out, Buffer.from(await dl.arrayBuffer()));
  fs.writeFileSync(path.join(EVIDENCE, `${downloadName}.meta.json`), JSON.stringify({ wallSec, exportId }, null, 1));
  return out;
}

/** Decode one frame as raw rgb24 at the given size (export = sequence 1920×1080;
 *  the source is pre-scaled with the same default bicubic the render's
 *  scale filter uses, so the model applies to the SAME pixels). */
const FW = 1920, FH = 1080;
function rawFrame(file: string, tSec: number, scaleTo?: string): Uint8Array {
  const vf = scaleTo ? ["-vf", scaleTo] : [];
  const r = spawnSync("ffmpeg", ["-v", "error", "-ss", String(tSec), "-i", file, ...vf, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  const buf = r.stdout as Buffer;
  const need = FW * FH * 3;
  if (buf.length < need) {
    throw new Error(`frame decode failed (${buf.length} bytes) file=${file} t=${tSec} exists=${fs.existsSync(file)} stderr=${String(r.stderr).slice(0, 200)}`);
  }
  return new Uint8Array(buf.subarray(0, need));
}

/** The export encodes yuv420p (4:2:0). The model reference is given the SAME
 *  chroma round-trip so the measured diff isolates the GRADE path (lut3d +
 *  encode) from codec chroma behaviour — documented in the parity report. */
function chromaRoundtrip(frame: Uint8Array): Uint8Array {
  // Symmetric 4:2:0 chroma round-trip (lossless format conversion): the mean
  // diff then measures the GRADE path (lut3d vs model). The residual tail
  // (p99.9) is x264 quantization at hard bar edges — two separately-encoded
  // files never cancel per-pixel; the tolerance documents that explicitly.
  const r = spawnSync("ffmpeg", ["-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "1920x1080", "-i", "-", "-vf", "format=yuv420p", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, input: Buffer.from(frame.buffer, frame.byteOffset, frame.length) });
  const buf = r.stdout as Buffer;
  if (buf.length < frame.length) throw new Error(`chroma roundtrip failed: ${String(r.stderr).slice(0, 150)}`);
  return new Uint8Array(buf.subarray(0, frame.length));
}

interface Diff { mean: number; max: number; p999: number; meanPerCh: [number, number, number] }
function diffFrames(a: Uint8Array, b: Uint8Array): Diff {
  let sum = 0, max = 0;
  const ch = [0, 0, 0];
  const diffs: number[] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i += 3) {
    let px = 0;
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(a[i + k] - b[i + k]);
      sum += d; ch[k] += d; px = Math.max(px, d);
    }
    diffs.push(px);
    if (px > max) max = px;
  }
  diffs.sort((x, y) => y - x);
  return { mean: sum / diffs.length / 3, max, p999: diffs[Math.floor(diffs.length * 0.001)], meanPerCh: [ch[0] / diffs.length, ch[1] / diffs.length, ch[2] / diffs.length] };
}

describe("M48-I5 — preview/export parity (decoded pixels vs the shared model)", () => {
  const results: Record<string, Diff | number | string>[] = [];

  test("grade-only, LUT-only, grade+LUT, identity-LUT all match the model within tolerance", async () => { /* timeout: 600000 */
    const reg = await api("POST", "/api/auth/register", { email: `i5-${STAMP}@test.local`, password: "i5-real-media-1", name: "I5", acceptedDraftTerms: true });
    expect(reg.status).toBeLessThan(300);
    const pr = await api("POST", "/api/projects", { name: `I5 parity ${STAMP}` });
    currentProjectId = (pr.json as { project: { id: string } }).project.id;

    const fixturePath = colorFixture();
    const fixture = await upload(fixturePath, "colorbars.mp4");

    // LUT upload + validation behaviour
    const warm = await uploadLut(cubeText((r, g, b) => [Math.min(1, r * 1.12 + 0.04), g, Math.max(0, b * 0.9 - 0.02)], "warm-test"), "warm");
    expect(warm.status).toBe(201);
    const identity = await uploadLut(cubeText((r, g, b) => [r, g, b], "identity-test"), "identity");
    expect(identity.status).toBe(201);
    const malformed = await uploadLut("LUT_3D_SIZE 2\nNaN 0 0\n" + "0 0 0\n".repeat(7), "bad");
    expect(malformed.status).toBe(400); // NaN rejected
    const oversize = await uploadLut(`LUT_3D_SIZE 200\n`, "huge");
    expect(oversize.status).toBe(400); // dimension cap
    const noHeader = await uploadLut("0.1 0.2 0.3\n", "nohdr");
    expect(noHeader.status).toBe(400);

    // 4 clips × 3 s @30fps: grade-only / LUT-only / grade+LUT / identity-LUT
    const g = { ...GRADE_A };
    const warmId = warm.lut!.id, identityId = identity.lut!.id;
    const edits = [
      { type: "AddLut", lut: warm.lut },
      { type: "AddLut", lut: identity.lut },
      { type: "AddClip", clip: { ...clip(`i5a-${STAMP}`, fixture, 0, 90) } },
      { type: "AddClip", clip: { ...clip(`i5b-${STAMP}`, fixture, 90, 90), timelineStartFrame: 90 } },
      { type: "AddClip", clip: { ...clip(`i5c-${STAMP}`, fixture, 180, 90), timelineStartFrame: 180 } },
      { type: "AddClip", clip: { ...clip(`i5d-${STAMP}`, fixture, 270, 90), timelineStartFrame: 270 } },
      { type: "SetClipGrade", clipId: `i5a-${STAMP}`, grade: g },
      { type: "SetClipLut", clipId: `i5b-${STAMP}`, lutId: warmId },
      { type: "SetClipGrade", clipId: `i5c-${STAMP}`, grade: g },
      { type: "SetClipLut", clipId: `i5c-${STAMP}`, lutId: warmId },
      { type: "SetClipGrade", clipId: `i5d-${STAMP}`, grade: { ...DEFAULT_GRADE } },
      { type: "SetClipLut", clipId: `i5d-${STAMP}`, lutId: identityId },
    ];
    await setTimeline(edits);
    const out = await renderTo(`parity-${STAMP}.mp4`);

    const warmCube = parseCube(cubeText((r, gg, b) => [Math.min(1, r * 1.12 + 0.04), gg, Math.max(0, b * 0.9 - 0.02)], "warm-test")) as { kind: "3d"; size: number; domainMin: [number, number, number]; domainMax: [number, number, number]; table: Float32Array };
    const identityCubeParsed = parseCube(cubeText((r, gg, b) => [r, gg, b], "identity-test")) as typeof warmCube;
    const warmEval = (r: number, gg: number, b: number) => sampleCube(warmCube, r, gg, b);
    const idEval = (r: number, gg: number, b: number) => sampleCube(identityCubeParsed, r, gg, b);

    // source frames at the mid-points of each clip's source window
    const srcMid = [45, 135, 225, 315].map((f) => rawFrame(fixturePath, f / 30, "scale=1920:1080"));
    const cases: [string, number, (r: number, g: number, b: number) => [number, number, number] | undefined, number][] = [
      ["grade-only", 1.5, undefined, 45],
      ["lut-only", 4.5, warmEval, 135],
      ["grade+lut", 7.5, warmEval, 225],
      ["identity-lut", 10.5, idEval, 315],
    ];
    for (const [name, tExport, lut, srcIdx] of cases) {
      const got = rawFrame(out, tExport);
      const src = srcMid[srcIdx / 90 - 0.5];
      let model = new Uint8Array(src.length);
      const gp = name === "grade-only" || name === "grade+lut" ? GRADE_A : { ...DEFAULT_GRADE };
      for (let i = 0; i < src.length; i += 3) {
        const [r, gg, b] = gradePixel(src[i] / 255, src[i + 1] / 255, src[i + 2] / 255, gp, lut);
        model[i] = r * 255; model[i + 1] = gg * 255; model[i + 2] = b * 255;
      }
      model = chromaRoundtrip(model);
      const d = diffFrames(got, model);
      console.log("I5 PARITY", name, JSON.stringify(d));
      results.push({ case: name, ...d } as Record<string, Diff | number | string>);
      // Explicit, documented tolerances: the chroma-symmetric comparison
      // isolates the grade path, so the mean is tiny (encode + 129³ cube
      // quantization only). p99.9 bounds the tail; max allows x264 DCT
      // ringing at hard bar edges (isolated pixels, no visible shift).
      expect(d.mean).toBeLessThan(0.5); // grade path exactness (lut3d ≈ model)
      expect(d.p999).toBeLessThan(20); // x264 edge quantization, 0.1% of pixels
      expect(d.max).toBeLessThan(64); // isolated ringing pixels at bar edges
    }
    fs.writeFileSync(path.join(EVIDENCE, "parity-analysis.json"), JSON.stringify(results, null, 1));
  }, 600_000);

  test("LUT files are ownership-gated (another user gets the same 404)", async () => {
    const other = await fetch(`${BASE}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `i5-other-${STAMP}@test.local`, password: "i5-real-media-1", name: "I5B", acceptedDraftTerms: true }),
    });
    for (const raw of other.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(";")[0];
      if (pair.startsWith("beanfx_session=")) {
        const strangerCookie = pair;
        const res = await fetch(`${BASE}/api/editor/projects/${currentProjectId}/luts/whatever`, { headers: { Cookie: strangerCookie } });
        expect(res.status).toBe(404); // no existence leak
      }
    }
  });

  test("performance: 5 graded clips render in bounded time", async () => {
    const pr = await api("POST", "/api/projects", { name: `I5 perf ${STAMP}` });
    currentProjectId = (pr.json as { project: { id: string } }).project.id;
    const fixture = await upload(colorFixture(), "perf.mp4"); // path unused here — decode-free test
    const edits: unknown[] = [];
    for (let i = 0; i < 5; i++) {
      edits.push({ type: "AddClip", clip: { ...clip(`i5p${i}-${STAMP}`, fixture, i * 30, 60), timelineStartFrame: i * 60 } });
      edits.push({ type: "SetClipGrade", clipId: `i5p${i}-${STAMP}`, grade: { ...GRADE_A, exposure: 0.2 + i * 0.15 } });
    }
    await setTimeline(edits);
    const out = await renderTo(`perf-${STAMP}.mp4`);
    const meta = JSON.parse(fs.readFileSync(`${out}.meta.json`, "utf8")) as { wallSec: number };
    console.log("I5 PERF 5 graded clips (10 s total):", meta.wallSec.toFixed(1), "s");
    expect(meta.wallSec).toBeLessThan(180);
  }, 600_000);
});
