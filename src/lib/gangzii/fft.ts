/**
 * GANGZII — minimal, dependency-free FFT for spectrum analysis.
 *
 * Iterative radix-2 Cooley-Tukey, complex input. Real input is packed into
 * the complex array (N/2 real points) by the caller helper `realSpectrum`,
 * which also folds the mirrored halves into magnitudes for bins
 * 0..N/2 at frequencies 0..sampleRate/2.
 */

/** In-place iterative FFT on interleaved re/im pairs. Length must be 2^k. */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n <= 1 || (n & (n - 1)) !== 0) throw new Error(`fft length must be a power of two, got ${n}`);
  // bit reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  // butterflies
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + half] * cr - im[i + k + half] * ci;
        const vi = re[i + k + half] * ci + im[i + k + half] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + half] = ur - vr;
        im[i + k + half] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Magnitude spectrum of one windowed real frame. Returns N/2+1 magnitudes
 * (bin i = i * sampleRate / N Hz). Hann window applied internally.
 */
export function realSpectrum(frame: Float32Array | Float64Array, scratch?: { re: Float64Array; im: Float64Array }): Float64Array {
  const n = frame.length;
  if (n <= 1 || (n & (n - 1)) !== 0) throw new Error(`frame length must be a power of two, got ${n}`);
  const re = scratch?.re ?? new Float64Array(n);
  const im = scratch?.im ?? new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // Hann window: w = 0.5 - 0.5 cos(2πi/(n-1)) — applied before the transform.
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    re[i] = frame[i] * w;
    im[i] = 0;
  }
  fftInPlace(re, im);
  const mags = new Float64Array(n / 2 + 1);
  for (let i = 0; i <= n / 2; i++) mags[i] = Math.hypot(re[i], im[i]);
  return mags;
}
