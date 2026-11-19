const BASE = "http://localhost:3118";
const t = Date.now().toString(36);
async function req(method: string, path: string, init: { cookie?: string; body?: unknown } = {}, raw = false) {
  const res = await fetch(BASE + path, { method, headers: { ...(!raw && init.body ? { "Content-Type": "application/json" } : {}), ...(init.cookie ? { Cookie: init.cookie } : {}) }, body: init.body && !raw ? JSON.stringify(init.body) : (init.body as any) });
  const sc = res.headers.getSetCookie?.() ?? [];
  for (const c of sc) { const [k, v] = c.split(";")[0].split("="); if (k === "beanfx_session") init.cookie = `${k}=${v}`; else if (k === "beanfx_review") init.cookie = `${k}=${v}`; }
  const text = await res.text();
  return { status: res.status, text: text.slice(0, 160), cookie: init.cookie, sc };
}
// owner
const A: any = { cookie: "" };
const reg = await req("POST", "/api/auth/register", { cookie: A.cookie, body: { email: `dbg3a-${t}@t.local`, password: "dbg-pass-1x", name: "A" } });
A.cookie = reg.cookie;
console.log("regA:", reg.status);
// minimal project+timeline via the same fixture used before
const pj = await req("POST", "/api/projects", { cookie: A.cookie, body: { name: "DbgLink" } });
const up = await fetch(BASE + "/api/media", { method: "POST", headers: { Cookie: A.cookie, "x-filename": "d.mp4", "Content-Type": "application/octet-stream" }, body: Buffer.from((await import("fs")).readFileSync("/tmp/m30r.mp4")) });
const m = await up.json();
const tl = await req("POST", `/api/editor/projects/${pj.json.project.id}/timeline`, { cookie: A.cookie, body: { baseVersion: 1, edits: [
  { type: "AddTrack", track: { id: "v1", name: "V1", kind: "VIDEO", visible: true, muted: false, solo: false, locked: false, volume: 1 } },
  { type: "AddClip", clip: { id: "c1", trackId: "v1", sourceAssetId: m.media.id, sourceInFrame: 0, sourceOutFrame: 30, sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 30, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, keyframes: [], missingMedia: false, pan: 0, groupId: null, effects: [] } },
] } });
const rev = await req("POST", `/api/projects/${pj.json.project.id}/reviews`, { cookie: A.cookie, body: { title: "DbgLink rev" } });
const revId = rev.json.revision.id;
await new Promise(r => setTimeout(r, 6000));
const link = await req("POST", `/api/reviews/${revId}/links`, { cookie: A.cookie, body: { permission: "COMMENT", ttlHours: 24 } });
console.log("link:", link.status, JSON.stringify(link.json?.link));
const token = link.json.token;
const G: any = { cookie: "" };
const sess = await req("POST", `/api/reviews/link/${token}`, { cookie: G.cookie, body: { displayName: "Guest" } });
console.log("session:", sess.status, "setCookie:", sess.sc.map(c => c.split(";")[0]).join(" | "), "jarNow:", G.cookie.slice(0, 60));
const detail = await req("GET", `/api/reviews/${revId}`, { cookie: G.cookie });
console.log("guest detail:", detail.status, detail.text.slice(0, 120));
process.exit(0);
