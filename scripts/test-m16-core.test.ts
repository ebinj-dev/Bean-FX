/**
 * BEAN FX — M16 engine tests (bun test, isolated DB). Fixture-based: the
 * playback clock, edit-operation compilers, filter mapping and the timeline
 * render graph are verified against the REAL M1 engine without a browser.
 * Real-media/browser behaviors (audio sync, dropped frames, pixel parity,
 * real render) live in scripts/e2e-m16-browser.sh and are reported
 * separately — nothing here is labeled a live integration.
 *
 * Run: bun test scripts/test-m16-core.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m16-core-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
process.env.NODE_ENV = "production";
const WORK = mkdtempSync(path.join(os.tmpdir(), "beanfx-m16-core-"));
execSync("node_modules/.bin/prisma db push --skip-generate --accept-data-loss", { env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` }, stdio: ["ignore", "ignore", "inherit"] });

let commands: typeof import("../src/lib/editor/commands");
let model: typeof import("../src/lib/editor/model");
let edits: typeof import("../src/lib/editor/edits");
let filters: typeof import("../src/lib/editor/filters");
let playback: typeof import("../src/lib/editor/playback");
let timelineRender: typeof import("../src/lib/publish/timeline-render");

let seq: import("../src/lib/editor/model").Sequence;

beforeAll(async () => {
  commands = await import("../src/lib/editor/commands");
  model = await import("../src/lib/editor/model");
  edits = await import("../src/lib/editor/edits");
  filters = await import("../src/lib/editor/filters");
  playback = await import("../src/lib/editor/playback");
  timelineRender = await import("../src/lib/publish/timeline-render");
  const fps = { num: 30, den: 1 };
  const mkClip = (id: string, trackId: string, start: number, dur: number, srcIn = 0): import("../src/lib/editor/model").Clip =>
    model.ClipSchema.parse({
      id, trackId, sourceAssetId: `asset_${trackId}`, sourceInFrame: srcIn, sourceOutFrame: srcIn + dur, sourceFps: fps,
      timelineStartFrame: start, timelineDurationFrames: dur, playbackSpeed: 1, volume: 1, muted: false,
      fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      captionText: null, graphicTemplateId: null, graphicStyle: null, keyframes: [], missingMedia: false,
    });
  seq = model.SequenceSchema.parse({
    id: "m16seq", name: "M16 Core", sampleRate: 48000, width: 640, height: 360, fps,
    tracks: [
      { id: "v1", name: "V1", kind: "VIDEO", visible: true, muted: false, solo: false, locked: false },
      { id: "v2", name: "V2", kind: "VIDEO", visible: true, muted: false, solo: false, locked: false },
      { id: "a1", name: "A1", kind: "AUDIO", visible: true, muted: false, solo: false, locked: false },
      { id: "s1", name: "SUB", kind: "CAPTION", visible: true, muted: false, solo: false, locked: false },
    ],
    clips: [
      mkClip("c1", "v1", 0, 60),
      mkClip("c2", "v1", 60, 60),
      mkClip("c3", "v1", 120, 60),
      mkClip("a1c", "a1", 0, 90),
    ],
    transitions: [],
  });
}, 90_000);

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
  rmSync(SCRATCH_DB, { force: true });
});

describe("M16 playback controller (stable clock)", () => {
  test("anchor-based projection does not accumulate rounding drift", () => {
    const ctl = new playback.PlaybackController({ num: 30, den: 1 }, 0, 9000);
    ctl.play();
    ctl.advanceForTest(10); // exactly 300 frames at 30fps
    expect(ctl.clock.frame).toBe(300);
    ctl.advanceForTest(10);
    expect(ctl.clock.frame).toBe(600);
    ctl.advanceForTest(0.0333);
    expect(ctl.clock.frame).toBe(601); // one frame later, not drifting behind
    ctl.pause();
    expect(ctl.clock.playing).toBe(false);
    ctl.dispose();
  });

  test("seek re-anchors mid-playback and bumps the generation (stale guards)", () => {
    const ctl = new playback.PlaybackController({ num: 30, den: 1 }, 0, 9000);
    ctl.play();
    const genBefore = ctl.clock.generation;
    ctl.advanceForTest(5);
    ctl.seek(1500);
    expect(ctl.clock.generation).toBe(genBefore + 1);
    ctl.advanceForTest(1);
    expect(ctl.clock.frame).toBe(1530); // projection continues FROM the seek point
    ctl.dispose();
  });

  test("playback stops at the sequence end and reports dropped-frame telemetry", () => {
    const ctl = new playback.PlaybackController({ num: 30, den: 1 }, 0, 60);
    ctl.play();
    ctl.advanceForTest(3); // past the 2s end
    expect(ctl.clock.playing).toBe(false);
    expect(ctl.clock.frame).toBe(60);
    expect(ctl.clock.droppedFrames).toBeGreaterThanOrEqual(0);
    ctl.dispose();
  });

  test("frame bus subscribers receive ticks (paint path, no React)", () => {
    const seen: number[] = [];
    const unsub = playback.subscribeFrame((f) => seen.push(f));
    playback.publishFrame(42, true);
    expect(seen).toContain(42);
    unsub();
    playback.publishFrame(43, true);
    expect(seen).not.toContain(43);
  });
});

describe("M16 edit operations compile to valid M1 commands", () => {
  const run = (input: import("../src/lib/editor/model").Sequence, cmds: Record<string, unknown>[]) => {
    let s = input;
    for (const c of cmds) ({ sequence: s } = commands.applyCommand(s, c));
    return s;
  };

  test("INSERT shifts later clips and places the incoming clip; engine accepts", () => {
    const incoming = { ...seq.clips[0], id: "ins", trackId: "v1", timelineDurationFrames: 30 };
    const op = edits.compileInsert(seq, "v1", 60, incoming);
    expect(op).not.toBeNull();
    const after = run(seq, op!.commands);
    const onV1 = after.clips.filter((c) => c.trackId === "v1").sort((a, b) => a.timelineStartFrame - b.timelineStartFrame);
    expect(onV1.map((c) => c.id)).toEqual(["c1", "ins", "c2", "c3"]); // c2/c3 pushed right
    expect(onV1[1].timelineStartFrame).toBe(60);
    expect(onV1[2].timelineStartFrame).toBe(90);
    expect(onV1[3].timelineStartFrame).toBe(150);
  });

  test("OVERWRITE trims/removes overlaps and keeps the engine valid", () => {
    const incoming = { ...seq.clips[0], id: "ovr", trackId: "v1", timelineStartFrame: 90, timelineDurationFrames: 60 };
    const op = edits.compileOverwrite(seq, "v1", incoming);
    expect(op).not.toBeNull();
    const after = run(seq, op!.commands);
    // c2 (60..120) loses its tail beyond 90 → 60..90; c3 (120..180) loses its
    // head up to 150 → 150..180. Classic overwrite, no gaps created.
    const c2 = after.clips.find((c) => c.id === "c2")!;
    const c3 = after.clips.find((c) => c.id === "c3")!;
    expect(c2.timelineStartFrame + c2.timelineDurationFrames).toBe(90);
    expect(c3.timelineStartFrame).toBe(150);
    expect(c3.timelineStartFrame + c3.timelineDurationFrames).toBe(180);
  });

  test("ROLL moves the shared boundary with duration preserved; refuses invalid", () => {
    const durations = new Map([["asset_v1", 300]]);
    const op = edits.compileRoll(seq, "c1", "c2", 10, durations);
    expect(op).not.toBeNull();
    const after = run(seq, op!.commands);
    const c1 = after.clips.find((c) => c.id === "c1")!;
    const c2 = after.clips.find((c) => c.id === "c2")!;
    expect(c1.timelineStartFrame + c1.timelineDurationFrames).toBe(70); // boundary moved
    expect(c2.timelineStartFrame).toBe(70);
    expect(c2.timelineStartFrame + c2.timelineDurationFrames).toBe(120); // outer edge fixed
    // Roll beyond the right clip's end refuses.
    expect(edits.compileRoll(seq, "c1", "c2", 500, durations)).toBeNull();
    // Without known media durations, any extension is refused honestly.
    expect(edits.compileRoll(seq, "c1", "c2", 10)).toBeNull();
    // Non-adjacent pair refuses.
    expect(edits.compileRoll(seq, "c1", "c3", 5)).toBeNull();
  });

  test("LIFT leaves a gap; EXTRACT closes it (ripple)", () => {
    const lift = edits.compileLift(seq, ["c2"]);
    expect(lift).not.toBeNull();
    const lifted = run(seq, lift!.commands);
    expect(lifted.clips.find((c) => c.id === "c2")).toBeUndefined();
    expect(lifted.clips.find((c) => c.id === "c3")!.timelineStartFrame).toBe(120); // gap remains
    const extract = edits.compileExtract(seq, ["c2"]);
    const extracted = run(seq, extract!.commands);
    expect(extracted.clips.find((c) => c.id === "c3")!.timelineStartFrame).toBe(60); // closed
  });

  test("GROUP MOVE refuses collisions and locked tracks, accepts clean moves", () => {
    // c2+c3 +10: c2→70..130, c3→130..190 — clean (c1 ends at 60).
    const op = edits.compileGroupMove(seq, ["c2", "c3"], 10);
    expect(op).not.toBeNull();
    const after = run(seq, op!.commands);
    expect(after.clips.find((c) => c.id === "c2")!.timelineStartFrame).toBe(70);
    expect(after.clips.find((c) => c.id === "c3")!.timelineStartFrame).toBe(130);
    // c1+c2 +10 would push c2 into c3 → refused.
    expect(edits.compileGroupMove(seq, ["c1", "c2"], 10)).toBeNull();
    // Locked track refuses.
    const locked = commands.applyCommand(seq, { type: "UpdateTrack", trackId: "v1", locked: true }).sequence;
    expect(edits.compileGroupMove(locked, ["c1"], 5)).toBeNull();
  });

  test("SLIP/SLIDE (M15) still compile — regression guard on the shared tools", () => {
    expect(edits.slipCommand(seq.clips[0], 5)).not.toBeNull();
    expect(edits.slideCommands(seq, seq.clips[0], 5)).not.toBeNull();
  });
});

describe("M16 effect filter mapping (preview/export single source)", () => {
  const fx = (type: import("../src/lib/editor/model").EffectType, params: Record<string, number>): import("../src/lib/editor/model").Effect => ({
    id: `fx_${type}`, type, enabled: true, params,
  });

  test("CSS and FFmpeg chains generate from the same registry", () => {
    const effects = [fx("contrast", { value: 1.4 }), fx("saturation", { value: 0.5 }), fx("blur", { radius: 3 })];
    expect(filters.cssEffectFilter(effects)).toBe("contrast(1.4000) saturate(0.5000) blur(3px)");
    expect(filters.ffmpegEffectChain(effects)).toBe("eq=contrast=1.4000:saturation=0.5000,gblur=sigma=3");
  });

  test("eq parameters merge into ONE filter (FFmpeg single-instance rule)", () => {
    const effects = [fx("brightness", { value: 0.1 }), fx("contrast", { value: 1.2 })];
    const chain = filters.ffmpegEffectChain(effects)!;
    expect(chain.startsWith("eq=")).toBe(true);
    expect((chain.match(/eq=/g) ?? []).length).toBe(1);
    expect(chain).toContain("brightness=0.1000");
    expect(chain).toContain("contrast=1.2000");
  });

  test("disabled effects and audio-only effects never reach the visual chain", () => {
    const effects = [fx("blur", { radius: 4 }), { ...fx("blur", { radius: 9 }), enabled: false }, fx("volume", { value: 2 })];
    expect(filters.cssEffectFilter(effects)).toBe("blur(4px)");
    expect(filters.audioGainMultiplier(effects)).toBe(2);
  });

  test("sharpen is export-only; temperature/tint emit colorbalance + SVG refs", () => {
    expect(filters.cssEffectFilter([fx("sharpen", { amount: 1 })])).toBeNull();
    expect(filters.ffmpegEffectChain([fx("sharpen", { amount: 1 })])).toContain("unsharp");
    expect(filters.ffmpegEffectChain([fx("temperature", { value: 0.5 })])).toContain("colorbalance");
    expect(filters.cssEffectFilter([fx("temperature", { value: 0.5 })])).toContain("url(#beanfx-temperature-warm)");
    expect(filters.ffmpegEffectChain([fx("tint", { value: -0.4 })])).toContain("colorbalance");
  });

  test("old M15 sequences with the original 6 effect types still parse (additive)", () => {
    const legacy = JSON.parse(JSON.stringify(seq));
    legacy.clips[0].effects = [{ id: "fx1", type: "grayscale", enabled: true, params: {} }];
    const parsed = model.SequenceSchema.parse(legacy);
    expect(parsed.clips[0].effects[0].type).toBe("grayscale");
  });
});

describe("M16 timeline render graph (the missing M15 export path)", () => {
  test("graph contains per-clip segments, overlays, captions, amix and silence bed", () => {
    const inputs = new Map<string, { index: number; isImage: boolean; hasAudio: boolean }>([
      ["asset_v1", { index: 0, isImage: false, hasAudio: true }],
      ["asset_a1", { index: 1, isImage: false, hasAudio: true }],
    ]);
    const g = timelineRender.buildTimelineGraph(seq, 0, 180, inputs);
    expect(g.videoLabel).toBeTruthy();
    expect(g.filterComplex).toContain("[silence]");
    expect(g.filterComplex).toMatch(/amix=inputs=\d+:normalize=0/);
    expect(g.filterComplex).toContain("trim=start=");
    expect(g.filterComplex).toContain("overlay=eof_action=pass");
    expect(g.filterComplex).toContain("adelay=");
    expect(g.filterComplex).toContain("fps=30");
  });

  test("captions render via drawtext with enable windows", () => {
    const withCaption = commands.applyCommand(seq, {
      type: "AddCaption",
      clip: {
        id: "cap1", trackId: "s1", sourceAssetId: "", sourceInFrame: 0, sourceOutFrame: 30, sourceFps: { num: 30, den: 1 },
        timelineStartFrame: 10, timelineDurationFrames: 30, playbackSpeed: 1, volume: 1, muted: false,
        fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        captionText: "வணக்கம்", captionStyle: { fontSize: 48, color: "#FFFFFF", background: null, position: "BOTTOM" },
        graphicTemplateId: null, graphicStyle: null, keyframes: [], missingMedia: true,
      },
    }).sequence;
    const inputs = new Map<string, { index: number; isImage: boolean; hasAudio: boolean }>([["asset_v1", { index: 0, isImage: false, hasAudio: true }]]);
    const g = timelineRender.buildTimelineGraph(withCaption, 0, 180, inputs);
    expect(g.filterComplex).toContain("drawtext=");
    expect(g.filterComplex).toContain("between(t");
    expect(g.filterComplex).toContain("0xFFFFFF");
  });

  test("missing media is skipped honestly and counted", () => {
    const broken = JSON.parse(JSON.stringify(seq)) as typeof seq;
    broken.clips.push({ ...broken.clips[0], id: "ghost", trackId: "v2", sourceAssetId: "asset_missing" });
    const inputs = new Map<string, { index: number; isImage: boolean; hasAudio: boolean }>([["asset_v1", { index: 0, isImage: false, hasAudio: true }]]);
    const g = timelineRender.buildTimelineGraph(broken, 0, 180, inputs);
    expect(g.skippedMissing).toBe(1);
    expect(g.filterComplex).not.toContain("asset_missing");
  });

  test("REAL ffmpeg render of the fixture graph produces a valid mp4 (real media test)", async () => {
    // A true end-to-end mini-render: real generated testsrc + sine sources,
    // the REAL graph builder, one ffmpeg invocation, ffprobe validation.
    const vid = path.join(WORK, "m16src.mp4");
    const aud = path.join(WORK, "m16tone.wav");
    // Source WITH its own audio stream (video clips contribute audio in the mix).
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2", "-f", "lavfi", "-i", "sine=frequency=500:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", vid]);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "pcm_s16le", aud]);
    const inputs = new Map<string, { index: number; isImage: boolean; hasAudio: boolean }>([
      ["asset_v1", { index: 0, isImage: false, hasAudio: true }],
      ["asset_v2", { index: 1, isImage: false, hasAudio: true }],
      ["asset_a1", { index: 2, isImage: false, hasAudio: true }],
    ]);
    const g = timelineRender.buildTimelineGraph(seq, 0, 180, inputs);
    const out = path.join(WORK, "m16render.mp4");
    const args = ["-y", "-loglevel", "error", "-i", vid, "-i", vid, "-i", aud, "-filter_complex", g.filterComplex, "-map", g.videoLabel, "-map", "[mixout]", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "6", out];
    execFileSync("ffmpeg", args, { timeout: 120_000 });
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", out]).toString()) as {
      streams: { codec_type: string; codec_name: string; width?: number }[];
      format: { duration: string };
    };
    expect(probe.streams.some((s) => s.codec_type === "video" && s.codec_name === "h264")).toBe(true);
    expect(probe.streams.some((s) => s.codec_type === "audio")).toBe(true);
    expect(Number(probe.format.duration)).toBeGreaterThan(5.5);
  }, 120_000);
});
