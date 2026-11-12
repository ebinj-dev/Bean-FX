/**
 * P3 Phase G — isolated unit tests for the persisted-decision mapping and the
 * existing export-union logic. Run: bun test scripts/p3_union.test.ts
 * (no database, no network, no live media involved).
 */
import { describe, expect, test } from "bun:test";
import { normalizeRanges } from "../src/lib/audio-analysis";
import { decisionToReview } from "../src/components/bean/tools/auto-cut";
import type { CutDecisionValue } from "../src/lib/types";

describe("decisionToReview (restored-decision mapping)", () => {
  test("APPROVE lands in the export plan (REMOVE) — the state the union consumes", () => {
    expect(decisionToReview("APPROVE" as CutDecisionValue)).toBe("REMOVE");
  });
  test("REJECT stays out of the plan (REVIEW)", () => {
    expect(decisionToReview("REJECT" as CutDecisionValue)).toBe("REVIEW");
  });
  test("KEEP stays out of the plan (KEEP)", () => {
    expect(decisionToReview("KEEP" as CutDecisionValue)).toBe("KEEP");
  });
});

describe("normalizeRanges (existing union logic used by startApply — unchanged)", () => {
  test("overlapping approved intervals merge into one union interval (#13)", () => {
    const out = normalizeRanges(
      [
        { start: 10, end: 12 },
        { start: 11, end: 14 },
      ],
      60
    );
    expect(out.length).toBe(1);
    expect(out[0].start).toBe(10);
    expect(out[0].end).toBe(14);
  });
  test("multiple overlapping groups normalize independently", () => {
    const out = normalizeRanges(
      [
        { start: 5, end: 6 },
        { start: 5.5, end: 7 },
        { start: 20, end: 21 },
        { start: 20.5, end: 22 },
      ],
      60
    );
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({ start: 5, end: 7 });
    expect(out[1]).toMatchObject({ start: 20, end: 22 });
  });
  test("union removes exactly the union duration — kept material untouched", () => {
    const out = normalizeRanges(
      [
        { start: 1, end: 2 },
        { start: 1.5, end: 2.5 },
        { start: 2.4, end: 3 },
      ],
      10
    );
    const removed = out.reduce((a, r) => a + (r.end - r.start), 0);
    expect(out.length).toBe(1);
    expect(removed).toBeCloseTo(2, 5); // [1,3)
  });
});
