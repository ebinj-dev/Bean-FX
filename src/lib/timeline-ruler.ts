/**
 * BEAN FX — timeline ruler math (pure functions, unit-tested).
 *
 * The ruler never uses hardcoded intervals: the major step is a 1/2/5-family
 * nice value of (viewDuration / 8), minor subdivisions stay in the same
 * family, and the label format follows the step — professional zero-padded
 * timecodes that stay readable from a 0.5 s zoom window to hour-long
 * recordings:
 *
 *   step ≥ 30 s   → M M : S S            00:00 | 02:00 | 04:00
 *   step < 30 s   → H H : M M : S S      00:28:30 | 00:28:45 | 00:29:00
 *   sub-second    → fractional seconds appended   00:00:08.25
 */

/** Nice major step for a raw interval (1/2/5 × 10^n family). */
export function niceStep(raw: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  const norm = raw / pow;
  const step = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  return step * pow;
}

/** Minor ruler subdivision for a major step: 1→0.2, 2→0.5, 5→1. */
export function minorSubdivision(step: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(step, 1e-9))));
  const norm = Math.round((step / pow) * 10) / 10;
  return step / (norm === 2 ? 4 : 5);
}

/** Zero-padded professional timecode for a tick at `t` with major `step`.
 *  `t` is snapped to the step grid first, so float drift can never make a
 *  label show 00:00:59.0 where 01:00:00.0 is meant. */
export function formatTimeLabel(t: number, step: number): string {
  const snapped = Math.round(t / step) * step;
  const sub = step < 0.095 ? 2 : step < 0.95 ? 1 : 0;
  const totalSec = Math.round(snapped * 10 ** sub) / 10 ** sub;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec - h * 3600 - m * 60;
  const secWhole = Math.floor(s);
  const frac = sub > 0 ? "." + Math.round((s - secWhole) * 10 ** sub).toString().padStart(sub, "0") : "";
  const ss = String(secWhole).padStart(2, "0") + frac;
  // Steps of 30 s and coarser read as MM:SS; finer steps (or past one hour)
  // carry the hours group so the position stays unambiguous.
  if (step < 30 || h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${ss}`;
  return `${String(m).padStart(2, "0")}:${ss}`;
}
