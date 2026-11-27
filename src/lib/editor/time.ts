/**
 * BEAN FX — Editor time model (Milestone 1, shared editing core).
 *
 * The authoritative editing clock is INTEGER FRAMES on the sequence's rational
 * frame rate. Floating-point seconds exist only for display and for the
 * explicit conversions below — never as stored editing state. This follows
 * the directive (§8): frame-based/rational time, no float seconds as the
 * authoritative clock, sample-accurate audio positions, drop-frame timecode
 * where applicable, and hard failures on invalid durations.
 *
 * Everything here is pure and unit-tested (scripts/test-editor-time.test.ts).
 */

export interface Rational {
  /** Always positive integers; den > 0. */
  num: number;
  den: number;
}

const FRAME_EPSILON = 1e-9;

export function makeRational(num: number, den: number): Rational {
  if (!Number.isInteger(num) || !Number.isInteger(den) || num <= 0 || den <= 0) {
    throw new Error(`invalid rational ${num}/${den} — both parts must be positive integers`);
  }
  return { num, den };
}

/** Convert a decimal fps (29.97, 59.94, 25, 24 …) to the broadcast-exact
 *  rational when it matches the known families, otherwise a 1000-based one. */
export function rationalFromFps(fps: number): Rational {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`invalid fps ${fps}`);
  // Exact match on the SMPTE families first.
  const known: Array<[number, Rational]> = [
    [23.976, makeRational(24000, 1001)],
    [29.97, makeRational(30000, 1001)],
    [59.94, makeRational(60000, 1001)],
    [47.952, makeRational(48000, 1001)],
  ];
  for (const [value, rat] of known) {
    if (Math.abs(fps - value) < FRAME_EPSILON) return rat;
  }
  if (Number.isInteger(fps)) return makeRational(fps, 1);
  return makeRational(Math.round(fps * 1000), 1000);
}

export function rationalToNumber(r: Rational): number {
  return r.num / r.den;
}

/** Seconds → whole frames (the only seconds→frames conversion; snap policy:
 *  round-half-up at the half-frame boundary so a 0.5 s clip at 24 fps lands
 *  on frame 12, and callers receive integers, never fractions). */
export function secondsToFrames(seconds: number, fps: Rational): number {
  if (!Number.isFinite(seconds)) throw new Error(`invalid seconds ${seconds}`);
  return Math.round((seconds * fps.num) / fps.den);
}

/** Frames → seconds. Display/conversion helper — never stored editing state. */
export function framesToSeconds(frames: number, fps: Rational): number {
  return (frames * fps.den) / fps.num;
}

/** Map a frame position between two timebases (e.g. source media at 25 fps
 *  into a 30000/1001 sequence) — integer, rounding only at the final step.
 *  Seconds = f * from.den / from.num; target frames = seconds * to.num/to.den. */
export function crossTimebase(frames: number, from: Rational, to: Rational): number {
  return Math.round((frames * from.den * to.num) / (from.num * to.den));
}

/** Sample-accurate audio position for a frame position (spec §8). */
export function framesToSamples(frames: number, fps: Rational, sampleRate: number): number {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error(`invalid sample rate ${sampleRate}`);
  return Math.round((frames * sampleRate * fps.den) / fps.num);
}

export function samplesToFrames(samples: number, fps: Rational, sampleRate: number): number {
  if (!Number.isInteger(samples) || samples < 0) throw new Error(`invalid sample count ${samples}`);
  return Math.round((samples * fps.num) / (sampleRate * fps.den));
}

/**
 * SMPTE timecode. `drop` may be requested only for 30000/1001 and
 * 60000/1001; for all other rates it is ignored (documented, not guessed).
 *
 * Canonical drop-frame conversion (29.97: 2 frames skipped at the start of
 * every minute except every tenth; 59.94: 4): the continuous frame count is
 * mapped onto nominal-fps numbering by adding the dropped count back, so
 * 01:00:00;00 lands exactly one hour of wall time in.
 */
const DROP_PER_MINUTE: Record<number, number> = { 30: 2, 60: 4 }; // nominal fps → dropped frames

export function formatTimecode(frames: number, fps: Rational, drop = false): string {
  if (!Number.isInteger(frames) || frames < 0) throw new Error(`invalid frame count ${frames}`);
  const isDropFamily = (fps.num === 30000 && fps.den === 1001) || (fps.num === 60000 && fps.den === 1001);
  const useDrop = drop && isDropFamily;
  const nominalFps = Math.round(rationalToNumber(fps)); // 30 or 60 for the drop families
  let count = frames;
  if (useDrop) {
    const dropFrames = DROP_PER_MINUTE[nominalFps];
    const framesPerMinute = nominalFps * 60 - dropFrames;
    const framesPer10Minutes = nominalFps * 600 - dropFrames * 9;
    const tenMinuteBlocks = Math.floor(count / framesPer10Minutes);
    const remainder = count % framesPer10Minutes;
    const adjustment =
      remainder > dropFrames ? dropFrames * Math.floor((remainder - dropFrames) / framesPerMinute) : 0;
    // adjustment is already in dropped-frame units — add the per-block and
    // in-block contributions, never multiply adjustment again.
    count = frames + dropFrames * 9 * tenMinuteBlocks + adjustment;
  }
  const ff = Math.floor(count % nominalFps);
  const totalSeconds = Math.floor(count / nominalFps);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  const sep = useDrop ? ";" : ":";
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}${sep}${pad(ff)}`;
}

/**
 * M48-C — parse a timecode string into an absolute frame count. Exact inverse
 * of formatTimecode: `HH:MM:SS;FF` / `HH:MM:SS:FF` (drop families with the
 * `;` separator undo the canonical drop-frame mapping), plus the short forms
 * `MM:SS`, `SS` and `SS:FF` (missing fields default to 0). Throws on invalid
 * input, mirroring formatTimecode's throwing contract.
 */
export function parseTimecode(value: string, fps: Rational, drop = false): number {
  const text = value.trim();
  if (!text) throw new Error("empty timecode");
  const parts = text.split(/[;:.]/).map((seg) => seg.trim());
  if (parts.length < 1 || parts.length > 4 || parts.some((seg) => seg === "" || !/^\d+$/.test(seg))) {
    throw new Error(`invalid timecode "${value}"`);
  }
  const numbers = parts.map((seg) => Number(seg));
  const isDropFamily = (fps.num === 30000 && fps.den === 1001) || (fps.num === 60000 && fps.den === 1001);
  const useDrop = (drop || text.includes(";")) && isDropFamily;
  const nominalFps = Math.round(rationalToNumber(fps));
  let ff = 0;
  let ss = 0;
  let mm = 0;
  let hh = 0;
  if (numbers.length === 1) {
    ff = numbers[0];
  } else if (numbers.length === 2) {
    [ss, ff] = numbers;
  } else if (numbers.length === 3) {
    [mm, ss, ff] = numbers;
  } else {
    [hh, mm, ss, ff] = numbers;
  }
  if (ff >= nominalFps || ss > 59 || mm > 59) throw new Error(`timecode field out of range in "${value}"`);
  // Display value interpreted at the nominal fps (same numbering formatTimecode emits).
  const display = ((hh * 60 + mm) * 60 + ss) * nominalFps + ff;
  if (!useDrop) return display;
  // Undo the drop-frame mapping. The closed-form inverse has a boundary
  // asymmetry at the last frames of a minute (the adjustment shifts the
  // remainder it is computed from), so we take the closed-form estimate and
  // then verify against the formatter itself over a bounded window — the
  // parse is exact for every string formatTimecode can emit.
  const dropFrames = DROP_PER_MINUTE[nominalFps];
  const framesPerMinute = nominalFps * 60 - dropFrames;
  const framesPer10Minutes = nominalFps * 600 - dropFrames * 9;
  const tenMinuteBlocks = Math.floor(display / framesPer10Minutes);
  const remainder = display % framesPer10Minutes;
  const adjustment = remainder > dropFrames ? dropFrames * Math.floor((remainder - dropFrames) / framesPerMinute) : 0;
  const estimate = display - (dropFrames * 9 * tenMinuteBlocks + adjustment);
  for (let candidate = Math.max(0, estimate - 8); candidate <= estimate + 8; candidate += 1) {
    if (formatTimecode(candidate, fps, true) === text) return candidate;
  }
  throw new Error(`timecode "${value}" is not a valid drop-frame value`);
}

/** Zero-frame duration is invalid everywhere; durations are ≥ 1 frame. */
export function assertValidRange(startFrame: number, endFrame: number, what: string): void {
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame)) {
    throw new Error(`${what}: frame positions must be integers (got ${startFrame}/${endFrame})`);
  }
  if (endFrame - startFrame < 1) {
    throw new Error(`${what}: duration must be at least one frame (got ${endFrame - startFrame})`);
  }
}
