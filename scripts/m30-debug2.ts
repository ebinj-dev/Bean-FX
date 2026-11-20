// Full live repro with raw response inspection.
const BASE = "http://localhost:3118";
async function req(method: string, path: string, init: { cookie?: string; body?: unknown } = {}) {
  const res = await fetch(BASE + path, { method, headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.cookie ? { Cookie: init.cookie } : {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
  const sc = res.headers.getSetCookie?.() ?? [];
  for (const c of sc) { const [k, v] = c.split(";")[0].split("="); if (k === "beanfx_session") init.cookie = `${k}=${v}`; }
  const text = await res.text();
  return { status: res.status, text: text.slice(0, 200), cookie: init.cookie };
}
const revId = process.argv[2];
const bCookie = process.argv[3];
const get = await req("GET", `/api/reviews/${revId}`, { cookie: bCookie });
console.log("GET:", get.status, get.text.slice(0, 80));
const post = await req("POST", `/api/reviews/${revId}/comments`, { cookie: bCookie, body: { body: "debug comment", frame: 0, fpsNum: 30, fpsDen: 1 } });
console.log("POST comment:", post.status, post.text);
const put = await req("PUT", `/api/reviews/${revId}`, { cookie: bCookie, body: { decision: "APPROVE" } });
console.log("PUT decision:", put.status, put.text.slice(0, 120));
process.exit(0);
