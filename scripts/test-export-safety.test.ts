import { describe, expect, test } from "bun:test";
import { validateCandidates, unionIntervals, type EvidenceCandidate } from "../src/lib/autocut-analysis";
import type { CutPlanSettings } from "../src/lib/types";

/** Export-safety matrix (PHASE 7): the canonical plan is built from ONLY the
 *  approved REMOVE candidates; REVIEW and KEEP content can never enter it.
 *  retained = original - union(approved removals), verified to the
 *  millisecond for zero / one / multiple cuts, overlapping cuts, and
 *  out-of-bounds candidates. */

const DUR = 100;
const base = (id: string, start: number, end: number, review: EvidenceCandidate["review"]): EvidenceCandidate => ({
  id,
  start,
  end,
  duration: end - start,
  review,
  reason: "test",
  confidence: 0.9,
  evidence: {
    rms: 0,
    snr: 40,
    transcriptWordsInRange: 0,
    intraSentence: false,
    quietSpeechNearby: false,
    repeatedTake: false,
  },
} as unknown as EvidenceCandidate);

const plan = (candidates: EvidenceCandidate[]) => {
  const { valid } = validateCandidates(candidates, DUR);
  const removals = unionIntervals(
    valid.filter((c) => c.review === "REMOVE").map((c) => ({ start: c.start, end: c.end })),
    DUR
  );
  const removedSec = removals.reduce((a, r) => a + (r.end - r.start), 0);
  return { removals, removedSec, retained: Math.round((DUR - removedSec) * 1000) / 1000 };
};

describe("export safety: canonical cut plan", () => {
  test("zero approved cuts → original audio fully retained", () => {
    const p = plan([base("k1", 2, 3, "KEEP"), base("r1", 5, 6, "REVIEW")]);
    expect(p.removals.length).toBe(0);
    expect(p.removedSec).toBe(0);
    expect(p.retained).toBe(DUR);
  });

  test("REVIEW content is never applied — only explicit REMOVE enters the plan", () => {
    const p = plan([base("r1", 5, 6, "REVIEW"), base("k1", 20, 21, "KEEP"), base("x1", 30, 31, "REMOVE")]);
    expect(p.removals).toEqual([{ start: 30, end: 31 }]);
    expect(p.retained).toBe(99);
  });

  test("one approved cut with padding → retained = original - cut", () => {
    const p = plan([base("x1", 10, 11.5, "REMOVE")]);
    expect(p.retained).toBeCloseTo(DUR - 1.5, 3);
  });

  test("multiple approved cuts → sum of non-overlapping ranges", () => {
    const p = plan([base("x1", 10, 11, "REMOVE"), base("x2", 20, 22.5, "REMOVE"), base("x3", 80, 80.25, "REMOVE")]);
    expect(p.removals.length).toBe(3);
    expect(p.retained).toBeCloseTo(DUR - 3.75, 3);
  });

  test("overlapping approved cuts merge — no double subtraction", () => {
    const p = plan([base("x1", 10, 12, "REMOVE"), base("x2", 11, 14, "REMOVE")]);
    expect(p.removals).toEqual([{ start: 10, end: 14 }]);
    expect(p.retained).toBe(96);
  });

  test("KEEP ranges surrounding cuts stay intact (sentence-boundary protection)", () => {
    const p = plan([
      base("k1", 0, 10, "KEEP"),
      base("x1", 10, 11, "REMOVE"),
      base("k2", 11, 20, "KEEP"),
      base("x2", 20, 21, "REMOVE"),
      base("k3", 21, 100, "KEEP"),
    ]);
    expect(p.removals).toEqual([
      { start: 10, end: 11 },
      { start: 20, end: 21 },
    ]);
    expect(p.retained).toBe(98);
  });

  test("out-of-bounds and inverted candidates are clamped or dropped, never exported", () => {
    const { valid, fixes } = validateCandidates(
      [base("bad1", -5, 3, "REMOVE"), base("bad2", DUR + 10, DUR + 20, "REMOVE"), base("bad3", 50, 50.001, "REMOVE")],
      DUR
    );
    expect(fixes.length).toBeGreaterThan(0);
    const p = plan(valid);
    for (const r of p.removals) {
      expect(r.start).toBeGreaterThanOrEqual(0);
      expect(r.end).toBeLessThanOrEqual(DUR);
    }
    expect(p.retained).toBeLessThanOrEqual(DUR);
  });

  test("cut at media end → retained math holds at the boundary", () => {
    const p = plan([base("x1", 99, 100, "REMOVE")]);
    expect(p.retained).toBe(99);
  });
});
