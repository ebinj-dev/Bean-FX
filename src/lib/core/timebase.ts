/**
 * @beanfx/core — timebase (M21 spec §8)
 *
 * Exact rational time conversion. Every operation uses BigInt arithmetic so
 * there is no floating-point drift, ever. Convention: frame durations are
 * half-open intervals [start, end) on the sequence clock; "seconds" are
 * always represented as an exact rational (numerator/denominator BigInts),
 * never as a JS number, unless explicitly rounded by a *documented* rule.
 *
 * Rounding rules (fixed here, recorded for audit by the caller):
 *  - frame quantization: nearest, ties away from zero
 *  - tick conversion (Premiere 254016000 ticks/second): exact when the tick
 *    count is integral, otherwise nearest with ties away from zero
 *  - sample-clock conversion (audio): floor for starts, ceil for ends, so
 *    audio ranges never shrink (prevents audible gaps at boundaries).
 */

export interface Rational {
  num: number;
  den: number;
}

const TICKS_PER_SECOND = BigInt("254016000"); // Adobe ticks (exact, per Premiere spec)

export function makeRational(num: number, den: number): Rational {
  if (!Number.isInteger(num) || !Number.isInteger(den) || num <= 0 || den <= 0) {
    throw new Error(`invalid rational ${num}/${den}`);
  }
  return { num, den };
}

/** Reduce n/d by gcd (both positive BigInts). */
function reduce(n: bigint, d: bigint): [bigint, bigint] {
  let a = n < BigInt("0") ? -n : n;
  let b = d;
  while (b) {
    [a, b] = [b, a % b];
  }
  return a === BigInt("0") ? [n, d] : [(n < BigInt("0") ? -a : a), (d < BigInt("0") ? -d : d)];
}

/** Divide x/y with round-half-away-from-zero. y must be > 0. */
function divRound(x: bigint, y: bigint): bigint {
  if (y <= BigInt("0")) throw new Error("divRound: denominator must be positive");
  const neg = x < BigInt("0");
  const ax = neg ? -x : x;
  const q = (ax * BigInt("2") + y) / (BigInt("2") * y); // floor((ax + y/2) / y) — ties go up
  return neg ? -q : q;
}

/** Frames → exact seconds rational. */
export function framesToSecondsRational(frames: number, fps: Rational): { num: bigint; den: bigint } {
  return { num: BigInt(frames) * BigInt(fps.den), den: BigInt(fps.num) };
}

/** Seconds (exact rational) → frames, nearest with ties away from zero. */
export function secondsRationalToFrames(num: bigint, den: bigint, fps: Rational): number {
  const frames = divRound(num * BigInt(fps.num), den * BigInt(fps.den));
  if (frames > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("frame count exceeds safe integer");
  return Number(frames);
}

/** Frames → Premiere ticks (exact only when integral; otherwise nearest). */
export function framesToTicks(frames: number, fps: Rational): bigint {
  const { num, den } = framesToSecondsRational(frames, fps);
  return divRound(num * TICKS_PER_SECOND, den);
}

/** Premiere ticks → frames on the given clock (nearest, ties away). */
export function ticksToFrames(ticks: bigint, fps: Rational): number {
  const frames = divRound(ticks * BigInt(fps.num), TICKS_PER_SECOND * BigInt(fps.den));
  return Number(frames);
}

/**
 * Audio sample boundary conversion: [start,end) seconds → sample indices.
 * Start floors, end ceils — ranges never shrink across conversions.
 */
export function secondsRationalToSamples(
  startNum: bigint,
  startDen: bigint,
  endNum: bigint,
  endDen: bigint,
  sampleRate: number,
): { startSample: number; endSample: number } {
  const sr = BigInt(sampleRate);
  const s = (startNum * sr) / startDen; // floor
  const e = divRound(endNum * sr, endDen);
  const eCeil = (e * endDen === endNum * sr) ? e : (endNum * sr) / endDen + (endNum * sr > BigInt("0") ? BigInt("1") : BigInt("0"));
  return { startSample: Number(s), endSample: Number(eCeil) };
}

/** Frames ↔ samples on independent clocks (video fps + audio sampleRate). */
export function framesToSamples(frames: number, fps: Rational, sampleRate: number): number {
  const { num, den } = framesToSecondsRational(frames, fps);
  const sr = BigInt(sampleRate);
  return Number((num * sr) / den); // floor — audio starts never shrink
}

/** Common broadcast rates, verified exact (1001 = drop-frame family). */
export const STANDARD_FPS: Record<string, Rational> = Object.freeze({
  "23.976": makeRational(24000, 1001),
  "24": makeRational(24, 1),
  "25": makeRational(25, 1),
  "29.97": makeRational(30000, 1001),
  "30": makeRational(30, 1),
  "50": makeRational(50, 1),
  "59.94": makeRational(60000, 1001),
  "60": makeRational(60, 1),
});

/** Drift check used by property tests: convert frames→seconds→frames must be identity. */
export function roundTripFrames(frames: number, fps: Rational): number {
  const { num, den } = framesToSecondsRational(frames, fps);
  return secondsRationalToFrames(num, den, fps);
}
