/**
 * BEAN FX — M39 §7 live integration: per-item batch timeline ranges.
 *
 * Against a REAL server (BASE env, default :3121) with real FFmpeg:
 *  - each batch item may carry its OWN start/end frames (mixed formats AND
 *    independent ranges in ONE batch) through the SAME durable
 *    RENDER_TIMELINE jobs and FFmpeg graph,
 *  - invalid items (reversed, out-of-bounds, negative/malformed, mixed
 *    request forms) reject the WHOLE request with per-item reasons and no
 *    partial enqueue (all-or-nothing),
 *  - the M38 common-range form is preserved (backward compatibility),
 *  - duplicate protection distinguishes genuinely different ranges,
 *  - outputs are validated with ffprobe: actual durations match each item's
 *    requested range (± frame/audio-sample tolerance) and stream types match
 *    the requested format,
 *  - the retry path preserves a failed/cancelled item's range.
 *
 * Run (server on :3121 with an isolated DB):
 *   BASE=http://127.0.0.1:3121 bun test scripts/test-m39-batch-ranges.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:3121";
const STAMP = Date.now().toString(36);
const EMAIL = `m39ranges-${STAMP}@test.local`;
const PW = "ranges-pass-99";
const FPS = 30;
const SEQ_FRAMES = 3 * FPS; // 3 s fixture → 90-frame sequence
let cookie = "";
const OUT = "/home/z/my-project/m39-evidence";
fs.mkdirSync(OUT, { recursive: true });

async function api(method: string, p: string, body?: unknown, raw?: Buffer, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extraHeaders };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${p}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const set = res.headers.getSetCookie?.() ?? [];
  for (const kv of set) {
    const [k, v] = kv.split(";")[0].split("=");
    if (k === "beanfx_session" && v) cookie = `${k}=${v}`;
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

function makeFixture(sec: number, tag: string): string {
  const p = `/tmp/m39-range-fixture-${tag}.mp4`;
  execSync(`ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=480x270:rate=30:duration=${sec}" -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=${sec}" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest "${p}"`);
  return p;
}

const TRACKS = [
  { id: "v1", name: "V1", kind: "VIDEO", visible: true, muted: false, solo: false, locked: false },
  { id: "a1", name: "A1", kind: "AUDIO", visible: true, muted: false, solo: false, locked: false },
];
function clip(id: string, trackId: string, assetId: string, startSec: number, lenSec: number) {
  return {
    id, trackId, sourceAssetId: assetId, sourceInFrame: 0, sourceOutFrame: Math.round(lenSec * FPS),
    sourceFps: { num: FPS, den: 1 }, timelineStartFrame: Math.round(startSec * FPS), timelineDurationFrames: Math.round(lenSec * FPS),
    playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
    keyframes: [], missingMedia: false,
  };
}

interface BatchItem { format: string; jobId: string; status: string; progress: number; stage: string | null; range?: { startFrame?: number; endFrame?: number } | null; export: { id: string; filename: string; sizeBytes: number; durationSec: number | null; format: string } | null }
interface BatchState { items: BatchItem[]; batch: { total: number; completed: number; failed: number; cancelled: number; active: number; batchComplete: boolean; allSucceeded: boolean } }

async function batchState(projectId: string): Promise<BatchState> {
  const res = await api("GET", `/api/editor/projects/${projectId}/render/batch`);
  expect(res.status).toBe(200);
  return res.json as BatchState;
}

async function waitAllTerminal(projectId: string, timeoutMs: number): Promise<BatchState> {
  const t0 = Date.now();
  let last: BatchState | null = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await batchState(projectId);
    if (last.batch.batchComplete) return last;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return last as BatchState;
}

/** ffprobe: container duration + stream layout of a downloaded output. */
function probe(file: string): { duration: number; streams: Array<{ codec_type: string; codec_name: string }> } {
  const meta = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-show_streams", "-of", "json", file]).toString()) as { format?: { duration?: string }; streams: Array<{ codec_type: string; codec_name: string }> };
  return { duration: Number(meta.format?.duration ?? 0), streams: meta.streams };
}

const MIXED_ITEMS = [
  { format: "mov", startFrame: 0, endFrame: 30 },
  { format: "wav", startFrame: 30, endFrame: 90 },
  { format: "mp4", startFrame: 0, endFrame: 60 },
  { format: "mp3", startFrame: 45, endFrame: 90 },
];
/** expected duration seconds per (format, range) at the ±frame/sample tolerance. */
function expectedDuration(range: { startFrame?: number; endFrame?: number }): number {
  return ((range.endFrame ?? SEQ_FRAMES) - (range.startFrame ?? 0)) / FPS;
}

beforeAll(async () => {
  const reg = await api("POST", "/api/auth/register", { email: EMAIL, password: PW, name: "M39 Ranges" });
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register failed: ${reg.status} ${reg.text.slice(0, 200)}`);
  await api("POST", "/api/auth/login", { email: EMAIL, password: PW });
});

describe("M39 live — per-item batch timeline ranges through the durable pipeline", () => {
  let projectId = "";

  test("setup: project, real media fixture, sequence", async () => {
    const proj = await api("POST", "/api/projects", { name: `M39 ranges ${STAMP}` });
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

  test("validation: reversed / out-of-bounds / malformed / mixed forms reject the WHOLE request with per-item reasons and NOTHING enqueued", async () => {
    const before = await batchState(projectId);
    expect(before.items.length).toBe(0);
    const cases: Array<{ body: object; reason: string }> = [
      { body: { items: [{ format: "mp4", startFrame: 60, endFrame: 30 }] }, reason: "reversed" },
      { body: { items: [{ format: "mov", startFrame: 0, endFrame: 30 }, { format: "wav", endFrame: 900 }] }, reason: "out of bounds" },
      { body: { items: [{ format: "mp3", startFrame: -1 }] }, reason: "Invalid request" },
      { body: { items: [{ format: "mp4", startFrame: 1.5 }] }, reason: "Invalid request" },
      { body: { formats: ["mp4"], items: [{ format: "mp4" }] }, reason: "not both" },
      { body: { items: [{ format: "mp4", startFrame: 95 }] }, reason: "out of bounds" },
    ];
    const evidence: Array<{ body: object; status: number; rejected?: unknown }> = [];
    for (const c of cases) {
      const res = await api("POST", `/api/editor/projects/${projectId}/render/batch`, c.body);
      expect(res.status).toBe(400);
      expect((res.json as { error?: string }).error ?? "").toContain(c.reason);
      evidence.push({ body: c.body, status: res.status, rejected: (res.json as { rejected?: unknown }).rejected });
    }
    const after = await batchState(projectId);
    expect(after.items.length).toBe(0); // all-or-nothing: no partial submission
    fs.writeFileSync(path.join(OUT, `m39-ranges-reject-${STAMP}.json`), JSON.stringify(evidence, null, 1));
  });

  test("mixed-format, independent-range batch enqueues four independent durable jobs with their own ranges", async () => {
    const res = await api("POST", `/api/editor/projects/${projectId}/render/batch`, { items: MIXED_ITEMS });
    expect(res.status).toBe(202);
    const body = res.json as { batch: Array<{ format: string; jobId: string; reused: boolean; range: { startFrame?: number; endFrame?: number } }>; rejected: unknown[] };
    expect(body.batch.length).toBe(4);
    expect(body.rejected).toEqual([]);
    expect(body.batch.every((b) => !b.reused && b.jobId)).toBe(true);
    for (let i = 0; i < MIXED_ITEMS.length; i++) {
      expect(body.batch[i].format).toBe(MIXED_ITEMS[i].format);
      expect(body.batch[i].range).toEqual({ startFrame: MIXED_ITEMS[i].startFrame, endFrame: MIXED_ITEMS[i].endFrame });
    }
    fs.writeFileSync(path.join(OUT, `m39-ranges-enqueue-${STAMP}.json`), JSON.stringify(body, null, 1));
  });

  test("duplicate protection: identical ranges reuse; a genuinely different range is a distinct identity", async () => {
    const same = await api("POST", `/api/editor/projects/${projectId}/render/batch`, { items: MIXED_ITEMS });
    expect(same.status).toBe(202);
    const sameBody = same.json as { batch: Array<{ format: string; reused: boolean }> };
    expect(sameBody.batch.length).toBe(4);
    expect(sameBody.batch.every((b) => b.reused)).toBe(true);

    const changed = await api("POST", `/api/editor/projects/${projectId}/render/batch`, { items: [...MIXED_ITEMS.slice(0, 2), { format: "mp4", startFrame: 60, endFrame: 90 }, MIXED_ITEMS[3]] });
    expect(changed.status).toBe(202);
    const changedBody = changed.json as { batch: Array<{ format: string; reused: boolean; range: { startFrame?: number; endFrame?: number } }> };
    expect(changedBody.batch.length).toBe(4);
    const freshMp4 = changedBody.batch.find((b) => b.format === "mp4");
    expect(freshMp4?.reused).toBe(false); // 60–90 differs from the active 0–60 item
    expect(freshMp4?.range).toEqual({ startFrame: 60, endFrame: 90 });
    expect(changedBody.batch.filter((b) => b.format !== "mp4").every((b) => b.reused)).toBe(true);
  });

  test("legacy common-range form still works (M38 backward compatibility, range echoed per item)", async () => {
    const res = await api("POST", `/api/editor/projects/${projectId}/render/batch`, { formats: ["mp4"], startFrame: 0, endFrame: 30 });
    expect(res.status).toBe(202);
    const body = res.json as { batch: Array<{ format: string; reused: boolean; range: { startFrame?: number; endFrame?: number } }>; range: { startFrame?: number; endFrame?: number } };
    expect(body.batch.length).toBe(1);
    expect(body.batch[0].range).toEqual({ startFrame: 0, endFrame: 30 });
  });

  test("all items complete and EVERY output's ffprobe duration + stream layout matches its requested format and range", async () => {
    const state = await waitAllTerminal(projectId, 420_000);
    expect(state.batch.batchComplete).toBe(true);
    expect(state.batch.allSucceeded).toBe(true);
    expect(state.batch.completed).toBe(state.batch.total);
    fs.writeFileSync(path.join(OUT, `m39-ranges-final-${STAMP}.json`), JSON.stringify(state, null, 1));

    const results: Array<{ format: string; range: { startFrame?: number; endFrame?: number }; expectedSec: number; actualSec: number; streams: string[] }> = [];
    for (const item of state.items) {
      if (item.status === "CANCELLED") {
        expect(item.export).toBeNull(); // a cancelled item never publishes an output
        continue;
      }
      expect(item.export, `${item.format} ${JSON.stringify(item.range)}`).toBeTruthy();
      const file = `/tmp/m39-range-out-${item.format}-${item.range?.startFrame ?? "0"}-${item.range?.endFrame ?? "end"}-${STAMP}.${item.format}`;
      const dl = await fetch(`${BASE}/api/exports/${item.export!.id}/file`, { headers: { Cookie: cookie } });
      expect(dl.status).toBe(200);
      fs.writeFileSync(file, Buffer.from(await dl.arrayBuffer()));
      const p = probe(file);
      const expected = expectedDuration(item.range ?? {});
      expect(Math.abs(p.duration - expected)).toBeLessThan(0.3); // frame + audio-sample tolerance
      if (item.format === "wav") {
        expect(p.streams.length).toBe(1);
        expect(p.streams[0].codec_type).toBe("audio");
        expect(p.streams[0].codec_name).toBe("pcm_s16le");
      } else if (item.format === "mp3") {
        expect(p.streams.length).toBe(1);
        expect(p.streams[0].codec_type).toBe("audio");
        expect(p.streams[0].codec_name).toBe("mp3");
      } else {
        expect(p.streams.some((s) => s.codec_type === "video")).toBe(true);
        expect(p.streams.some((s) => s.codec_type === "audio")).toBe(true);
      }
      results.push({ format: item.format, range: item.range ?? {}, expectedSec: expected, actualSec: p.duration, streams: p.streams.map((s) => `${s.codec_type}:${s.codec_name}`) });
    }
    expect(results.length).toBeGreaterThanOrEqual(6); // 4 mixed + changed mp4 range + legacy mp4
    fs.writeFileSync(path.join(OUT, `m39-ranges-probe-${STAMP}.json`), JSON.stringify(results, null, 1));
  }, 480_000); // renders + polling exceed bun's 5 s default test timeout

  test("retry path preserves the item's range: a cancelled item publishes NOTHING and its resubmission completes the full timeline", async () => {
    const res = await api("POST", `/api/editor/projects/${projectId}/render/batch`, { formats: ["mp4"] }); // full timeline
    expect(res.status).toBe(202);
    const jobId = (res.json as { batch: Array<{ jobId: string }> }).batch[0].jobId;
    const del = await api("DELETE", `/api/jobs/${jobId}`);
    expect([200, 202, 204]).toContain(del.status);
    const resub = await api("POST", `/api/editor/projects/${projectId}/render/batch`, { formats: ["mp4"] });
    expect(resub.status).toBe(202);
    const resubBody = resub.json as { batch: Array<{ reused: boolean; jobId: string }> };
    expect(resubBody.batch[0].reused).toBe(false); // cancelled item is outside the ACTIVE dedup set
    const resubJobId = resubBody.batch[0].jobId;
    expect(resubJobId).not.toBe(jobId);
    await waitAllTerminal(projectId, 120_000);
    const state = await batchState(projectId);
    const cancelled = state.items.find((i) => i.jobId === jobId);
    const redone = state.items.find((i) => i.jobId === resubJobId);
    expect(cancelled?.status).toBe("CANCELLED");
    expect(cancelled?.export).toBeNull(); // a cancelled item never publishes an output
    expect(redone?.status).toBe("COMPLETED");
    expect(redone?.export).toBeTruthy();
    const file = `/tmp/m39-range-retry-full-${STAMP}.mp4`;
    const dl = await fetch(`${BASE}/api/exports/${redone!.export!.id}/file`, { headers: { Cookie: cookie } });
    expect(dl.status).toBe(200);
    fs.writeFileSync(file, Buffer.from(await dl.arrayBuffer()));
    const p = probe(file);
    expect(Math.abs(p.duration - expectedDuration({}))).toBeLessThan(0.3); // full timeline ≈ 3 s
    fs.writeFileSync(path.join(OUT, `m39-ranges-retry-${STAMP}.json`), JSON.stringify({ cancelled: { jobId, status: cancelled?.status }, resubmitted: { jobId: resubJobId, status: redone?.status, durationSec: p.duration } }, null, 1));
  }, 180_000);
});

afterAll(() => {
  try { fs.rmSync(`/tmp/m39-range-fixture-${STAMP}.mp4`, { force: true }); } catch { /* cleanup best-effort */ }
  try { for (const f of fs.readdirSync("/tmp")) if (f.startsWith(`m39-range-out-`) && f.endsWith(`-${STAMP}.*`)) fs.rmSync(path.join("/tmp", f), { force: true }); } catch { /* best-effort */ }
});
