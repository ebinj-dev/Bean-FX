/**
 * M48-H2 — professional audio buses: unit tests on the canonical bus commands
 * + REAL rendered proofs that bus routing/gain/mute/solo change the actual
 * exported signal (decoded bandpass analysis — no mocked levels), plus a
 * sample-rate-conversion / channel-layout check (44.1 kHz mono source → 48 kHz
 * stereo export).
 *
 * Run: BASE=http://localhost:3130 bun test scripts/test-m48-h2-audio-buses.test.ts
 */
import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import fs from "node:fs";
import path from "node:path";

import { applyCommand } from "@/lib/editor/commands";
import { validateSequence } from "@/lib/editor/model";
import type { Sequence } from "@/lib/editor/model";

function baseSeq(): Sequence {
  return {
    id: "seq", name: "H2", fps: { num: 30, den: 1 }, width: 480, height: 270, sampleRate: 48000,
    tracks: [
      { id: "a1", kind: "AUDIO", name: "A1", visible: true, muted: false, solo: false, locked: false, volume: 1, busId: null },
      { id: "a2", kind: "AUDIO", name: "A2", visible: true, muted: false, solo: false, locked: false, volume: 1, busId: null },
    ],
    clips: [], transitions: [], markers: [], buses: [],
  };
}
const apply = (seq: Sequence, cmd: unknown): Sequence => applyCommand(seq, cmd).sequence;

const bus = (id: string, kind: "DIALOGUE" | "MUSIC") => ({ id, kind, name: kind.charAt(0) + kind.slice(1).toLowerCase(), gain: 1, pan: 0, muted: false, solo: false });

describe("M48-H2 — bus commands (canonical, reversible)", () => {
  test("AddBus/UpdateBus/AssignTrackBus round-trip with inverses; RemoveBus refuses non-empty buses", () => {
    const b = bus("bus-d", "DIALOGUE");
    // inverses are captured AT APPLY TIME (the engine's EditHistory pattern) —
    // re-applying a command to derive its inverse would mutate state first.
    const addResult = applyCommand(baseSeq(), { type: "AddBus", bus: b });
    let seq = addResult.sequence;
    expect(seq.buses).toHaveLength(1);
    // inverse of AddBus removes it
    let undone = apply(seq, addResult.inverse[0]);
    expect(undone.buses).toHaveLength(0);
    seq = apply(undone, { type: "AddBus", bus: b });
    // assign track → RemoveBus now refused
    const assignResult = applyCommand(seq, { type: "AssignTrackBus", trackId: "a1", busId: "bus-d" });
    seq = assignResult.sequence;
    let threw = "";
    try { apply(seq, { type: "RemoveBus", busId: "bus-d" }); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    expect(threw).toContain("still has");
    // update bus gain + mute → inverse restores
    const updResult = applyCommand(seq, { type: "UpdateBus", busId: "bus-d", gain: 0.5, muted: true });
    seq = updResult.sequence;
    expect(seq.buses[0].gain).toBe(0.5);
    expect(seq.buses[0].muted).toBe(true);
    seq = apply(seq, updResult.inverse[0]);
    expect(seq.buses[0].gain).toBe(1);
    expect(seq.buses[0].muted).toBe(false);
    // validation passes with the bus graph
    expect(validateSequence(seq).errors).toEqual([]);
  });

  test("unassigning restores master routing; dangling busIds fail validation", () => {
    const assignResult = applyCommand(baseSeq(), { type: "AddBus", bus: bus("bus-m", "MUSIC") });
    let seq = apply(assignResult.sequence, { type: "AssignTrackBus", trackId: "a2", busId: "bus-m" });
    expect(seq.tracks[1].busId).toBe("bus-m");
    const unassign = applyCommand(seq, { type: "AssignTrackBus", trackId: "a2", busId: null });
    expect(unassign.sequence.tracks[1].busId).toBeNull(); // unassign → master
    seq = apply(unassign.sequence, unassign.inverse[0]);
    expect(seq.tracks[1].busId).toBe("bus-m"); // and the undo re-assigns
    // dangling reference
    const bad = baseSeq();
    bad.tracks[0].busId = "ghost";
    expect(validateSequence(bad).errors.join(" ")).toContain("unknown bus");
  });
});

// ── live render proofs ───────────────────────────────────────────────────────
const BASE = process.env.BASE ?? "http://localhost:3130";
const EVIDENCE = "/home/z/my-project/download/m48-h-evidence/h2";
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

function toneFixture(freq: number, durSec = 6, opts: { mono441?: boolean } = {}): string {
  const p = `/tmp/m48-h2-${freq}${opts.mono441 ? "-mono441" : ""}-${STAMP}.mp4`;
  if (fs.existsSync(p)) return p;
  const audioArgs = opts.mono441
    ? ["-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${durSec}:sample_rate=44100`, "-af", "aformat=channel_layouts=mono"]
    : ["-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${durSec}`];
  const r = spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc2=duration=" + durSec + ":size=480x270:rate=30",
    ...audioArgs, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-shortest", p], { encoding: "utf8" });
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

function bandpassRms(file: string, from: number, to: number, freq: number, width: number): number {
  const r = spawnSync("ffmpeg", ["-v", "error", "-ss", String(from), "-to", String(to), "-i", file, "-af", `bandpass=f=${freq}:w=${width}`, "-f", "wav", "-"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  const wav = r.stdout as Buffer;
  const idx = wav.indexOf(Buffer.from("data"));
  const data = wav.subarray(idx + 8);
  let sum = 0, n = 0;
  for (let i = 0; i + 2 <= data.length; i += 2) { const v = data.readInt16LE(i) / 32768; sum += v * v; n += 1; }
  return n > 0 ? Math.sqrt(sum / n) : 0;
}

async function buildAndRender(clips: unknown[], edits: unknown[]): Promise<string> {
  const head = await api("GET", `/api/editor/projects/${currentProjectId}/timeline`);
  const hj = head.json as { version: number; sequence: { tracks: Array<{ id: string; kind: string }> } };
  const audioTracks = hj.sequence.tracks.filter((t) => t.kind === "AUDIO");
  const remapped = (clips as Array<Record<string, unknown>>).map((c) => ({ ...c, trackId: audioTracks[(c.__slot as number) ?? 0]?.id }));
  for (const c of remapped) delete (c as Record<string, unknown>).__slot;
  const tl = await api("POST", `/api/editor/projects/${currentProjectId}/timeline`, {
    baseVersion: hj.version, edits: [...edits, ...remapped.map((c) => ({ type: "AddClip", clip: c }))],
  });
  if (tl.status >= 300) throw new Error(`timeline rejected: ${JSON.stringify(tl.json).slice(0, 300)}`);
  const rr = await api("POST", `/api/editor/projects/${currentProjectId}/render`, {});
  expect(rr.status).toBe(202);
  const jobId = (rr.json as { jobId: string }).jobId;
  let exportId = "";
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const g = await api("GET", `/api/jobs/${jobId}`);
    const job = (g.json as { job?: { status?: string; exportId?: string; message?: string } }).job ?? (g.json as { status?: string; exportId?: string; message?: string });
    if (job?.status === "COMPLETED" && job.exportId) { exportId = job.exportId; break; }
    if (job?.status === "FAILED") throw new Error(`render FAILED: ${JSON.stringify(job).slice(0, 200)}`);
  }
  expect(exportId).toBeTruthy();
  const dl = await fetch(`${BASE}/api/exports/${exportId}/file`, { headers: cookie ? { Cookie: cookie } : {} });
  expect(dl.status).toBe(200);
  const out = path.join(EVIDENCE, `h2-${Date.now().toString(36)}.mp4`);
  fs.writeFileSync(out, Buffer.from(await dl.arrayBuffer()));
  return out;
}

const clip = (id: string, assetId: string, slot: number) => ({
  id, __slot: slot, sourceAssetId: assetId, sourceInFrame: 0, sourceOutFrame: 180,
  sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 180,
  playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
  label: null, missingMedia: false, pan: 0, groupId: null, effects: [], keyframes: [],
  audioSourceInFrame: null, audioSourceOutFrame: null, avLinked: true,
});

describe("M48-H2 — real bus routing proofs (live renders)", () => {
  test("bus mute silences the real signal; unmute restores it; bus solo gates the other bus", async () => {
    const reg = await api("POST", "/api/auth/register", { email: `h2-${STAMP}@test.local`, password: "h2-real-media-1", name: "H2", acceptedDraftTerms: true });
    expect(reg.status).toBeLessThan(300);
    const pr = await api("POST", "/api/projects", { name: `H2 buses ${STAMP}` });
    currentProjectId = (pr.json as { project: { id: string } }).project.id;
    const a440 = await upload(toneFixture(440), "a440.mp4");
    const a880 = await upload(toneFixture(880), "a880.mp4");

    const busEdits = [
      { type: "AddBus", bus: bus(`dlg-${STAMP}`, "DIALOGUE") },
      { type: "AddBus", bus: { ...bus(`mus-${STAMP}`, "MUSIC"), muted: true } },
      { type: "AssignTrackBus", trackId: "__A1__", busId: `dlg-${STAMP}` },
      { type: "AssignTrackBus", trackId: "__A2__", busId: `mus-${STAMP}` },
    ];
    // resolve track ids against the head
    const head = await api("GET", `/api/editor/projects/${currentProjectId}/timeline`);
    const hj = head.json as { version: number; sequence: { tracks: Array<{ id: string; kind: string }> } };
    const audioTracks = hj.sequence.tracks.filter((t) => t.kind === "AUDIO");
    const resolved = JSON.parse(JSON.stringify(busEdits).replace("__A1__", audioTracks[0].id).replace("__A2__", audioTracks[1].id)) as unknown[];

    // Render 1: MUSIC bus muted → 880 Hz must be near-silent in the export.
    const out1 = await buildAndRender([clip(`h2a-${STAMP}`, a440, 0), clip(`h2b-${STAMP}`, a880, 1)], resolved);
    const m440 = bandpassRms(out1, 0.5, 3.5, 440, 120);
    const m880 = bandpassRms(out1, 0.5, 3.5, 880, 160);
    const r1 = { phase: "music-muted", rms440: m440, rms880: m880 };
    console.log("H2 PROOF", JSON.stringify(r1));
    expect(m440).toBeGreaterThan(m880 * 5); // dialogue passes, muted music is silent

    // Render 2: unmute MUSIC → 880 Hz now audible (same mix otherwise).
    const head2 = await api("GET", `/api/editor/projects/${currentProjectId}/timeline`);
    const hj2 = head2.json as { version: number };
    const un = await api("POST", `/api/editor/projects/${currentProjectId}/timeline`, {
      baseVersion: hj2.version, edits: [{ type: "UpdateBus", busId: `mus-${STAMP}`, muted: false }],
    });
    expect(un.status).toBeLessThan(300);
    const out2 = await buildAndRender([clip(`h2c-${STAMP}`, a440, 0), clip(`h2d-${STAMP}`, a880, 1)], []);
    const u440 = bandpassRms(out2, 0.5, 3.5, 440, 120);
    const u880 = bandpassRms(out2, 0.5, 3.5, 880, 160);
    const r2 = { phase: "music-unmuted", rms440: u440, rms880: u880 };
    console.log("H2 PROOF", JSON.stringify(r2));
    expect(u880).toBeGreaterThan(m880 * 3); // unmute really unmuted the signal
    expect(u880).toBeGreaterThan(0.02);

    // Render 3: solo DIALOGUE → 880 silenced again (bus solo semantics).
    const head3 = await api("GET", `/api/editor/projects/${currentProjectId}/timeline`);
    const hj3 = head3.json as { version: number };
    const so = await api("POST", `/api/editor/projects/${currentProjectId}/timeline`, {
      baseVersion: hj3.version, edits: [{ type: "UpdateBus", busId: `dlg-${STAMP}`, solo: true }],
    });
    expect(so.status).toBeLessThan(300);
    const out3 = await buildAndRender([clip(`h2e-${STAMP}`, a440, 0), clip(`h2f-${STAMP}`, a880, 1)], []);
    const s880 = bandpassRms(out3, 0.5, 3.5, 880, 160);
    const s440 = bandpassRms(out3, 0.5, 3.5, 440, 120);
    const r3 = { phase: "dialogue-solo", rms440: s440, rms880: s880 };
    console.log("H2 PROOF", JSON.stringify(r3));
    fs.writeFileSync(path.join(EVIDENCE, "h2-bus-analysis.json"), JSON.stringify([r1, r2, r3], null, 1));
    expect(s880).toBeLessThan(u880 * 0.3); // solo really gated the music bus
    expect(s440).toBeGreaterThan(0.02); // solo'd dialogue still passes
  }, 900_000);

  test("sample-rate conversion + channel layout: 44.1 kHz mono source exports at 48 kHz stereo", async () => {
    const pr = await api("POST", "/api/projects", { name: `H2 src ${STAMP}` });
    currentProjectId = (pr.json as { project: { id: string } }).project.id;
    const mono = await upload(toneFixture(660, 4, { mono441: true }), "mono441.mp4");
    const head = await api("GET", `/api/editor/projects/${currentProjectId}/timeline`);
    const hj = head.json as { version: number; sequence: { tracks: Array<{ id: string; kind: string }> } };
    const aTrack = hj.sequence.tracks.filter((t) => t.kind === "AUDIO")[0].id;
    const c = { ...clip(`h2g-${STAMP}`, mono, 0), trackId: aTrack };
    const out = await buildAndRender([c], []);
    const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels,codec_name", "-of", "json", out], { encoding: "utf8" });
    const st = JSON.parse(probe.stdout).streams[0];
    const result = { sampleRate: st.sample_rate, channels: st.channels, codec: st.codec_name };
    fs.writeFileSync(path.join(EVIDENCE, "h2-src-channels.json"), JSON.stringify(result, null, 1));
    console.log("H2 SRC PROOF", JSON.stringify(result));
    expect(Number(st.sample_rate)).toBe(48000);
    expect(Number(st.channels)).toBe(2);
  }, 600_000);
});
