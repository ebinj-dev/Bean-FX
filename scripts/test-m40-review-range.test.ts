/**
 * BEAN FX — M40 §7/§8: review preview range derivation (unit).
 *
 * The review detail/list/guest surfaces derive the timeline range read-only
 * from the preview export's OWN render params — immutable M30 revisions are
 * never written to, legacy/full-timeline previews stay null (never invented),
 * and unreadable records stay silent rather than guessing.
 *
 * Run: bun test scripts/test-m40-review-range.test.ts
 */
import { describe, test, expect } from "bun:test";

const { previewRangeFromParams } = await import("../src/lib/review-access");

describe("M40 §7 — previewRangeFromParams (review range derivation)", () => {
  test("partial range parses frames + fps exactly as recorded (never rounded timestamps)", () => {
    expect(previewRangeFromParams(JSON.stringify({ projectId: "p", startFrame: 15, endFrame: 60, fps: "30/1" }))).toEqual({ startFrame: 15, endFrame: 60, fps: "30/1" });
    expect(previewRangeFromParams(JSON.stringify({ startFrame: 0, endFrame: 90, fps: "24000/1001" }))).toEqual({ startFrame: 0, endFrame: 90, fps: "24000/1001" });
  });

  test("start-only and end-only ranges normalize without inventing a boundary", () => {
    expect(previewRangeFromParams(JSON.stringify({ startFrame: 30 }))).toEqual({ startFrame: 30, endFrame: 0, fps: null });
    expect(previewRangeFromParams(JSON.stringify({ endFrame: 45, fps: "30/1" }))).toEqual({ startFrame: 0, endFrame: 45, fps: "30/1" });
  });

  test("legacy/full-timeline records (no range keys) yield null — never a guessed range", () => {
    expect(previewRangeFromParams(JSON.stringify({ projectId: "p", fps: "30/1" }))).toBeNull();
    expect(previewRangeFromParams(JSON.stringify({}))).toBeNull();
    expect(previewRangeFromParams(null)).toBeNull();
    expect(previewRangeFromParams(undefined)).toBeNull();
  });

  test("negative/malformed values are not treated as ranges", () => {
    expect(previewRangeFromParams(JSON.stringify({ startFrame: -5, endFrame: 30 }))).toBeNull(); // malformed field → record untrustworthy
    expect(previewRangeFromParams(JSON.stringify({ startFrame: 1.5, endFrame: 30 }))).toBeNull();
    expect(previewRangeFromParams(JSON.stringify({ startFrame: 0, endFrame: 0 }))).toBeNull();
  });

  test("unreadable records stay silent (no throw, no guess)", () => {
    expect(previewRangeFromParams("not-json{")).toBeNull();
    expect(previewRangeFromParams("[1,2,3]")).toBeNull();
  });

  test("non-string fps is dropped, not invented", () => {
    expect(previewRangeFromParams(JSON.stringify({ startFrame: 0, endFrame: 30, fps: 30 }))).toEqual({ startFrame: 0, endFrame: 30, fps: null });
  });
});
