/**
 * M48-H1 — independent A/V editing edges: unit tests on the canonical command
 * pathway + a REAL rendered proof that the export honours the independent
 * audio range (decoded frequency-flip analysis — no mocked media).
 *
 * Unit parts run the real engine (apply/inverse/validation/persistence).
 * The live part runs against BASE (:3130, RATE_LIMIT_SCALE=20): upload a
 * generated fixture whose audio content changes at source 4 s (440→880 Hz),
 * build a 6 s clip whose VIDEO range is 0–6 s but whose AUDIO range is 2–8 s
 * (+2 s sync shift), render, decode, and verify the frequency flip lands at
 * export t≈2 s (not t≈4 s) — the independent audio range is really rendered.
 *
 * Run: BASE=http://localhost:3130 bun test scripts/test-m48-h1-av-split.test.ts
 */
import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import fs from "node:fs";
import path from "node:path";

// ── engine-level unit parts (canonical applyCommand + inverse chain) ─────────
import { applyCommand } from "@/lib/editor/commands";
import { validateSequence } from "@/lib/editor/model";
import type { Sequence } from "@/lib/editor/model";

/** Apply one validated command through the canonical pathway; undo = apply the inverse. */
function apply(seq: Sequence, cmd: unknown): Sequence {
  return applyCommand(seq, cmd).sequence;
}
function undo(seq: Sequence, cmd: unknown): Sequence {
  const { inverse } = applyCommand(seq, cmd);
  let cur = seq;
  for (const inv of inverse) cur = applyCommand(cur, inv).sequence;
  return cur;
}

function baseSeq(): Sequence {
  return {
    id: "seq", name: "H1", fps: { num: 30, den: 1 }, width: 480, height: 270, sampleRate: 48000,
    tracks: [
      { id: "v1", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false, volume: 1 },
      { id: "a1", kind: "AUDIO", name: "A1", visible: true, muted: false, solo: false, locked: false, volume: 1 },
    ],
    clips: [{
      id: "c1", trackId: "a1", sourceAssetId: "asset", sourceInFrame: 0, sourceOutFrame: 180,
      sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 180,
      playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
      label: null, missingMedia: false, pan: 0, groupId: null, effects: [], keyframes: [],
      audioSourceInFrame: null, audioSourceOutFrame: null, avLinked: true,
    }],
    transitions: [], markers: [],
  };
}

describe("M48-H1 — split A/V editing edges (canonical commands)", () => {
  test("unlinking pins the audio range; TrimClipAudioStream shifts it; the video range never moves", () => {
    let seq = apply(baseSeq(), { type: "SetClipAvLink", clipId: "c1", linked: false });
    const c = seq.clips[0];
    expect(c.avLinked).toBe(false);
    expect(c.audioSourceInFrame).toBe(0);
    expect(c.audioSourceOutFrame).toBe(180);
    expect(c.sourceInFrame).toBe(0);
    expect(c.sourceOutFrame).toBe(180);

    // +2 s audio sync shift (source-frame clock): 60..240
    seq = apply(seq, { type: "TrimClipAudioStream", clipId: "c1", newAudioSourceInFrame: 60, newAudioSourceOutFrame: 240 });
    const c2 = seq.clips[0];
    expect(c2.audioSourceInFrame).toBe(60);
    expect(c2.audioSourceOutFrame).toBe(240);
    // video range + timeline window untouched
    expect(c2.sourceInFrame).toBe(0);
    expect(c2.sourceOutFrame).toBe(180);
    expect(c2.timelineStartFrame).toBe(0);
    expect(c2.timelineDurationFrames).toBe(180);
    expect(c2.avLinked).toBe(false);
    // the resulting sequence passes full validation
    const v = validateSequence(seq);
    expect(v.errors).toEqual([]);
  });

  test("undo restores the previous audio range AND link state", () => {
    // Mirrors the engine's EditHistory: inverses are captured per command AT
    // APPLY TIME and undone in reverse order (an idempotent re-apply is a
    // no-op and has no inverse — exactly like the interactive session).
    const r1 = applyCommand(baseSeq(), { type: "SetClipAvLink", clipId: "c1", linked: false });
    const r2 = applyCommand(r1.sequence, { type: "TrimClipAudioStream", clipId: "c1", newAudioSourceInFrame: 60, newAudioSourceOutFrame: 240 });
    // undo the trim → the pinned pre-trim range, still unlinked
    let seq = r2.sequence;
    for (const inv of r2.inverse) seq = applyCommand(seq, inv).sequence;
    let c = seq.clips[0];
    expect(c.audioSourceInFrame).toBe(0);
    expect(c.audioSourceOutFrame).toBe(180);
    expect(c.avLinked).toBe(false);
    // undo the unlink → back to linked with no distinct audio range
    for (const inv of r1.inverse) seq = applyCommand(seq, inv).sequence;
    c = seq.clips[0];
    expect(c.avLinked).toBe(true);
    expect(c.audioSourceInFrame).toBeNull();
    expect(c.audioSourceOutFrame).toBeNull();
  });

  test("validation refuses half-set ranges, linked clips with a distinct range, and empty ranges", () => {
    // half-set
    const s1 = baseSeq();
    s1.clips[0].audioSourceInFrame = 30;
    expect(validateSequence(s1).errors.join(" ")).toContain("BOTH endpoints");
    // linked with distinct range
    const s2 = baseSeq();
    s2.clips[0].audioSourceInFrame = 30;
    s2.clips[0].audioSourceOutFrame = 240;
    expect(validateSequence(s2).errors.join(" ")).toContain("avLinked=true but carries");
    // command-level: empty/inverted range refused
    const seq = apply(baseSeq(), { type: "SetClipAvLink", clipId: "c1", linked: false });
    let threw = "";
    try {
      apply(seq, { type: "TrimClipAudioStream", clipId: "c1", newAudioSourceInFrame: 100, newAudioSourceOutFrame: 100 });
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    expect(threw).toContain("empty or inverted");
  });

  test("JSON persistence round-trips the audio stream fields", () => {
    let seq = baseSeq();
    seq = apply(seq, { type: "SetClipAvLink", clipId: "c1", linked: false });
    seq = apply(seq, { type: "TrimClipAudioStream", clipId: "c1", newAudioSourceInFrame: 60, newAudioSourceOutFrame: 240 });
    const restored = JSON.parse(JSON.stringify(seq)) as Sequence;
    expect(restored.clips[0].audioSourceInFrame).toBe(60);
    expect(restored.clips[0].audioSourceOutFrame).toBe(240);
    expect(restored.clips[0].avLinked).toBe(false);
  });

  test("re-linking resolves the audio range back to the video range", () => {
    let seq = baseSeq();
    seq = apply(seq, { type: "SetClipAvLink", clipId: "c1", linked: false });
    seq = apply(seq, { type: "TrimClipAudioStream", clipId: "c1", newAudioSourceInFrame: 60, newAudioSourceOutFrame: 240 });
    seq = apply(seq, { type: "SetClipAvLink", clipId: "c1", linked: true });
    const c = seq.clips[0];
    expect(c.avLinked).toBe(true);
    expect(c.audioSourceInFrame).toBeNull();
    expect(c.audioSourceOutFrame).toBeNull();
  });
});

// ── live render proof (real media, real export, decoded audio) ───────────────
const BASE = process.env.BASE ?? "http://localhost:3130";
const EVIDENCE = "/home/z/my-project/download/m48-h-evidence/h1";
const STAMP = Date.now().toString(36);
fs.mkdirSync(EVIDENCE, { recursive: true });

let cookie = "";
let currentProjectId = "";

async function api(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  for (const raw of sc) {
    const pair = raw.split(";")[0];
    if (pair.startsWith("beanfx_session=")) cookie = pair;
  }
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/** 8 s MP4: testsrc2 video; audio = 440 Hz (0–4 s) then 880 Hz (4–8 s). */
function generateFixture(): string {
  const p = `/tmp/m48-h1-freq-${STAMP}.mp4`;
  if (!fs.existsSync(p)) {
    const r = spawnSync("ffmpeg", ["-y",
      "-f", "lavfi", "-i", "testsrc2=duration=8:size=480x270:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-f", "lavfi", "-i", "sine=frequency=880:duration=4",
      "-filter_complex", "[1:a][2:a]concat=n=2:v=0:a=1[a]",
      "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", p], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`fixture generation failed: ${r.stderr.slice(0, 300)}`);
  }
  return p;
}

/** RMS of a decoded window after a narrow bandpass — a self-relative tone
 *  discriminator immune to absolute level and AAC shimmer. */
function bandpassRms(file: string, from: number, to: number, freq: number, width: number): number {
  const r = spawnSync("ffmpeg", ["-v", "error", "-ss", String(from), "-to", String(to),
    "-i", file, "-af", `bandpass=f=${freq}:w=${width}`, "-f", "wav", "-"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  const wav = r.stdout as Buffer;
  const idx = wav.indexOf(Buffer.from("data"));
  const data = wav.subarray(idx + 8);
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 2 <= data.length; i += 2) {
    const v = data.readInt16LE(i) / 32768;
    sum += v * v;
    n += 1;
  }
  return n > 0 ? Math.sqrt(sum / n) : 0;
}

describe("M48-H1 — export renders the independent audio range (real media)", () => {
  test("J/L sync shift: the decoded frequency flip lands at export 2 s, not 4 s", async () => {
    const reg = await api("POST", "/api/auth/register", { email: `h1-${STAMP}@test.local`, password: "h1-real-media-1", name: "H1", acceptedDraftTerms: true });
    if (reg.status >= 300) console.log("REGISTER FAILED:", JSON.stringify(reg.json).slice(0, 300));
    expect(reg.status).toBeLessThan(300);
    const pr = await api("POST", "/api/projects", { name: `H1 av-split ${STAMP}` });
    expect(pr.status).toBeLessThan(300);
    currentProjectId = (pr.json as { project: { id: string } }).project.id;

    const fixture = generateFixture();
    const up = await fetch(`${BASE}/api/media`, {
      method: "POST",
      headers: { "Content-Type": "video/mp4", "x-project-id": currentProjectId, "x-filename": "freq.mp4", "x-asset-role": "SOURCE_FOOTAGE", ...(cookie ? { Cookie: cookie } : {}) },
      body: fs.readFileSync(fixture),
    });
    expect(up.status).toBeLessThan(300);
    const upJson = (await up.json()) as { asset?: { id?: string }; media?: { id?: string }; id?: string };
    const assetId = upJson.asset?.id ?? upJson.media?.id ?? upJson.id;
    if (!assetId) console.log("UPLOAD BODY:", JSON.stringify(upJson).slice(0, 300));

    const head = await api("GET", `/api/editor/projects/${currentProjectId}/timeline`);
    console.log("HEAD STATUS", head.status, JSON.stringify(head.json).slice(0, 200));
    const hj = head.json as { version: number; sequence: { tracks: Array<{ id: string; kind: string }>; fps: { num: number; den: number } } };
    const videoTrack = hj.sequence.tracks.find((t) => t.kind === "VIDEO")!.id;

    // 6 s clip: video range 0–180 (6 s), AUDIO range 60–240 (source 2–8 s).
    const clip = {
      id: `h1_${STAMP}`, trackId: videoTrack, sourceAssetId: assetId,
      sourceInFrame: 0, sourceOutFrame: 180, sourceFps: { num: 30, den: 1 },
      timelineStartFrame: 0, timelineDurationFrames: 180, playbackSpeed: 1,
      volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
      label: "H1 jcut", missingMedia: false, pan: 0, groupId: null, effects: [], keyframes: [],
      audioSourceInFrame: 60, audioSourceOutFrame: 240, avLinked: false,
    };
    const tl = await api("POST", `/api/editor/projects/${currentProjectId}/timeline`, { baseVersion: hj.version, edits: [{ type: "AddClip", clip }] });
    if (tl.status >= 300) throw new Error(`timeline rejected: ${JSON.stringify(tl.json).slice(0, 300)}`);

    const rr = await api("POST", `/api/editor/projects/${currentProjectId}/render`, {});
    expect(rr.status).toBe(202);
    const jobId = (rr.json as { jobId: string }).jobId;
    let exportId = "";
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const g = await api("GET", `/api/jobs/${jobId}`);
      const job = (g.json as { job?: { status?: string; exportId?: string } }).job ?? (g.json as { status?: string; exportId?: string });
      if (job?.status === "COMPLETED" && job.exportId) { exportId = job.exportId; break; }
      if (job?.status === "FAILED") throw new Error("render FAILED");
    }
    expect(exportId).toBeTruthy();
    const dl = await fetch(`${BASE}/api/exports/${exportId}/file`, { headers: cookie ? { Cookie: cookie } : {} });
    expect(dl.status).toBe(200);
    const outPath = path.join(EVIDENCE, `h1-jcut-${STAMP}.mp4`);
    fs.writeFileSync(outPath, Buffer.from(await dl.arrayBuffer()));

    // Self-relative band discrimination per window: with the +2 s audio
    // shift, export 0.3–1.7 s = source 2.3–3.7 s → 440 Hz dominates;
    // export 2.6–4.0 s = source 4.6–6.0 s → 880 Hz dominates. With the
    // UNSHIFTED (video) range the flip would land at export 4 s and BOTH
    // windows would read 440 Hz.
    const e440 = bandpassRms(outPath, 0.3, 1.7, 440, 120);
    const e880 = bandpassRms(outPath, 0.3, 1.7, 880, 160);
    const l440 = bandpassRms(outPath, 2.6, 4.0, 440, 120);
    const l880 = bandpassRms(outPath, 2.6, 4.0, 880, 160);
    const result = { early: { rms440: e440, rms880: e880 }, late: { rms440: l440, rms880: l880 }, flipAtExportSec: 2 };
    fs.writeFileSync(path.join(EVIDENCE, "h1-jcut-analysis.json"), JSON.stringify(result, null, 1));
    console.log("H1 PROOF", JSON.stringify(result));
    expect(e440).toBeGreaterThan(e880 * 2); // early window is the 440 Hz tone
    expect(l880).toBeGreaterThan(l440 * 2); // late window is the 880 Hz tone
  }, 300_000);
});
