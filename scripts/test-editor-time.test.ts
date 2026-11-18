import { describe, expect, test } from "bun:test";
import {
  crossTimebase,
  formatTimecode,
  framesToSamples,
  framesToSeconds,
  makeRational,
  rationalFromFps,
  samplesToFrames,
  secondsToFrames,
} from "../src/lib/editor/time";

describe("editor rational time model", () => {
  test("rational fps families are exact", () => {
    expect(rationalFromFps(29.97)).toEqual({ num: 30000, den: 1001 });
    expect(rationalFromFps(59.94)).toEqual({ num: 60000, den: 1001 });
    expect(rationalFromFps(23.976)).toEqual({ num: 24000, den: 1001 });
    expect(rationalFromFps(25)).toEqual({ num: 25, den: 1 });
    expect(rationalFromFps(24)).toEqual({ num: 24, den: 1 });
    expect(rationalFromFps(30)).toEqual({ num: 30, den: 1 });
    expect(rationalFromFps(23.976123)).toEqual({ num: 23976, den: 1000 }); // unknown decimal → 1000-base
    expect(() => makeRational(0, 1)).toThrow();
    expect(() => makeRational(3, 0)).toThrow();
    expect(() => makeRational(1.5, 2)).toThrow();
  });

  test("seconds→frames rounding policy is explicit and integer", () => {
    const fps24 = makeRational(24, 1);
    expect(secondsToFrames(0.5, fps24)).toBe(12);
    expect(secondsToFrames(2, fps24)).toBe(48);
    const fps2997 = makeRational(30000, 1001);
    expect(secondsToFrames(1, fps2997)).toBe(30); // 29.97 rounds to 30
    expect(Number.isInteger(secondsToFrames(0.1234, fps2997))).toBe(true);
    expect(() => secondsToFrames(Number.NaN, fps24)).toThrow();
  });

  test("frames↔seconds round-trip stays inside one frame", () => {
    const fps = makeRational(30000, 1001);
    for (const f of [0, 1, 25, 300, 30_000, 107_891]) {
      const back = secondsToFrames(framesToSeconds(f, fps), fps);
      expect(Math.abs(back - f)).toBeLessThanOrEqual(1);
    }
  });

  test("cross-timebase conversion is integer and sane", () => {
    // 1 second of 25 fps media (25 frames) into 30000/1001 ≈ 30 frames
    expect(crossTimebase(25, makeRational(25, 1), makeRational(30000, 1001))).toBe(30);
    // 30 frames of 29.97 into 24 fps ≈ 24
    expect(crossTimebase(30, makeRational(30000, 1001), makeRational(24, 1))).toBe(24);
  });

  test("sample-accurate audio mapping round-trips", () => {
    const fps = makeRational(30000, 1001);
    const rate = 48000;
    for (const f of [0, 1, 30, 1601, 30_000]) {
      const s = framesToSamples(f, fps, rate);
      expect(Number.isInteger(s)).toBe(true);
      expect(Math.abs(samplesToFrames(s, fps, rate) - f)).toBeLessThanOrEqual(1);
    }
    expect(framesToSamples(1, makeRational(24, 1), 48000)).toBe(2000);
    expect(() => framesToSamples(1, fps, 0)).toThrow();
  });

  test("non-drop timecode at every rate", () => {
    expect(formatTimecode(0, makeRational(25, 1))).toBe("00:00:00:00");
    expect(formatTimecode(25, makeRational(25, 1))).toBe("00:00:01:00");
    expect(formatTimecode(30, makeRational(30000, 1001))).toBe("00:00:01:00");
    expect(formatTimecode(45, makeRational(24, 1))).toBe("00:00:01:21");
    // 1 hour of 25fps = 90000 frames
    expect(formatTimecode(90_000, makeRational(25, 1))).toBe("01:00:00:00");
  });

  test("drop-frame timecode follows the SMPTE rules at 29.97 and 59.94", () => {
    const fps2997 = makeRational(30000, 1001);
    const fps5994 = makeRational(60000, 1001);
    // Minute 0 is unaffected.
    expect(formatTimecode(0, fps2997, true)).toBe("00:00:00;00");
    expect(formatTimecode(29, fps2997, true)).toBe("00:00:00;29");
    // f=1799 is the last frame of minute 0 (59.966 s) → 00:00:59;29
    expect(formatTimecode(1799, fps2997, true)).toBe("00:00:59;29");
    // The first frame after the boundary skips ;00 and ;01 → ;02
    expect(formatTimecode(1800, fps2997, true)).toBe("00:01:00;02");
    // Every tenth minute keeps 00 — 10 min of 29.97 = 17982 frames.
    expect(formatTimecode(17_982, fps2997, true)).toBe("00:10:00;00");
    // One wall hour = 107892 continuous frames → 01:00:00;00 exactly.
    expect(formatTimecode(107_892, fps2997, true)).toBe("01:00:00;00");
    // 59.94 drops 4 per minute: first boundary at f=3600 → 00:01:00;04
    expect(formatTimecode(3600, fps5994, true)).toBe("00:01:00;04");
    // Drop flag is ignored for integer rates (documented, not guessed).
    expect(formatTimecode(1800, makeRational(30, 1), true)).toBe("00:01:00:00");
  });

  test("invalid ranges are rejected loudly", () => {
    expect(() => formatTimecode(-1, makeRational(25, 1))).toThrow();
    expect(() => formatTimecode(1.5, makeRational(25, 1))).toThrow();
  });
});
