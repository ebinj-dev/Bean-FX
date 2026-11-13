/**
 * BEAN FX — M4 regression tests: RIISHE proposals → validated timeline
 * commands (src/lib/riishe-timeline.ts).
 *
 * Covered:
 *   1. Interior cut: exact SplitClip/RippleDelete batch; final timeline
 *      positions equal the export math (final = original − removals).
 *   2. Head / tail cuts close gaps via split+ripple (no holes).
 *   3. Whole-clip removal.
 *   4. Multiple cuts in one clip (descending emission; kept material exact).
 *   5. Locked tracks are skipped with warnings, never edited.
 *   6. missingMedia clips, captions and other assets are never touched.
 *   7. Every instance of the analyzed asset is cut (reused media).
 *   8. Idempotence: re-planning after apply yields zero commands.
 *   9. Decision mapping mirrors decisionToReview + the export membership rule.
 *  10. Sub-frame proposals are skipped with an honest warning.
 *  11. Engine atomicity: the batch applies transactionally; a poisoned batch
 *      aborts without mutating the sequence.
 *
 * Run: bun test scripts/test-riishe-timeline.test.ts
 */
import { describe, expect, test } from "bun:test";
import { applyTransaction } from "../src/lib/editor/engine";
import { assertValidSequence, type Clip, type Sequence } from "../src/lib/editor/model";
import { makeRational } from "../src/lib/editor/time";
import { decisionToReview } from "../src/components/bean/tools/auto-cut";
import { effectiveRemovalSec, planRiisheTimelineApply } from "../src/lib/riishe-timeline";
import { normalizeRanges } from "../src/lib/audio-analysis";
import type { SavedDecisionView } from "../src/lib/types";

const FPS = { num: 30, den: 1 };

function mediaClip(
  id: string,
  trackId: string,
  assetId: string,
  sourceInFrame: number,
  sourceOutFrame: number,
  timelineStartFrame: number,
): Clip {
  return {
    id,
    trackId,
    sourceAssetId: assetId,
    sourceInFrame,
    sourceOutFrame,
    sourceFps: FPS,
    timelineStartFrame,
    timelineDurationFrames: sourceOutFrame - sourceInFrame,
    playbackSpeed: 1,
    volume: 1,
    muted: false,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    captionText: null,
    captionStyle: null,
    graphicTemplateId: null,
    label: null,
    missingMedia: false,
    effects: [],
    keyframes: [],
  };
}

/** 10s of asset-a + 4s more of asset-a + 3s of asset-b + caption + missing. */
function baseSequence(): Sequence {
  return {
    id: "seq-m4",
    name: "M4 Test Sequence",
    fps: makeRational(30, 1),
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    tracks: [
      { id: "t-v1", kind: "VIDEO", name: "Video 1", visible: true, muted: false, solo: false, locked: false },
      { id: "t-cap", kind: "CAPTION", name: "Captions", visible: true, muted: false, solo: false, locked: false },
      { id: "t-a1", kind: "AUDIO", name: "Audio 1", visible: true, muted: false, solo: false, locked: false },
    ],
    clips: [
      mediaClip("clip-main", "t-v1", "asset-a", 0, 300, 0), // 0–10 s
      mediaClip("clip-second", "t-v1", "asset-a", 300, 420, 300), // 10–14 s
      mediaClip("clip-b", "t-v1", "asset-b", 0, 90, 420), // untouched asset
      {
        ...mediaClip("clip-cap", "t-cap", "", 0, 30, 510),
        captionText: "hello",
        label: "hello",
        missingMedia: true,
      },
      { ...mediaClip("clip-gone", "t-a1", "asset-gone", 0, 30, 540), missingMedia: true },
    ],
    transitions: [],
  };
}

function apply(seq: Sequence, commands: unknown[]): Sequence {
  const result = applyTransaction(seq, commands);
  expect(result.sequence).toBeDefined();
  const report = assertValidSequence(result.sequence);
  expect(report.errors ?? []).toEqual([]);
  return result.sequence;
}

const bySource = (seq: Sequence, asset: string) =>
  seq.clips.filter((c) => c.sourceAssetId === asset).sort((x, y) => x.timelineStartFrame - y.timelineStartFrame);

describe("M4 — planRiisheTimelineApply", () => {
  test("1. interior cut: exact batch, final positions equal export math", () => {
    const seq = baseSequence();
    const plan = planRiisheTimelineApply({ sequence: seq, removalsSec: [{ start: 4, end: 5 }], sourceAssetId: "asset-a" });
    expect(plan.warnings).toEqual([]);
    expect(plan.stats.clipsMatched).toBe(2); // clip-main + clip-second
    expect(plan.stats.clipsCut).toBe(1);
    expect(plan.commands.length).toBe(3); // Split, Split, RippleDelete
    expect(plan.commands[0]).toMatchObject({ type: "SplitClip", clipId: "clip-main", atTimelineFrame: 120 });
    expect(plan.commands[2]).toMatchObject({ type: "RippleDelete" });

    const out = apply(seq, plan.commands);
    const a = bySource(out, "asset-a");
    expect(a.length).toBe(3); // head piece + rest piece + clip-second
    expect(a[0]).toMatchObject({ sourceInFrame: 0, sourceOutFrame: 120, timelineStartFrame: 0, timelineDurationFrames: 120 });
    expect(a[1]).toMatchObject({ sourceInFrame: 150, sourceOutFrame: 300, timelineStartFrame: 120, timelineDurationFrames: 150 });
    // The asset-b clip and everything after shifted left by exactly 30 frames.
    const b = out.clips.find((c) => c.sourceAssetId === "asset-b");
    expect(b?.timelineStartFrame).toBe(390);
    // Export math: total 570 − 30 removed = 540.
    expect(out.clips.reduce((sum, c) => sum + c.timelineDurationFrames, 0)).toBe(540);
  });

  test("2. head cut closes the gap (kept material starts at the clip start)", () => {
    const seq = baseSequence();
    const plan = planRiisheTimelineApply({ sequence: seq, removalsSec: [{ start: 0, end: 2 }], sourceAssetId: "asset-a" });
    expect(plan.commands.length).toBe(2); // Split + RippleDelete of the head piece
    const out = apply(seq, plan.commands);
    const a = bySource(out, "asset-a");
    expect(a[0]).toMatchObject({ sourceInFrame: 60, sourceOutFrame: 300, timelineStartFrame: 0, timelineDurationFrames: 240 });
    expect(a[1]?.timelineStartFrame).toBe(240); // shifted left by 60, no hole
    expect(out.clips.reduce((sum, c) => sum + c.timelineDurationFrames, 0)).toBe(510);
  });

  test("3. tail cut closes the gap (later clips shift left)", () => {
    const seq = baseSequence();
    const plan = planRiisheTimelineApply({ sequence: seq, removalsSec: [{ start: 8, end: 10 }], sourceAssetId: "asset-a" });
    expect(plan.commands.length).toBe(2);
    const out = apply(seq, plan.commands);
    const a = bySource(out, "asset-a");
    expect(a[0]).toMatchObject({ sourceInFrame: 0, sourceOutFrame: 240, timelineStartFrame: 0, timelineDurationFrames: 240 });
    expect(a[1]?.timelineStartFrame).toBe(240);
    expect(out.clips.reduce((sum, c) => sum + c.timelineDurationFrames, 0)).toBe(510);
  });

  test("4. whole-clip removal is one RippleDelete", () => {
    const seq = baseSequence();
    const plan = planRiisheTimelineApply({ sequence: seq, removalsSec: [{ start: 0, end: 10 }], sourceAssetId: "asset-a" });
    expect(plan.commands).toEqual([{ type: "RippleDelete", clipId: "clip-main" }]);
    expect(plan.stats.clipsRemoved).toBe(1);
    const out = apply(seq, plan.commands);
    const a = bySource(out, "asset-a");
    expect(a.length).toBe(1);
    expect(a[0].id).toBe("clip-second");
    expect(a[0].timelineStartFrame).toBe(0);
    expect(out.clips.reduce((sum, c) => sum + c.timelineDurationFrames, 0)).toBe(270);
  });

  test("5. multiple cuts in one clip: kept material exact, gaps closed", () => {
    const seq = baseSequence();
    const plan = planRiisheTimelineApply({
      sequence: seq,
      removalsSec: [
        { start: 2, end: 3 },
        { start: 6, end: 7 },
      ],
      sourceAssetId: "asset-a",
    });
    expect(plan.commands.length).toBe(6); // 3 commands per cut
    const out = apply(seq, plan.commands);
    const a = bySource(out, "asset-a");
    // Kept source ranges of clip-main: [0,60) [90,180) [210,300)
    expect(a.map((c) => [c.sourceInFrame, c.sourceOutFrame])).toEqual([
      [0, 60],
      [90, 180],
      [210, 300],
      [300, 420],
    ]);
    expect(a.map((c) => c.timelineStartFrame)).toEqual([0, 60, 150, 240]);
    expect(out.clips.reduce((sum, c) => sum + c.timelineDurationFrames, 0)).toBe(510);
  });

  test("6. locked tracks are skipped with a warning and never edited", () => {
    const seq = baseSequence();
    seq.tracks = seq.tracks.map((t) => (t.id === "t-v1" ? { ...t, locked: true } : t));
    const plan = planRiisheTimelineApply({ sequence: seq, removalsSec: [{ start: 4, end: 5 }], sourceAssetId: "asset-a" });
    expect(plan.commands.length).toBe(0);
    expect(plan.stats.skippedLocked).toBe(2);
    expect(plan.warnings.some((w) => w.includes("locked"))).toBe(true);
  });

  test("7. missingMedia clips, captions and other assets are never touched", () => {
    const seq = baseSequence();
    const plan = planRiisheTimelineApply({ sequence: seq, removalsSec: [{ start: 0, end: 14 }], sourceAssetId: "asset-a" });
    // Only the two asset-a clips are cut. The caption and the missing-media
    // clip are skipped by the asset match itself (they are not instances of
    // the analyzed asset), so no missing-media skip is counted here.
    expect(plan.stats.skippedMissingMedia).toBe(0);
    const out = apply(seq, plan.commands);
    expect(out.clips.find((c) => c.id === "clip-cap")).toBeDefined();
    expect(out.clips.find((c) => c.id === "clip-gone")).toBeDefined();
    const b = out.clips.find((c) => c.sourceAssetId === "asset-b");
    expect(b).toMatchObject({ sourceInFrame: 0, sourceOutFrame: 90, timelineStartFrame: 0 });
  });

  test("8. every instance of the analyzed asset is cut (reused media)", () => {
    const seq = baseSequence();
    const plan = planRiisheTimelineApply({ sequence: seq, removalsSec: [{ start: 11, end: 13 }], sourceAssetId: "asset-a" });
    expect(plan.stats.clipsCut).toBe(1);
    const out = apply(seq, plan.commands);
    const a = bySource(out, "asset-a");
    expect(a[0]).toMatchObject({ id: "clip-main", timelineStartFrame: 0, timelineDurationFrames: 300 });
    expect(a[1]).toMatchObject({ sourceInFrame: 300, sourceOutFrame: 330, timelineStartFrame: 300, timelineDurationFrames: 30 });
    expect(a[2]).toMatchObject({ sourceInFrame: 390, sourceOutFrame: 420, timelineStartFrame: 330, timelineDurationFrames: 30 });
    expect(out.clips.reduce((sum, c) => sum + c.timelineDurationFrames, 0)).toBe(510);
  });

  test("9. idempotence: re-planning after apply yields zero commands", () => {
    const seq = baseSequence();
    const removals = [{ start: 4, end: 5 }];
    const plan = planRiisheTimelineApply({ sequence: seq, removalsSec: removals, sourceAssetId: "asset-a" });
    const out = apply(seq, plan.commands);
    const plan2 = planRiisheTimelineApply({ sequence: out, removalsSec: removals, sourceAssetId: "asset-a" });
    expect(plan2.commands.length).toBe(0);
    expect(plan2.stats.clipsCut).toBe(0);
  });

  test("10. decision mapping mirrors decisionToReview + the export membership rule", () => {
    const candidates = [
      { id: "c1", start: 1, end: 2, review: "REMOVE" as const },
      { id: "c2", start: 3, end: 4, review: "REVIEW" as const },
      { id: "c3", start: 5, end: 6, review: "KEEP" as const },
    ];
    const decisions: SavedDecisionView[] = [
      { candidateId: "c1", decision: "REJECT", createdAt: "", updatedAt: "" },
      { candidateId: "c2", decision: "APPROVE", createdAt: "", updatedAt: "" },
    ];
    const removals = effectiveRemovalSec(candidates, decisions, 20);
    // c1's REMOVE verdict is overridden by REJECT; c2 approved; c3 untouched.
    expect(removals).toEqual([{ start: 3, end: 4 }]);

    // Equivalence with the export path for every decision shape.
    for (const decision of [undefined, "APPROVE", "REJECT", "KEEP"] as const) {
      for (const review of ["REMOVE", "REVIEW", "KEEP"] as const) {
        const decs: SavedDecisionView[] =
          decision === undefined
            ? []
            : [{ candidateId: "x", decision, createdAt: "", updatedAt: "" }];
        const expectedCut = (() => {
          const effective = decision ? decisionToReview(decision) : review;
          return effective === "REMOVE" || effective === "APPROVED";
        })();
        const got = effectiveRemovalSec([{ id: "x", start: 0, end: 1, review }], decs, 5);
        expect(got.length === 1).toBe(expectedCut);
      }
    }
  });

  test("11. sub-frame proposals are skipped with an honest warning", () => {
    const seq = baseSequence();
    const plan = planRiisheTimelineApply({ sequence: seq, removalsSec: [{ start: 4, end: 4.01 }], sourceAssetId: "asset-a" });
    expect(plan.commands.length).toBe(0);
    expect(plan.stats.cutsSkippedSubFrame).toBe(1);
    expect(plan.warnings.some((w) => w.includes("smaller than one frame"))).toBe(true);
  });

  test("12. engine atomicity: a poisoned batch aborts without mutating", () => {
    const seq = baseSequence();
    const before = JSON.stringify(seq);
    const plan = planRiisheTimelineApply({ sequence: seq, removalsSec: [{ start: 4, end: 5 }], sourceAssetId: "asset-a" });
    const poisoned = [...plan.commands, { type: "SplitClip", clipId: "does-not-exist", atTimelineFrame: 1, newLeftId: "a", newRightId: "b" }];
    expect(() => applyTransaction(seq, poisoned)).toThrow(/transaction aborted/);
    expect(JSON.stringify(seq)).toBe(before);
  });

  test("13. normalizeRanges reuse: overlapping proposals never double-count", () => {
    const candidates = [
      { id: "c1", start: 1, end: 4, review: "REMOVE" as const },
      { id: "c2", start: 3, end: 5, review: "REMOVE" as const },
    ];
    expect(effectiveRemovalSec(candidates, [], 20)).toEqual([{ start: 1, end: 5 }]);
  });

  test("14. piece ids are unique, bounded and collision-free across plans", () => {
    const seq = baseSequence();
    const planA = planRiisheTimelineApply({ sequence: seq, removalsSec: [{ start: 4, end: 5 }], sourceAssetId: "asset-a" });
    const planB = planRiisheTimelineApply({
      sequence: seq,
      removalsSec: [{ start: 11, end: 13 }],
      sourceAssetId: "asset-a",
      reservedIds: planA.commands.filter((c) => c.type === "SplitClip").map((c) => (c as { newRightId?: string }).newRightId ?? ""),
    });
    const idsA = new Set(planA.commands.filter((c) => c.type === "SplitClip").map((c) => (c as { newRightId: string }).newRightId));
    const idsB = planB.commands.filter((c) => c.type === "SplitClip").map((c) => (c as { newRightId: string }).newRightId);
    for (const id of idsB) expect(idsA.has(id)).toBe(false);
    for (const id of [...idsA, ...idsB]) expect(id.length).toBeLessThanOrEqual(64);
  });
});
