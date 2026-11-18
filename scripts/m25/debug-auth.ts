const BASE = "http://localhost:3117";
function makeApi() {
  let jar = "";
  return async function api(method: string, p: string, body?: unknown) {
    const res = await fetch(`${BASE}${p}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(jar ? { Cookie: jar } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [k, v] = c.split(";")[0].split("=");
      if (k === "beanfx_session" && v) jar = `${k}=${v}`;
    }
    let json: any = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
}
const u = makeApi();
const STAMP = Date.now().toString(36);
const EMAIL = `m25dbg-${STAMP}@test.local`;
const PW = "m25-Billing-Pass1!";
const reg = await u("POST", "/api/auth/register", { email: EMAIL, password: PW, name: "dbg" });
console.log("register:", reg.status, JSON.stringify(reg.json).slice(0, 120));
const login = await u("POST", "/api/auth/login", { email: EMAIL, password: PW });
console.log("login:", login.status, JSON.stringify(login.json).slice(0, 120));
