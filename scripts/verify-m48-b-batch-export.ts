/**
 * M48-B verification — batch-export must accept TIMELINE_RENDER masters.
 *
 * Flow (all real): register → project → upload REAL mp4 → probe → timeline
 * (AddClip via the canonical API) → render → export registered as
 * TIMELINE_RENDER → batch-export two aspect variants from that master.
 * Before the fix step 9 failed with "Master export not found (kind VIDEO)".
 *
 * Run: BASE=http://localhost:3118 bun run scripts/verify-m48-b-batch-export.ts
 */
const BASE = process.env.BASE ?? "http://localhost:3118";
const stamp = Date.now().toString(36);
let cookie = "";

async function api(m: string, p: string, body?: unknown) {
  const res = await fetch(`${BASE}${p}`, {
    method: m,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function main() {
  const reg = await api("POST", "/api/auth/register", { email: `m48b-${stamp}@beanfx.test`, password: "M48batch1!", name: "m48b", acceptedDraftTerms: true });
  if (![200, 201].includes(reg.status)) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`);

  const proj = await api("POST", "/api/projects", { name: `M48B batch ${stamp}` });
  const projectId = proj.json?.project?.id;
  if (!projectId) throw new Error(`project ${proj.status}`);

  const bytes = await Bun.file("/tmp/m472-media/cycler.mp4").arrayBuffer().catch(() => null);
  if (!bytes) throw new Error("missing /tmp/m472-media/cycler.mp4 — regenerate the fixture");
  const up = await fetch(`${BASE}/api/media`, {
    method: "POST",
    headers: { "Content-Type": "video/mp4", "x-filename": `m48b-${stamp}.mp4`, "x-asset-role": "SOURCE_FOOTAGE", Cookie: cookie },
    body: bytes,
  });
  const upJson = await up.json().catch(() => null);
  const mediaId = upJson?.asset?.id ?? upJson?.media?.id ?? upJson?.id;
  if (!mediaId) throw new Error(`upload ${up.status} ${JSON.stringify(upJson).slice(0, 200)}`);

  // Wait for the probe worker (probe-aware placement needs real fps/duration).
  // GET /api/media/[id] returns flat probe fields: probeStatus, fps (float),
  // durationSec, width/height…
  let fps = { num: 30, den: 1 };
  let durationFrames = 180;
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("probe wait exceeded 90s");
    const d = await api("GET", `/api/media/${mediaId}`);
    const asset = d.json?.media ?? d.json?.asset ?? d.json; // route wraps as { media: {...} }
    if (asset?.probeStatus === "READY") {
      const f = Number(asset.fps) || 30;
      // Exact rational families (same mapping as time.ts rationalFromFps).
      const families: Array<[number, number]> = [[24000, 1001], [30000, 1001], [60000, 1001], [25, 1], [24, 1], [30, 1], [50, 1], [60, 1]];
      const rounded = Math.round(f * 100) / 100;
      let best = families[2];
      for (const fam of families) if (Math.abs(fam[0] / fam[1] - f) < Math.abs(best[0] / best[1] - f)) best = fam;
      fps = Math.abs(best[0] / best[1] - rounded) < 0.005 ? { num: best[0], den: best[1] } : { num: Math.round(f), den: 1 };
      const durSec = Number(asset.durationSec) || 6;
      durationFrames = Math.max(1, Math.round((durSec * fps.num) / fps.den));
      break;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }

  const head = await api("GET", `/api/editor/projects/${projectId}/timeline`);
  if (head.status !== 200) throw new Error(`timeline head ${head.status}`);
  const seq = head.json?.sequence;
  const videoTrack = seq?.tracks?.find((t: { kind: string }) => t.kind === "VIDEO");
  const baseVersion = head.json?.version;

  const clipId = `m48b-clip-${stamp}`;
  const add = await api("POST", `/api/editor/projects/${projectId}/timeline`, {
    baseVersion,
    edits: [{ type: "AddClip", clip: { id: clipId, trackId: videoTrack.id, sourceAssetId: mediaId, sourceInFrame: 0, sourceOutFrame: Math.min(180, durationFrames), sourceFps: fps, timelineStartFrame: 0, timelineDurationFrames: Math.min(180, durationFrames), playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, label: null, missingMedia: false, pan: 0, groupId: null, effects: [], keyframes: [] } }],
  });
  if (add.status !== 200) throw new Error(`AddClip ${add.status} ${JSON.stringify(add.json).slice(0, 200)}`);

  const render = await api("POST", `/api/editor/projects/${projectId}/render`, { format: "mp4" });
  if (render.status !== 202) throw new Error(`render ${render.status} ${JSON.stringify(render.json)}`);
  const jobId = render.json?.jobId;

  let exportId = "";
  const pollDeadline = Date.now() + 180_000;
  for (;;) {
    if (Date.now() > pollDeadline) throw new Error("render poll exceeded 180s");
    const j = await api("GET", `/api/jobs/${jobId}`);
    const job = j.json?.job ?? j.json;
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(String(job?.status))) {
      if (job?.status !== "COMPLETED") throw new Error(`render job ${job?.status}: ${JSON.stringify(job?.error ?? job).slice(0, 200)}`);
      exportId = job.exportId;
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  const exp = await api("GET", `/api/exports/${exportId}`);
  const kind = exp.json?.export?.kind ?? exp.json?.kind;
  console.log("render COMPLETED exportId:", exportId, "kind:", kind);

  const be = await api("POST", `/api/editor/projects/${projectId}/batch-export`, { sourceExportId: exportId, profileIds: ["youtube_landscape", "tiktok"] });
  console.log("batch-export status:", be.status);
  console.log("batch-export body:", JSON.stringify(be.json).slice(0, 400));
  if (be.status !== 202 && be.status !== 200) throw new Error(`batch-export failed: ${be.status}`);
  const variants = be.json?.variants?.length ?? be.json?.batch?.length ?? 0;
  console.log(`PASS — TIMELINE_RENDER master batch-exported into ${variants} variant job(s)`);
}

await main();
