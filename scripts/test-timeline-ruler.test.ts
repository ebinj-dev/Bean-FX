import { describe, expect, test } from "bun:test";
import { formatTimeLabel, minorSubdivision, niceStep } from "../src/lib/timeline-ruler";

describe("timeline ruler math", () => {
  test("major steps are never hardcoded and follow the 1/2/5 family", () => {
    // 31.66 s full view → 8 divisions ≈ 3.96 s → step 5 s
    expect(niceStep(31.660408 / 8)).toBe(5);
    // 20-minute recording → 150 s → step 200 s
    expect(niceStep(1200 / 8)).toBe(200);
    // 2 s zoom window → 0.25 → step 0.2
    expect(niceStep(2 / 8)).toBe(0.2);
    // 40 s view → 5 s → step 5
    expect(niceStep(40 / 8)).toBe(5);
  });

  test("minor subdivisions stay in the same family", () => {
    expect(minorSubdivision(5)).toBe(1);
    expect(minorSubdivision(2)).toBe(0.5);
    expect(minorSubdivision(1)).toBe(0.2);
    expect(minorSubdivision(200)).toBe(50);
    expect(minorSubdivision(0.2)).toBeCloseTo(0.05, 10);
  });

  test("professional zero-padded timecodes at every zoom (the three brief examples)", () => {
    // Fit view — minute steps read MM:SS: 00:00 | 03:20 | 06:40 | 10:00 | 16:40
    expect(formatTimeLabel(0, 200)).toBe("00:00");
    expect(formatTimeLabel(200, 200)).toBe("03:20");
    expect(formatTimeLabel(1000, 200)).toBe("16:40");
    expect(formatTimeLabel(120, 120)).toBe("02:00");
    // Medium zoom — 30 s steps still read MM:SS: 00:00 | 00:30 | 01:00 | 01:30
    expect(formatTimeLabel(30, 30)).toBe("00:30");
    expect(formatTimeLabel(60, 30)).toBe("01:00");
    expect(formatTimeLabel(90, 30)).toBe("01:30");
    // Deep zoom — sub-minute steps carry the hours group:
    // 00:28:30 | 00:28:45 | 00:29:00 | 00:29:15
    expect(formatTimeLabel(1710, 15)).toBe("00:28:30");
    expect(formatTimeLabel(1725, 15)).toBe("00:28:45");
    expect(formatTimeLabel(1740, 15)).toBe("00:29:00");
    expect(formatTimeLabel(1755, 15)).toBe("00:29:15");
    expect(formatTimeLabel(45, 5)).toBe("00:00:45");
    // Sub-second steps append fractional seconds.
    expect(formatTimeLabel(8.25, 0.05)).toBe("00:00:08.25");
    expect(formatTimeLabel(8.2, 0.2)).toBe("00:00:08.2");
    // Past one hour the hours group always shows.
    expect(formatTimeLabel(3600, 200)).toBe("01:00:00");
    expect(formatTimeLabel(3661, 1)).toBe("01:01:01");
  });

  test("labels are immune to float drift on accumulated ticks", () => {
    // t accumulated as 0.1 × 600 in floats lands near 59.9999… → must still
    // label the 00:01:00 tick correctly (sub-second steps keep the fractional
    // group; second steps don't).
    let t = 0;
    for (let i = 0; i < 600; i++) t += 0.1;
    expect(formatTimeLabel(t, 0.5)).toBe("00:01:00.0");
    expect(formatTimeLabel(t, 1)).toBe("00:01:00");
    // An hour accumulated in small steps still labels exactly.
    let h = 0;
    for (let i = 0; i < 36000; i++) h += 0.1;
    expect(formatTimeLabel(h, 1)).toBe("01:00:00");
    expect(formatTimeLabel(h, 200)).toBe("01:00:00");
  });

  test("minors stay readable at every realistic zoom of a 708px timeline", () => {
    const W = 708;
    // By construction major ≈ viewDur/8 (1/2/5 family) and minor = major/4..5,
    // so minor spacing stays ≈ 15-20 px on the real timeline width.
    for (const viewDur of [0.5, 2, 7.8, 31.66, 46, 300, 1200, 3600]) {
      const step = niceStep(viewDur / 8);
      const minor = minorSubdivision(step);
      expect(minor * (W / viewDur)).toBeGreaterThan(7);
    }
    // The 7px guard exists for narrow canvases: at 40px width minors hide.
    const narrow = 40;
    const viewDur = 46;
    const minor = minorSubdivision(niceStep(viewDur / 8));
    expect(minor * (narrow / viewDur) >= 7).toBe(false);
  });
});
