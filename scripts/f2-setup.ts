/**
 * M48-F2 setup — register an authorized test account and prepare the editor
 * journey data (project + real media + canonical timeline clips) via the
 * canonical APIs. The BROWSER will then log in through the genuine UI form.
 * Run: BASE=http://localhost:3119 bun run scripts/f2-setup.ts
 */
const BASE = process.env.BASE ?? "http://localhost:3119";
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
  const email = `f2qa-${stamp}@beanfx.test`;
  const password = "F2qa123456";
  const reg = await api("POST", "/api/auth/register", { email, password, name: "F2 QA", acceptedDraftTerms: true });
  if (![200, 201].includes(reg.status)) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json).slice(0, 200)}`);

  const proj = await api("POST", "/api/projects", { name: `F2 responsive QA ${stamp}` });
  const projectId = proj.json?.project?.id;
  if (!projectId) throw new Error(`project ${proj.status}`);

  const bytes = await Bun.file("/tmp/m472-media/cycler.mp4").arrayBuffer().catch(() => null);
  if (!bytes) throw new Error("missing /tmp/m472-media/cycler.mp4 fixture");
  const up = await fetch(`${BASE}/api/media`, {
    method: "POST",
    headers: { "Content-Type": "video/mp4", "x-filename": `f2qa-${stamp}.mp4`, "x-asset-role": "SOURCE_FOOTAGE", Cookie: cookie },
    body: bytes,
  });
  const upJson = await up.json().catch(() => null);
  const mediaId = upJson?.asset?.id ?? upJson?.media?.id ?? upJson?.id;
  if (!mediaId) throw new Error(`upload ${up.status}`);

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("probe timeout");
    const d = await api("GET", `/api/media/${mediaId}`);
    if ((d.json?.media ?? d.json?.asset)?.probeStatus === "READY") break;
    await new Promise((r) => setTimeout(r, 1200));
  }

  const head = await api("GET", `/api/editor/projects/${projectId}/timeline`);
  const seq = head.json?.sequence;
  const vt = seq?.tracks?.find((t: { kind: string }) => t.kind === "VIDEO");
  const mk = (id: string, trackId: string, start: number) => ({ id, trackId, sourceAssetId: mediaId, sourceInFrame: 0, sourceOutFrame: 180, sourceFps: { num: 30, den: 1 }, timelineStartFrame: start, timelineDurationFrames: 180, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, label: `QA clip ${id.slice(-4)}`, missingMedia: false, pan: 0, groupId: null, effects: [], keyframes: [] });
  // Captions dropped: the engine's anti-fake rule correctly refuses CAPTION
  // clips without a source asset; viewport QA does not need them.
  const add = await api("POST", `/api/editor/projects/${projectId}/timeline`, { baseVersion: head.json?.version, edits: [{ type: "AddClip", clip: mk(`f2clipA-${stamp}`, vt.id, 0) }, { type: "AddClip", clip: { ...mk(`f2clipB-${stamp}`, vt.id, 180) } }] });
  if (add.status !== 200) throw new Error(`AddClip ${add.status} ${JSON.stringify(add.json).slice(0, 150)}`);

  console.log(JSON.stringify({ ok: true, email, password, projectId, mediaId }));
}

await main();
