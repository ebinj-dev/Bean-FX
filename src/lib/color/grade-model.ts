/**
 * BEAN FX — M48-I professional primary grading model.
 *
 * THE single defined grading transform for M48-I. Both the preview (WebGL2
 * shader generated from these same formulas) and the canonical export (the
 * grade baked into a 3D LUT consumed by FFmpeg `lut3d`) derive from THIS
 * file, so preview and export cannot drift: there is exactly one
 * implementation of the math.
 *
 * Working space: component values are the source's STORED gamma (sRGB-ish
 * Rec.709 primaries for SDR material), each channel in [0, 1]. This is the
 * documented SDR working space of the editor (see color-management doc):
 * no silent conversion is performed; sources whose metadata says otherwise
 * are flagged by the probe/interpretation layer, not re-transformed here.
 *
 * Documented order of operations (per pixel):
 *   1. user LUT            — trilinear lookup (see lut3d.ts), input transform
 *   2. exposure            — multiplicative 2^stops gain
 *   3. temperature/tint    — white/black-preserving channel balance
 *   4. contrast + pivot    — slope about the pivot
 *   5. highlights/shadows  — smooth windowed gain about the 0.5 crossover
 *   6. whites/blacks       — endpoint gains (soft windows at 0.75/0.25)
 *   7. lift/gamma/gain     — per-channel wheels (white-preserving lift,
 *                            power gamma, multiplicative gain)
 *   8. RGB master gains    — per-channel multiplier
 *   9. saturation          — luma-mix
 *  10. vibrance            — saturation weighted by pixel desaturation
 *  11. clamp               — hard [0,1] clamp
 */

export interface GradeParams {
  bypass: boolean;
  exposure: number; // stops, [-4, 4]
  temperature: number; // -1 cool .. +1 warm
  tint: number; // -1 magenta .. +1 green
  contrast: number; // 0.25..4 slope
  pivot: number; // 0..1 contrast pivot (default 0.5)
  highlights: number; // -1..1
  shadows: number; // -1..1
  whites: number; // -1..1
  blacks: number; // -1..1
  liftR: number; liftG: number; liftB: number; // -0.5..0.5
  gammaR: number; gammaG: number; gammaB: number; // 0.25..4
  gainR: number; gainG: number; gainB: number; // 0..4
  red: number; green: number; blue: number; // RGB master gains 0..2
  saturation: number; // 0..3
  vibrance: number; // -1..1
}

export const DEFAULT_GRADE: GradeParams = {
  bypass: false,
  exposure: 0,
  temperature: 0,
  tint: 0,
  contrast: 1,
  pivot: 0.5,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  liftR: 0, liftG: 0, liftB: 0,
  gammaR: 1, gammaG: 1, gammaB: 1,
  gainR: 1, gainG: 1, gainB: 1,
  red: 1, green: 1, blue: 1,
  saturation: 1,
  vibrance: 0,
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** smoothstep(0,1,x) clamped — the soft windows for tone controls. */
function smooth(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

/** FFmpeg colorbalance semantics: positive slope lifts toward white, negative sinks toward black. */
function balance(v: number, slope: number): number {
  return slope >= 0 ? v + slope * (1 - v) : v * (1 + slope);
}

function powc(v: number, g: number): number {
  // gamma of a zero/negative-clamped component is well-defined on [0,1]
  return v <= 0 ? 0 : Math.pow(v, 1 / g);
}

/**
 * Apply the primary grade to one pixel. `lut` (optional) is the user LUT
 * evaluator (u,v,w in [0,1] → [0,1]³). Everything else is the documented
 * order above. Returns clamped [0,1] RGB.
 */
export function gradePixel(
  r0: number, g0: number, b0: number,
  p: GradeParams,
  lut?: (r: number, g: number, b: number) => [number, number, number],
): [number, number, number] {
  if (p.bypass) return [r0, g0, b0];
  let [r, g, b] = lut ? lut(r0, g0, b0) : [r0, g0, b0];

  // 2. exposure — 2^stops multiplicative gain
  const ex = Math.pow(2, p.exposure);
  r *= ex; g *= ex; b *= ex;

  // 3. temperature/tint — white-preserving balance on R/B and G
  r = balance(r, p.temperature * 0.5);
  b = balance(b, -p.temperature * 0.5);
  g = balance(g, p.tint * 0.35);

  // 4. contrast about pivot
  r = (r - p.pivot) * p.contrast + p.pivot;
  g = (g - p.pivot) * p.contrast + p.pivot;
  b = (b - p.pivot) * p.contrast + p.pivot;

  const c = (v: number) => clamp01(v);
  r = c(r); g = c(g); b = c(b);

  // 5. highlights / shadows — smooth windows around the 0.5 crossover
  if (p.highlights !== 0) {
    const hw = smooth(((r + g + b) / 3 - 0.5) * 2);
    const lift = p.highlights * 0.35;
    r += lift * hw * (1 - r); g += lift * hw * (1 - g); b += lift * hw * (1 - b);
  }
  if (p.shadows !== 0) {
    const sw = 1 - smooth(((r + g + b) / 3) * 2);
    const lift = p.shadows * 0.35;
    r += lift * sw * r; g += lift * sw * g; b += lift * sw * b;
  }

  // 6. whites / blacks — endpoint gains
  if (p.whites !== 0) {
    const w = smooth((Math.max(r, g, b) - 0.75) * 4);
    const gain = p.whites * 0.35;
    r += gain * w * (1 - r); g += gain * w * (1 - g); b += gain * w * (1 - b);
  }
  if (p.blacks !== 0) {
    const w = 1 - smooth(Math.min(r, g, b) * 4);
    const gain = p.blacks * 0.35;
    r += gain * w * r; g += gain * w * g; b += gain * w * b;
  }
  r = c(r); g = c(g); b = c(b);

  // 7. lift/gamma/gain per channel (white-preserving lift, power gamma, gain)
  r = balance(c(r * p.gainR), p.liftR);
  g = balance(c(g * p.gainG), p.liftG);
  b = balance(c(b * p.gainB), p.liftB);
  r = c(powc(r, p.gammaR)); g = c(powc(g, p.gammaG)); b = c(powc(b, p.gammaB));

  // 8. RGB master gains
  r = c(r * p.red); g = c(g * p.green); b = c(b * p.blue);

  // 9. saturation — mix toward Rec.709 luma
  if (p.saturation !== 1) {
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = y + (r - y) * p.saturation;
    g = y + (g - y) * p.saturation;
    b = y + (b - y) * p.saturation;
  }

  // 10. vibrance — saturation weighted by the pixel's own desaturation
  if (p.vibrance !== 0) {
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    const w = 1 - chroma;
    const s = 1 + p.vibrance * w;
    r = y + (r - y) * s; g = y + (g - y) * s; b = y + (b - y) * s;
  }

  return [c(r), c(g), c(b)];
}

/** True when the grade changes nothing (skip work in render/preview). */
export function gradeIsNeutral(p: GradeParams): boolean {
  if (p.bypass) return true;
  return (
    p.exposure === 0 && p.temperature === 0 && p.tint === 0 &&
    p.contrast === 1 && p.pivot === 0.5 &&
    p.highlights === 0 && p.shadows === 0 && p.whites === 0 && p.blacks === 0 &&
    p.liftR === 0 && p.liftG === 0 && p.liftB === 0 &&
    p.gammaR === 1 && p.gammaG === 1 && p.gammaB === 1 &&
    p.gainR === 1 && p.gainG === 1 && p.gainB === 1 &&
    p.red === 1 && p.green === 1 && p.blue === 1 &&
    p.saturation === 1 && p.vibrance === 0
  );
}

/** GLSL (WebGL2, `#version 300 es`) implementing the IDENTICAL math. */
export function gradeShaderBody(): string {
  return `
vec3 balance(float v, float slope) {
  return slope >= 0.0 ? v + slope * (1.0 - v) : v * (1.0 + slope);
}
vec3 gradePixel(vec3 c0, bool bypass, float exposure, float temperature, float tint,
    float contrast, float pivot, float highlights, float shadows, float whites, float blacks,
    vec3 lift, vec3 gamma, vec3 gain, vec3 rgbGain, float saturation, float vibrance) {
  if (bypass) return c0;
  vec3 c = c0;
  float ex = pow(2.0, exposure);
  c *= ex;
  c.r = balance(c.r, temperature * 0.5);
  c.b = balance(c.b, -temperature * 0.5);
  c.g = balance(c.g, tint * 0.35);
  c = (c - pivot) * contrast + pivot;
  c = clamp(c, 0.0, 1.0);
  float luma0 = (c.r + c.g + c.b) / 3.0;
  if (highlights != 0.0) {
    float hw = smoothstep(0.0, 1.0, (luma0 - 0.5) * 2.0);
    float lift = highlights * 0.35;
    c += lift * hw * (1.0 - c);
  }
  if (shadows != 0.0) {
    float sw = 1.0 - smoothstep(0.0, 1.0, luma0 * 2.0);
    float lift = shadows * 0.35;
    c += lift * sw * c;
  }
  if (whites != 0.0) {
    float w = smoothstep(0.0, 1.0, (max(c.r, max(c.g, c.b)) - 0.75) * 4.0);
    float gain = whites * 0.35;
    c += gain * w * (1.0 - c);
  }
  if (blacks != 0.0) {
    float w = 1.0 - smoothstep(0.0, 1.0, min(c.r, min(c.g, c.b)) * 4.0);
    float gain = blacks * 0.35;
    c += gain * w * c;
  }
  c = clamp(c, 0.0, 1.0);
  c = clamp(c * gain, 0.0, 1.0);
  c.r = balance(c.r, lift.r); c.g = balance(c.g, lift.g); c.b = balance(c.b, lift.b);
  c = clamp(c, 0.0, 1.0);
  c.r = c.r <= 0.0 ? 0.0 : pow(c.r, 1.0 / gamma.r);
  c.g = c.g <= 0.0 ? 0.0 : pow(c.g, 1.0 / gamma.g);
  c.b = c.b <= 0.0 ? 0.0 : pow(c.b, 1.0 / gamma.b);
  c = clamp(c * rgbGain, 0.0, 1.0);
  if (saturation != 1.0) {
    float y = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    c = y + (c - y) * saturation;
  }
  if (vibrance != 0.0) {
    float y = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    float chroma = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
    float s = 1.0 + vibrance * (1.0 - chroma);
    c = y + (c - y) * s;
  }
  return clamp(c, 0.0, 1.0);
}
`;
}
