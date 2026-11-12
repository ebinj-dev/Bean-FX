(() => {
  // Precision probe for the BEAN FX timeline. Exposed on window for the
  // measurement session; harmless if left behind (page reload clears it).
  const canvases = Array.from(document.querySelectorAll("canvas"));
  // The main timeline overlay is the first Waveform's visible canvas
  // (static layer is an offscreen element, not in the DOM).
  const pick = canvases.find((c) => c.height > 80 && c.width > 300);
  if (!pick) return JSON.stringify({ error: "no canvas" });
  window.__probe = { canvas: pick };

  window.__probe.goldX = function () {
    const c = this.canvas;
    const ctx = c.getContext("2d");
    const H = Math.min(c.height, 24 * (window.devicePixelRatio || 1));
    const img = ctx.getImageData(0, 0, c.width, H).data;
    let lo = -1, hi = -1;
    for (let x = 0; x < c.width; x++) {
      for (let y = 0; y < H; y++) {
        const i = (y * c.width + x) * 4;
        const r = img[i], g = img[i + 1], b = img[i + 2];
        // gold #d4a017 = (212,160,23): saturated, low blue
        if (r > 170 && g > 120 && g < 200 && b < 70) { if (lo < 0) lo = x; hi = x; break; }
      }
    }
    if (lo < 0) return null;
    return (lo + hi) / 2; // device px (playhead line ≈ 2px wide at dpr)
  };

  window.__probe.dpr = () => window.devicePixelRatio || 1;

  window.__probe.measureVelocity = function (ms) {
    return new Promise((resolve) => {
      const x1 = this.goldX();
      const t1 = performance.now();
      if (x1 === null) return resolve(null);
      setTimeout(() => {
        const x2 = this.goldX();
        const t2 = performance.now();
        if (x2 === null) return resolve(null);
        const dpr = this.dpr();
        resolve({
          pxPerSec: (x2 - x1) / dpr / ((t2 - t1) / 1000),
          xStartCss: x1 / dpr,
          xEndCss: x2 / dpr,
          elapsedSec: (t2 - t1) / 1000,
        });
      }, ms);
    });
  };

  window.__probe.canvasCssWidth = function () {
    return this.canvas.width / this.dpr();
  };
  return JSON.stringify({ canvases: canvases.length, picked: { w: pick.width, h: pick.height } });
})()
