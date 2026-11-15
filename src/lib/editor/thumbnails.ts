/**
 * BEAN FX — M16 clip thumbnails (client-side, REAL frames).
 *
 * Captures an actual decoded frame from the asset's own media (`<video>` +
 * canvas, first frame + a later probe point), cached as data URLs in an LRU
 * map (capped — unbounded caches are forbidden) and promise-deduped so ten
 * blocks for one asset trigger ONE decode. Original media untouched.
 */
const THUMB_LIMIT = 120;
const cache = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();

export function thumbnailFor(assetId: string): Promise<string | null> {
  const hit = cache.get(assetId);
  if (hit) {
    cache.delete(assetId);
    cache.set(assetId, hit); // refresh LRU position
    return Promise.resolve(hit);
  }
  const inflight = pending.get(assetId);
  if (inflight) return inflight;
  const task = capture(assetId)
    .then((url) => {
      pending.delete(assetId);
      if (!url) return null;
      cache.set(assetId, url);
      while (cache.size > THUMB_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      return url;
    })
    .catch(() => {
      pending.delete(assetId);
      return null;
    });
  pending.set(assetId, task);
  return task;
}

async function capture(assetId: string): Promise<string | null> {
  if (typeof document === "undefined") return null;
  return new Promise<string | null>((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "metadata";
    video.crossOrigin = "anonymous";
    const done = (url: string | null) => {
      video.removeAttribute("src");
      video.load();
      resolve(url);
    };
    const timer = window.setTimeout(() => done(null), 8000);
    video.onloadeddata = () => {
      try {
        const canvas = document.createElement("canvas");
        const scale = Math.min(1, 160 / Math.max(1, video.videoWidth));
        canvas.width = Math.max(2, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(2, Math.round(video.videoHeight * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          window.clearTimeout(timer);
          done(null);
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        window.clearTimeout(timer);
        done(canvas.toDataURL("image/jpeg", 0.6));
      } catch {
        window.clearTimeout(timer);
        done(null); // cross-origin taint or decode failure — no fake thumbnail
      }
    };
    video.onerror = () => {
      window.clearTimeout(timer);
      done(null);
    };
    video.src = `/api/media/${encodeURIComponent(assetId)}/file`;
    video.load();
  });
}
