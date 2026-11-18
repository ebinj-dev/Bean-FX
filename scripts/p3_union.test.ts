/**
 * P3 Phase G — isolated unit tests for the export-union logic used by the
 * Auto Cut apply flow. Run: bun test scripts/p3_union.test.ts
 * (no database, no network, no live media involved).
 *
 * NOTE: the former `decisionToReview` describe block was removed — that
 * helper no longer exists in auto-cut.tsx (the export-plan membership rule
 * now lives inline as review === "REMOVE" || review === "APPROVED" and is
 * exercised end-to-end by the P3 shell suite). This file kept failing on
 * main since that refactor; the import of a dead symbol was the only cause.
 */
import { describe, expect, test } from "bun:test";
import { normalizeRanges } from "../src/lib/audio-analysis";

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
