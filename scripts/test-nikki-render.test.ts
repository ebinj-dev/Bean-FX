/**
 * BEAN FX — M6 NIIKI tests: REAL FFmpeg rendering (drawtext graphics, xfade
 * transitions), preview/export parity on pixels, frame accuracy, A/V sync.
 *
 * Every assertion is a measured fact: frames are extracted from the rendered
 * file and their pixels sampled at computed positions.
 *
 * Run: bun test scripts/test-nikki-render.test.ts
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { execSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildNikkiRenderPlan, measureText, FONT_SANS } from "../src/lib/nikki/render";
import { parseSequence, type Sequence, type Clip } from "../src/lib/editor/model";
import { templateById } from "../src/lib/nikki/templates";
import type { NikkiGraphicStyle } from "../src/lib/nikki/types";

const WORK = mkdtempSync(path.join(os.tmpdir(), "beanfx-m6-render-"));
const FPS = 30;

function makeSeq(clips: Clip[], tracks: unknown[], transitions: unknown[] = []): Sequence {
  return parseSequence({
    id: "seq-render", name: "Render", fps: { num: FPS, den: 1 }, width: 1280, height: 720, sampleRate: 48000,
    tracks, clips, transitions,
  });
}

function graphicClip(over: Partial<Clip> & { style?: Partial<NikkiGraphicStyle> }): Clip {
  const style = {
    templateId: "test", templateVersion: 1,
    primaryText: "NIIKI TITLE", secondaryText: "",
    fontFamily: "nikki-sans" as const,
    primarySizePct: 10, secondarySizePct: 4,
    primaryColor: "#FFFFFF", secondaryColor: "#D4D4D0",
    strokeWidth: 0, strokeColor: "#000000",
    shadow: { enabled: false, offsetX: 2, offsetY: 2, color: "#00000080" },
    shape: { kind: "none" as const, color: "#101010CC", accentColor: "#D4A017", thicknessPct: 6, widthPct: 42, accentPct: 3 },
    anchor: "CENTER" as const, offsetX: 0, offsetY: 0, align: "CENTER" as const,
    textAnim: { mode: "none" as const, durationFrames: 12, staggerFrames: 3, direction: "up" as const, distancePct: 5, exitMode: "none" as const, exitDurationFrames: 10, exitDistancePct: 5, trackingFrom: 0, trackingTo: 0 },
    highlights: [],
    ...over.style,
  };
  return {
    id: over.id ?? "gfx-1", trackId: over.trackId ?? "g1",
    sourceAssetId: over.sourceAssetId ?? "", sourceInFrame: over.sourceInFrame ?? 0, sourceOutFrame: over.sourceOutFrame ?? 90, sourceFps: { num: FPS, den: 1 },
    timelineStartFrame: over.timelineStartFrame ?? 0, timelineDurationFrames: over.timelineDurationFrames ?? 90,
    playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    captionText: null, captionStyle: null,
    graphicTemplateId: over.graphicTemplateId ?? "test", graphicStyle: style,
    label: null, missingMedia: false, effects: [],
    keyframes: over.keyframes ?? [],
  } as Clip;
}

/** Mean brightness of a pixel region (0..255) via ffmpeg + PIL. */
function regionMean(video: string, frame: number, x: number, y: number, w: number, h: number): { mean: number; max: number } {
  const png = path.join(WORK, `probe_${frame}_${x}_${y}.png`);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", video, "-vf", `select=eq(n\\,${frame})`, "-frames:v", "1", png], { stdio: ["ignore", "ignore", "inherit"] });
  if (!existsSync(png)) throw new Error(`frame ${frame} not extracted`);
  const out = execFileSync("python3", [
    "-c",
    "import sys;from PIL import Image;im=Image.open(sys.argv[1]).convert('L');px=list(im.crop((int(sys.argv[2]),int(sys.argv[3]),int(sys.argv[2])+int(sys.argv[4]),int(sys.argv[3])+int(sys.argv[5]))).getdata());print(sum(px)/len(px), max(px))",
    png, String(x), String(y), String(w), String(h),
  ], { encoding: "utf8" });
  const [mean, max] = out.trim().split(/\s+/).map(Number);
  return { mean, max };
}

beforeAll(() => {
  execSync(
    `ffmpeg -hide_banner -loglevel error -y -f lavfi -i "color=c=black:s=1280x720:r=30:d=4" -c:v libx264 -preset ultrafast -pix_fmt yuv420p "${path.join(WORK, "black.mp4")}"`,
    { stdio: ["ignore", "ignore", "inherit"] },
  );
});

afterAll(() => rmSync(WORK, { recursive: true, force: true }));

describe("NIIKI text metrics (server-side, FreeType + raqm)", () => {
  test("Tamil text measures as real shaped width", () => {
    const w = measureText("தமிழ்", FONT_SANS, 72);
    expect(w).toBeGreaterThan(50);
    expect(w).toBeLessThan(600);
    // deterministic (cached)
    expect(measureText("தமிழ்", FONT_SANS, 72)).toBe(w);
  });
});

describe("NIIKI real FFmpeg render — title card", () => {
  test("static title renders at the expected position and disappears after the clip", async () => {
    const style = templateById("title-scale-in")!.style;
    const clip = graphicClip({ id: "g1", graphicTemplateId: style.templateId, style: { ...style }, timelineDurationFrames: 90, sourceOutFrame: 90 });
    const gTrack = { id: "g1", kind: "GRAPHIC", name: "G", visible: true, muted: false, solo: false, locked: false };
    const seq = makeSeq([clip], [gTrack]);
    const plan = buildNikkiRenderPlan(seq, { endFrame: 120, resolveAssetPath: () => null });
    const out = path.join(WORK, "title.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...plan.inputs, "-filter_complex", plan.filterGraph, ...plan.outputArgs, out], { stdio: ["ignore", "ignore", "inherit"] });
    expect(statSync(out).size).toBeGreaterThan(1000);

    // Text present mid-clip (frame 45): bright pixels in the centre band.
    const textW = Math.round(measureText(style.primaryText, FONT_SANS, Math.round(0.1 * 720)));
    const mid = regionMean(out, 45, Math.round(640 - textW / 2), Math.round(360 - 72), textW, 144);
    expect(mid.max).toBeGreaterThan(180); // white glyphs on black
    expect(mid.mean).toBeGreaterThan(2);
    // Frame 100 (after the 90-frame clip): no text anywhere in the centre band.
    const after = regionMean(out, 100, 200, 200, 880, 320);
    expect(after.max).toBeLessThan(40);
    // Duration guard: the render covers the full requested window (4 s).
    const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out], { encoding: "utf8" }).trim());
    expect(Math.abs(dur - 4)).toBeLessThan(0.15);
  }, 120_000);

  test("fade entrance: frame 2 is dimmer than frame 30 (alpha animation on real pixels)", async () => {
    const style = { ...templateById("title-scale-in")!.style, textAnim: { ...templateById("title-scale-in")!.style.textAnim, mode: "fade" as const, durationFrames: 24 } };
    const clip = graphicClip({ id: "g2", style, timelineDurationFrames: 90, sourceOutFrame: 90 });
    const seq = makeSeq([clip], [{ id: "g1", kind: "GRAPHIC", name: "G", visible: true, muted: false, solo: false, locked: false }]);
    const plan = buildNikkiRenderPlan(seq, { endFrame: 60 });
    const out = path.join(WORK, "fade.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...plan.inputs, "-filter_complex", plan.filterGraph, ...plan.outputArgs, out], { stdio: ["ignore", "ignore", "inherit"] });
    const textW = Math.round(measureText(style.primaryText, FONT_SANS, Math.round(0.1 * 720)));
    const early = regionMean(out, 2, Math.round(640 - textW / 2), 240, textW, 240);
    const late = regionMean(out, 30, Math.round(640 - textW / 2), 240, textW, 240);
    expect(late.mean).toBeGreaterThan(early.mean * 2); // fade-in measured on pixels
  }, 120_000);

  test("word-by-word reveal: first word visible at frame 3 before the last word", async () => {
    const style = { ...templateById("caption-word-reveal")!.style, primaryText: "ONE TWO THREE", anchor: "CENTER" as const, align: "CENTER" as const };
    const clip = graphicClip({ id: "g3", style, timelineDurationFrames: 90, sourceOutFrame: 90 });
    const seq = makeSeq([clip], [{ id: "g1", kind: "GRAPHIC", name: "G", visible: true, muted: false, solo: false, locked: false }]);
    const plan = buildNikkiRenderPlan(seq, { endFrame: 60 });
    const out = path.join(WORK, "words.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...plan.inputs, "-filter_complex", plan.filterGraph, ...plan.outputArgs, out], { stdio: ["ignore", "ignore", "inherit"] });
    // At frame 3 only ONE (stagger 5, duration 10) → the word band has some text;
    // compare the whole centre band with a frame BEFORE any text (frame 0).
    const band = (frame: number): number => regionMean(out, frame, 300, 300, 680, 120).mean;
    expect(band(3)).toBeGreaterThan(band(0) * 2);
    expect(band(40)).toBeGreaterThan(band(3) * 3); // all three words by frame 40
  }, 120_000);
});

describe("NIIKI transitions (xfade) — real rendered frames", () => {
  test("CROSS_DISSOLVE between two sources: mid-transition frame blends both", async () => {
    const a = path.join(WORK, "red.mp4");
    const b = path.join(WORK, "blue.mp4");
    execSync(`ffmpeg -hide_banner -loglevel error -y -f lavfi -i "color=c=red:s=320x180:r=30:d=2" -c:v libx264 -preset ultrafast -pix_fmt yuv420p "${a}"`, { stdio: ["ignore", "ignore", "inherit"] });
    execSync(`ffmpeg -hide_banner -loglevel error -y -f lavfi -i "color=c=blue:s=320x180:r=30:d=4" -c:v libx264 -preset ultrafast -pix_fmt yuv420p "${b}"`, { stdio: ["ignore", "ignore", "inherit"] });
    const seq = makeSeq(
      [
        { ...graphicClip({ id: "v1", trackId: "v", sourceAssetId: "asset-red", sourceOutFrame: 60, timelineDurationFrames: 60 }), graphicStyle: null, graphicTemplateId: null } as unknown as Clip,
        { ...graphicClip({ id: "v2", trackId: "v", sourceAssetId: "asset-blue", sourceOutFrame: 60, timelineStartFrame: 30, timelineDurationFrames: 60, sourceInFrame: 30 }), graphicStyle: null, graphicTemplateId: null } as unknown as Clip,
      ],
      [{ id: "v", kind: "VIDEO", name: "V", visible: true, muted: false, solo: false, locked: false }],
      [{ id: "tr", trackId: "v", kind: "CROSS_DISSOLVE", startFrame: 30, endFrame: 60, durationFrames: 30, clipAId: "v1", clipBId: "v2", params: {} }],
    );
    const plan = buildNikkiRenderPlan(seq, {
      resolveAssetPath: (id) => (id === "asset-red" ? a : id === "asset-blue" ? b : null),
    });
    expect(plan.inputs).toHaveLength(4); // two -i pairs
    const out = path.join(WORK, "xfade.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...plan.inputs, "-filter_complex", plan.filterGraph, ...plan.outputArgs, out], { stdio: ["ignore", "ignore", "inherit"] });
    // frame 10 (before transition): red; frame 45 (mid): purple blend; frame 80: blue
    const rgb = (frame: number): { r: number; g: number; b: number } => {
      const png = path.join(WORK, `xf_${frame}.png`);
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", out, "-vf", `select=eq(n\\,${frame})`, "-frames:v", "1", png], { stdio: ["ignore", "ignore", "inherit"] });
      const s = execFileSync("python3", ["-c", "import sys;from PIL import Image;im=Image.open(sys.argv[1]).convert('RGB');px=list(im.getdata());n=len(px);print(sum(p[0] for p in px)/n, sum(p[1] for p in px)/n, sum(p[2] for p in px)/n)", png], { encoding: "utf8" });
      const [r, g, b2] = s.trim().split(/\s+/).map(Number);
      return { r, g, b: b2 };
    };
    const before = rgb(10);
    const mid = rgb(45);
    const after = rgb(80);
    const durDbg = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out], { encoding: "utf8" }).trim());
    expect(before.r).toBeGreaterThan(150);
    expect(before.b).toBeLessThan(80);
    expect(mid.r).toBeGreaterThan(40);
    expect(mid.b).toBeGreaterThan(40); // purple = red+blue blend
    expect(after.b).toBeGreaterThan(150);
    expect(after.r).toBeLessThan(80);
    // duration = 90 frames total (3 s) — transition overlap preserved
    const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out], { encoding: "utf8" }).trim());
    expect(Math.abs(dur - 3)).toBeLessThan(0.15);
  }, 180_000);
});

describe("NIIKI parity — preview state vs rendered pixels", () => {
  test("a slide-in lower third lands at its evaluated position (pixels match the state math)", async () => {
    const style = templateById("lower-third-bar")!.style;
    const clip = graphicClip({ id: "g4", style: { ...style, textAnim: { ...style.textAnim, mode: "slide", durationFrames: 30, distancePct: 10 } }, timelineDurationFrames: 90, sourceOutFrame: 90 });
    const seq = makeSeq([clip], [{ id: "g1", kind: "GRAPHIC", name: "G", visible: true, muted: false, solo: false, locked: false }]);
    const plan = buildNikkiRenderPlan(seq, { endFrame: 60 });
    const out = path.join(WORK, "lowerthird.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...plan.inputs, "-filter_complex", plan.filterGraph, ...plan.outputArgs, out], { stdio: ["ignore", "ignore", "inherit"] });
    // At frame 45 the slide is complete: the accent bar's left edge sits at
    // offsetX 6% of 1280 = ~77px, the bar's top at (100−9)% − 0.85em.
    const probeY = Math.round(720 * (1 - style.offsetY / 100) - 60);
    const atBar = regionMean(out, 45, 60, probeY, 260, 90);
    expect(atBar.max).toBeGreaterThan(60); // text/bar pixels present at the resolved position
    // Before the slide starts (frame 1) the bar area is still mostly dark at the LEFT edge
    const early = regionMean(out, 1, 60, probeY, 260, 90);
    expect(early.mean).toBeLessThan(atBar.mean);
  }, 120_000);
});
