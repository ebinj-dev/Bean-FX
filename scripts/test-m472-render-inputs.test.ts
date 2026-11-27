/**
 * M47.2-A (M46.1 render-integrity hotfix) — input-mapping regression tests.
 *
 * The reported defect: the normal render path passed an EMPTY asset map plus
 * a reference-keyed plan map to buildTimelineGraph, which RE-COLLECTS plans
 * (fresh objects) — every lookup missed, every plan was filtered out, and the
 * render produced a valid H.264/AAC file full of black frames and silence.
 * These tests pin the contract: content-keyed plan identity, deterministic
 * allocation, loud invariant failures, and the legacy asset-map fallback.
 *
 * Run: bun test scripts/test-m472-render-inputs.test.ts
 */
import { describe, test, expect } from "bun:test";
import { buildTimelineGraph, allocateRenderInputs, planOccurrenceKey, type RenderInputEntry } from "../src/lib/publish/timeline-render";
import { model } from "./m17-imports";

const fps = { num: 30, den: 1 };

const clip = (over: Record<string, unknown> = {}) =>
  model.ClipSchema.parse({
    id: "c0", trackId: "v1", sourceAssetId: "assetA", sourceInFrame: 0, sourceOutFrame: 60, sourceFps: fps,
    timelineStartFrame: 0, timelineDurationFrames: 60, playbackSpeed: 1, volume: 1, muted: false,
    fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
    keyframes: [], missingMedia: false, effects: [],
    ...over,
  } as never);

const seqWith = (clips: unknown[]) =>
  model.SequenceSchema.parse({
    id: "seq", name: "seq", sampleRate: 48000, width: 320, height: 240, fps,
    tracks: [
      { id: "v1", name: "V1", kind: "VIDEO", visible: true, muted: false, solo: false, locked: false },
      { id: "a1", name: "A1", kind: "AUDIO", visible: true, muted: false, solo: false, locked: false },
    ],
    clips, transitions: [],
  });

const entry = (index: number, hasAudio = true): RenderInputEntry => ({ index, isImage: false, hasAudio });

describe("planOccurrenceKey — content identity, not object identity", () => {
  test("structurally identical plans from independent collections share one key", () => {
    // The M46.1 bug scenario: the caller collects plans, the graph builder
    // re-collects them — different objects, same content → same key.
    const a = { clip: clip(), trackIndex: 0, winStartFrame: 0, winEndFrame: 60 };
    const b = { clip: clip(), trackIndex: 0, winStartFrame: 0, winEndFrame: 60 };
    expect(a === b).toBe(false); // different references...
    expect(planOccurrenceKey(a)).toBe(planOccurrenceKey(b)); // ...same identity
  });

  test("different windows of the same clip get distinct keys", () => {
    const a = { clip: clip(), trackIndex: 0, winStartFrame: 0, winEndFrame: 60 };
    const b = { clip: clip(), trackIndex: 0, winStartFrame: 60, winEndFrame: 120 };
    expect(planOccurrenceKey(a)).not.toBe(planOccurrenceKey(b));
  });
});

describe("allocateRenderInputs — deterministic per-occurrence allocation", () => {
  const assetById = new Map([
    ["assetA", { id: "assetA", kind: "VIDEO", storagePath: "/tmp/a.mp4" }],
    ["assetImg", { id: "assetImg", kind: "IMAGE", storagePath: "/tmp/img.png" }],
  ]);
  const hasAudio = new Map([["assetA", true], ["assetImg", false]]);

  test("repeated source across plans → one input per occurrence, asset mirror keeps the first", () => {
    const plans = [
      { clip: clip({ id: "c1" }), trackIndex: 0, winStartFrame: 0, winEndFrame: 30 },
      { clip: clip({ id: "c2" }), trackIndex: 0, winStartFrame: 30, winEndFrame: 60 },
      { clip: clip({ id: "c3" }), trackIndex: 0, winStartFrame: 60, winEndFrame: 90 },
    ];
    const { inputArgs, inputByPlanKey, usedByAsset } = allocateRenderInputs(plans, assetById, hasAudio, 30);
    expect(inputArgs.filter((x) => x === "-i")).toHaveLength(3); // one per occurrence
    expect(new Set([...inputByPlanKey.values()].map((e) => e.index))).toEqual(new Set([0, 1, 2]));
    expect(usedByAsset.get("assetA")?.index).toBe(0); // first occurrence mirrored
    // All three plans resolve through the SAME routine the graph builder uses.
    for (const p of plans) expect(inputByPlanKey.get(planOccurrenceKey(p))).toBeDefined();
  });

  test("visual + audio occurrences of ONE clip share a single input", () => {
    // A video clip with audio is collected twice (visual plan + audio plan).
    const v = { clip: clip(), trackIndex: 0, winStartFrame: 0, winEndFrame: 60 };
    const a = { clip: clip(), trackIndex: 0, winStartFrame: 0, winEndFrame: 60 };
    const { inputByPlanKey, inputArgs } = allocateRenderInputs([v, a], assetById, hasAudio, 30);
    expect(inputByPlanKey.get(planOccurrenceKey(v))?.index).toBe(inputByPlanKey.get(planOccurrenceKey(a))?.index);
    expect(inputArgs.filter((x) => x === "-i")).toHaveLength(1);
  });

  test("image input carries its own plan's window as -t", () => {
    const img = { clip: clip({ id: "i1", sourceAssetId: "assetImg", sourceOutFrame: 90, timelineDurationFrames: 90, sourceFps: fps }), trackIndex: 0, winStartFrame: 30, winEndFrame: 120 };
    const { inputArgs } = allocateRenderInputs([img], assetById, hasAudio, 30);
    const tIdx = inputArgs.indexOf("-t");
    expect(inputArgs[tIdx + 1]).toBe("3"); // 90 frames @30fps, from the plan's own window (q() formats integers plainly)
  });
});

describe("buildTimelineGraph — the M46.1 regression pinned", () => {
  test("content-keyed planInputs + EMPTY asset map still resolves every input (was: black + silence)", () => {
    const seq = seqWith([clip()]);
    // Exactly the shape that used to produce a valid-but-black file: the
    // caller allocates per occurrence; the graph re-collects plans.
    const planKey = planOccurrenceKey({ clip: clip(), trackIndex: 0, winStartFrame: 0, winEndFrame: 60 });
    const planInputs = new Map([[planKey, entry(0)]]);
    const g = buildTimelineGraph(seq, 0, 60, new Map(), undefined, undefined, planInputs);
    expect(g.videoPlanCount).toBe(1);
    expect(g.audioPlanCount).toBe(1);
    // The trim chain must actually reference input 0 (not an empty composite).
    expect(g.filterComplex).toContain("trim=start=");
    expect(g.filterComplex).toContain("[0:v]");
    expect(g.skippedMissing).toBe(0);
  });

  test("legacy per-asset map (populated) keeps working — long-form callers unaffected", () => {
    const seq = seqWith([clip()]);
    const g = buildTimelineGraph(seq, 0, 60, new Map([["assetA", entry(0)]]));
    expect(g.videoPlanCount).toBe(1);
    expect(g.audioPlanCount).toBe(1);
  });

  test("unresolvable plan is skipped and COUNTED at graph level (documented disclose semantics) — the render path fails on it via skippedMissing", () => {
    const seq = seqWith([clip()]);
    // The graph builder keeps the m16-core skip-and-disclose contract;
    // runTimelineRenderJob turns skippedMissing > 0 into a loud pre-ffmpeg
    // abort (INVARIANT 3) — silent black output is unreachable from the
    // real render path either way.
    const g = buildTimelineGraph(seq, 0, 60, new Map());
    expect(g.skippedMissing).toBe(1);
    expect(g.videoPlanCount).toBe(0);
    expect(g.filterComplex).not.toContain("assetA");
  });

  test("video-only source produces audio plans=0 without breaking the video graph", () => {
    const seq = seqWith([clip()]);
    const noAudio = new Map<string, RenderInputEntry>([["assetA", { index: 0, isImage: false, hasAudio: false }]]);
    const g = buildTimelineGraph(seq, 0, 60, noAudio);
    expect(g.videoPlanCount).toBe(1);
    expect(g.audioPlanCount).toBe(0);
    expect(g.filterComplex).toContain("amix=inputs=1"); // silence bed only
  });
});
