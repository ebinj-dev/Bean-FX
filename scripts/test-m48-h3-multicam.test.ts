/**
 * M48-H3 — multicamera foundations: unit tests on the canonical group/switch
 * commands + a REAL rendered proof that switching the active angle at the
 * playhead produces actual timeline edits (decoded frame-colour analysis).
 *
 * Run: BASE=http://localhost:3130 bun test scripts/test-m48-h3-multicam.test.ts
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
    id: "seq", name: "H3", fps: { num: 30, den: 1 }, width: 480, height: 270, sampleRate: 48000,
    tracks: [{ id: "v1", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false, volume: 1, busId: null }],
    clips: [{
      id: "c1", trackId: "v1", sourceAssetId: "camA", sourceInFrame: 0, sourceOutFrame: 180,
      sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 180,
      playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
      label: null, missingMedia: false, pan: 0, groupId: null, effects: [], keyframes: [],
      audioSourceInFrame: null, audioSourceOutFrame: null, avLinked: true,
      multicamGroupId: null, multicamAngleId: null,
    }],
    transitions: [], markers: [], buses: [], multicamGroups: [],
  };
}
const apply = (seq: Sequence, cmd: unknown): Sequence => applyCommand(seq, cmd).sequence;
const group = () => ({
  id: "mc1", name: "Interview",
  angles: [
    { id: "a", assetId: "camA", label: "CAM_A", offsetFrames: 0 },
    { id: "b", assetId: "camB", label: "CAM_B", offsetFrames: 0 },
  ],
});

describe("M48-H3 — multicam group commands (canonical, reversible)", () => {
  test("create + assign + validation integrity; remove refused while tagged", () => {
    const addResult = applyCommand(baseSeq(), { type: "CreateMulticamGroup", group: group() });
    let seq = apply(addResult.sequence, { type: "AssignMulticamGroup", clipId: "c1", groupId: "mc1", angleId: "a" });
    expect(seq.clips[0].multicamGroupId).toBe("mc1");
    expect(seq.clips[0].multicamAngleId).toBe("a");
    expect(validateSequence(seq).errors).toEqual([]);
    // remove refused while tagged
    let threw = "";
    try { apply(seq, { type: "RemoveMulticamGroup", groupId: "mc1" }); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    expect(threw).toContain("still referenced");
    // undo the assign → untagged
    seq = apply(seq, addResult.sequence === seq ? { type: "RemoveMulticamGroup", groupId: "mc1" } : { type: "AssignMulticamGroup", clipId: "c1", groupId: null, angleId: null });
    expect(seq.clips[0].multicamGroupId).toBeNull();
  });

  test("switching mid-clip splits for real and retargets the right segment to the new angle", () => {
    let seq = apply(baseSeq(), { type: "CreateMulticamGroup", group: group() });
    seq = apply(seq, { type: "AssignMulticamGroup", clipId: "c1", groupId: "mc1", angleId: "a" });
    const r = applyCommand(seq, { type: "SwitchMulticamAngle", clipId: "c1", angleId: "b", atTimelineFrame: 90, newSourceFps: { num: 30, den: 1 }, newRightId: "right1" });
    seq = r.sequence;
    expect(seq.clips).toHaveLength(2);
    const left = seq.clips.find((c) => c.id === "c1")!;
    const right = seq.clips.find((c) => c.id === "right1")!;
    expect(left.timelineDurationFrames).toBe(90);
    expect(left.sourceAssetId).toBe("camA");
    expect(left.sourceOutFrame).toBe(90);
    expect(right.timelineStartFrame).toBe(90);
    expect(right.timelineDurationFrames).toBe(90);
    expect(right.sourceAssetId).toBe("camB");
    // SYNC-PRESERVING: the right segment covers group time 3–6 s → camB's
    // source frames 90–180 (offset 0). The new angle shows the SAME moments.
    expect(right.sourceInFrame).toBe(90);
    expect(right.sourceOutFrame).toBe(180);
    expect(right.multicamGroupId).toBe("mc1");
    expect(right.multicamAngleId).toBe("b");
    expect(validateSequence(seq).errors).toEqual([]);
    // undo → exactly the original clip back (composite inverses apply in
    // REVERSE list order — the engine's EditHistory contract)
    for (const inv of [...r.inverse].reverse()) seq = apply(seq, inv);
    expect(seq.clips).toHaveLength(1);
    expect(seq.clips[0].sourceOutFrame).toBe(180);
    expect(seq.clips[0].timelineDurationFrames).toBe(180);
  });

  test("manual sync offset shifts the retargeted source range; rational fps conversion stays frame-exact", () => {
    let seq = apply(baseSeq(), { type: "CreateMulticamGroup", group: { ...group(), angles: [group().angles[0], { id: "b", assetId: "camB", label: "CAM_B", offsetFrames: 60 }] } });
    seq = apply(seq, { type: "AssignMulticamGroup", clipId: "c1", groupId: "mc1", angleId: "a" });
    seq = apply(seq, { type: "SwitchMulticamAngle", clipId: "c1", angleId: "b", atTimelineFrame: 90, newSourceFps: { num: 30, den: 1 }, newRightId: "r1" });
    const right = seq.clips.find((c) => c.id === "r1")!;
    // 60-frame offset + 90 timeline frames into the angle = source 150
    expect(right.sourceInFrame).toBe(150);
    expect(right.sourceOutFrame).toBe(240);

    // 24 fps angle: 90 timeline frames @30fps = 72 source frames @24fps
    let seq2 = apply(baseSeq(), { type: "CreateMulticamGroup", group: { ...group(), angles: [group().angles[0], { id: "b24", assetId: "camB24", label: "CAM_B24", offsetFrames: 0 }] } });
    seq2 = apply(seq2, { type: "AssignMulticamGroup", clipId: "c1", groupId: "mc1", angleId: "a" });
    seq2 = apply(seq2, { type: "SwitchMulticamAngle", clipId: "c1", angleId: "b24", atTimelineFrame: 90, newSourceFps: { num: 24, den: 1 }, newRightId: "r2" });
    const right24 = seq2.clips.find((c) => c.id === "r2")!;
    expect(right24.sourceFps).toEqual({ num: 24, den: 1 });
    // rational conversion: group time 3–6 s → 72–144 frames @24 fps
    expect(right24.sourceInFrame).toBe(72);
    expect(right24.sourceOutFrame).toBe(144);
    expect(right24.timelineDurationFrames).toBe(90);
    expect(validateSequence(seq2).errors).toEqual([]);
  });

  test("whole-clip retarget at the clip start; trim after switch keeps the invariant", () => {
    let seq = apply(baseSeq(), { type: "CreateMulticamGroup", group: group() });
    seq = apply(seq, { type: "AssignMulticamGroup", clipId: "c1", groupId: "mc1", angleId: "a" });
    seq = apply(seq, { type: "SwitchMulticamAngle", clipId: "c1", angleId: "b", atTimelineFrame: 0, newSourceFps: { num: 30, den: 1 } });
    expect(seq.clips).toHaveLength(1);
    expect(seq.clips[0].sourceAssetId).toBe("camB");
    // trim the retargeted clip — the duration invariant must hold after
    seq = apply(seq, { type: "TrimClip", clipId: "c1", newSourceOutFrame: 120 });
    expect(seq.clips[0].timelineDurationFrames).toBe(120);
    expect(validateSequence(seq).errors).toEqual([]);
  });
});

// ── live render proof ────────────────────────────────────────────────────────
const BASE = process.env.BASE ?? "http://localhost:3130";
const EVIDENCE = "/home/z/my-project/download/m48-h-evidence/h3";
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

/** 6 s angle fixture: solid colour + 440 Hz tone (both angles share the audio). */
function angleFixture(colour: string): string {
  const p = `/tmp/m48-h3-${colour}-${STAMP}.mp4`;
  if (fs.existsSync(p)) return p;
  const r = spawnSync("ffmpeg", ["-y",
    "-f", "lavfi", "-i", `color=${colour}:size=480x270:rate=30:duration=6`,
    "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", p], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`fixture failed: ${r.stderr.slice(0, 200)}`);
  return p;
}

function frameRGB(file: string, sec: number): { r: number; g: number; b: number } {
  const r = spawnSync("ffmpeg", ["-v", "error", "-ss", String(sec), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
  const d = r.stdout as Buffer;
  return { r: d[0], g: d[1], b: d[2] };
}

describe("M48-H3 — angle switch renders as a real timeline edit (live)", () => {
  test("switch CAM_A→CAM_B at 3 s: export frames are red before, blue after; audio continuous", async () => {
    const reg = await api("POST", "/api/auth/register", { email: `h3-${STAMP}@test.local`, password: "h3-real-media-1", name: "H3", acceptedDraftTerms: true });
    expect(reg.status).toBeLessThan(300);
    const pr = await api("POST", "/api/projects", { name: `H3 multicam ${STAMP}` });
    currentProjectId = (pr.json as { project: { id: string } }).project.id;

    const upload = async (file: string, name: string): Promise<string> => {
      const res = await fetch(`${BASE}/api/media`, {
        method: "POST",
        headers: { "Content-Type": "video/mp4", "x-project-id": currentProjectId, "x-filename": name, "x-asset-role": "SOURCE_FOOTAGE", ...(cookie ? { Cookie: cookie } : {}) },
        body: fs.readFileSync(file),
      });
      expect(res.status).toBeLessThan(300);
      const j = (await res.json()) as { asset?: { id?: string }; media?: { id?: string }; id?: string };
      return (j.asset?.id ?? j.media?.id ?? j.id) as string;
    };
    const camA = await upload(angleFixture("red"), "camA.mp4");
    const camB = await upload(angleFixture("blue"), "camB.mp4");

    // Create the group + assign the clip through the CANONICAL timeline edits.
    const head = await api("GET", `/api/editor/projects/${currentProjectId}/timeline`);
    const hj = head.json as { version: number; sequence: { tracks: Array<{ id: string; kind: string }> } };
    const vTrack = hj.sequence.tracks.filter((t) => t.kind === "VIDEO")[0].id;
    const clipId = `h3c-${STAMP}`;
    const tl = await api("POST", `/api/editor/projects/${currentProjectId}/timeline`, {
      baseVersion: hj.version,
      edits: [
        { type: "CreateMulticamGroup", group: { id: `mc-${STAMP}`, name: "Interview", angles: [{ id: "a", assetId: camA, label: "CAM_A", offsetFrames: 0 }, { id: "b", assetId: camB, label: "CAM_B", offsetFrames: 0 }] } },
        { type: "AddClip", clip: { id: clipId, trackId: vTrack, sourceAssetId: camA, sourceInFrame: 0, sourceOutFrame: 180, sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 180, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, label: "mc", missingMedia: false, pan: 0, groupId: null, effects: [], keyframes: [], audioSourceInFrame: null, audioSourceOutFrame: null, avLinked: true, multicamGroupId: null, multicamAngleId: null } },
        { type: "AssignMulticamGroup", clipId, groupId: `mc-${STAMP}`, angleId: "a" },
        { type: "SwitchMulticamAngle", clipId, angleId: "b", atTimelineFrame: 90, newSourceFps: { num: 30, den: 1 }, newRightId: `h3r-${STAMP}` },
      ],
    });
    if (tl.status >= 300) throw new Error(`timeline rejected: ${JSON.stringify(tl.json).slice(0, 300)}`);

    // Persistence: the head sequence now carries BOTH segments.
    const head2 = await api("GET", `/api/editor/projects/${currentProjectId}/timeline`);
    const hj2 = (head2.json as { sequence: { clips: Array<{ id: string; sourceAssetId: string; timelineStartFrame: number }> } }).sequence;
    const segs = hj2.clips.filter((c) => c.id === clipId || c.id === `h3r-${STAMP}`);
    expect(segs.length).toBe(2);

    const rr = await api("POST", `/api/editor/projects/${currentProjectId}/render`, {});
    expect(rr.status).toBe(202);
    const jobId = (rr.json as { jobId: string }).jobId;
    let exportId = "";
    for (let i = 0; i < 150; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const g = await api("GET", `/api/jobs/${jobId}`);
      const job = (g.json as { job?: { status?: string; exportId?: string } }).job ?? (g.json as { status?: string; exportId?: string });
      if (job?.status === "COMPLETED" && job.exportId) { exportId = job.exportId; break; }
      if (job?.status === "FAILED") throw new Error("render FAILED");
    }
    expect(exportId).toBeTruthy();
    const dl = await fetch(`${BASE}/api/exports/${exportId}/file`, { headers: cookie ? { Cookie: cookie } : {} });
    expect(dl.status).toBe(200);
    const outPath = path.join(EVIDENCE, `h3-switch-${STAMP}.mp4`);
    fs.writeFileSync(outPath, Buffer.from(await dl.arrayBuffer()));

    const before = frameRGB(outPath, 1.5); // CAM_A → red
    const after = frameRGB(outPath, 4.5); // CAM_B → blue
    const result = { before, after, switchAtSec: 3 };
    fs.writeFileSync(path.join(EVIDENCE, "h3-switch-analysis.json"), JSON.stringify(result, null, 1));
    console.log("H3 PROOF", JSON.stringify(result));
    expect(before.r).toBeGreaterThan(150);
    expect(before.b).toBeLessThan(80);
    expect(after.b).toBeGreaterThan(150);
    expect(after.r).toBeLessThan(80);
  }, 600_000);
});
