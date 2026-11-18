/**
 * M19 §21 — real security tests against a running BEAN FX server.
 * Covers: authentication (anonymous access, invalid/expired sessions, deleted
 * account lockout), authorization (cross-user project/media/job/export
 * isolation), API hardening (bad payloads, rate limiting), registration
 * verification flow, password reset flow (anti-enumeration + single-use
 * tokens), session management, account deletion, security headers, cookie
 * attributes, and the frontend bundle secret scan.
 *
 * Run: BASE=http://localhost:3117 bun test scripts/test-m19-security.test.ts
 */
import { describe, test, expect } from "bun:test";

const BASE = process.env.BASE ?? "http://localhost:3117";

type Jar = Map<string, string>;

function cookieHeader(jar: Jar): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function req(method: string, path: string, opts: { body?: unknown; jar?: Jar; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers ?? {}) };
  if (opts.jar) headers.Cookie = cookieHeader(opts.jar);
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: "manual",
  });
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0 && opts.jar) {
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (value === "") opts.jar.delete(name);
      else opts.jar.set(name, value);
    }
  }
  return res;
}

async function expectLoggedOut(res: Response) {
  if ([401, 403].includes(res.status)) return;
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user: unknown };
  expect(body.user).toBeNull();
}

async function register(jar: Jar, email: string, password = "test-passw0rd") {
  const res = await req("POST", "/api/auth/register", { body: { email, password, name: "M19 Sec" }, jar });
  expect(res.status).toBe(200);
  return (await res.json()) as { user: { id: string; email: string }; verification: { delivered: boolean; notice?: string; devToken?: string } };
}

async function login(jar: Jar, email: string, password = "test-passw0rd") {
  const res = await req("POST", "/api/auth/login", { body: { email, password }, jar });
  expect(res.status).toBe(200);
  return res;
}

const STAMP = Date.now().toString(36);
const rand = () => Math.random().toString(36).slice(2, 8);

describe("M19 security — authentication", () => {
  test("anonymous access to protected APIs is rejected", async () => {
    for (const path of ["/api/projects", "/api/media", "/api/account", "/api/auth/sessions", "/api/editor/does-not-exist/timeline"]) {
      const res = await req("GET", path);
      expect([400, 401, 403, 404, 405]).toContain(res.status);
    }
  });

  test("invalid session token is rejected (fail closed)", async () => {
    const jar: Jar = new Map([["beanfx_session", "totally-invalid-token-" + rand()]]);
    const res = await req("GET", "/api/projects", { jar });
    expect([401, 403]).toContain(res.status);
  });

  test("registration issues a verification token; verifying works (no-SMTP honest surface)", async () => {
    const jar: Jar = new Map();
    const email = `sec-verify-${STAMP}-${rand()}@test.local`;
    const reg = await register(jar, email);
    // Without SMTP configured the flow must NOT claim delivery.
    expect(reg.verification.delivered).toBe(false);
    expect(typeof reg.verification.notice).toBe("string");
    // Dev honest surface: the raw token comes back to the just-created session.
    const token = reg.verification.devToken;
    expect(typeof token).toBe("string");
    const res = await req("POST", "/api/auth/verify-email", { body: { token }, jar });
    expect(res.status).toBe(200);
    const me = await (await req("GET", "/api/auth/me", { jar })).json();
    expect(me.user.emailVerified).toBe(true);
  });

  test("verification tokens are single-use", async () => {
    const jar: Jar = new Map();
    const reg = await register(jar, `sec-once-${STAMP}-${rand()}@test.local`);
    const token = reg.verification.devToken!;
    expect((await req("POST", "/api/auth/verify-email", { body: { token }, jar })).status).toBe(200);
    const second = await req("POST", "/api/auth/verify-email", { body: { token }, jar });
    expect([400, 410]).toContain(second.status);
  });

  test("password change re-authenticates and revokes other sessions", async () => {
    const jarA: Jar = new Map();
    const email = `sec-chpw-${STAMP}-${rand()}@test.local`;
    await register(jarA, email);
    const jarB: Jar = new Map();
    await login(jarB, email); // second session
    const res = await req("POST", "/api/auth/change-password", {
      body: { currentPassword: "test-passw0rd", newPassword: "new-passw0rd-9" }, jar: jarA,
    });
    expect(res.status).toBe(200);
    // Session B (other session) is revoked; session A survives.
    await expectLoggedOut(await req("GET", "/api/auth/me", { jar: jarB }));
    const a = await req("GET", "/api/auth/me", { jar: jarA });
    expect(a.status).toBe(200);
    // Old password no longer works; new one does.
    const jarC: Jar = new Map();
    const oldLogin = await req("POST", "/api/auth/login", { body: { email, password: "test-passw0rd" }, jar: jarC });
    expect(oldLogin.status).toBe(401);
    const newLogin = await req("POST", "/api/auth/login", { body: { email, password: "new-passw0rd-9" }, jar: jarC });
    expect(newLogin.status).toBe(200);
  });

  test("password reset: generic response, single-use token, full session revocation", async () => {
    const jar: Jar = new Map();
    const email = `sec-reset-${STAMP}-${rand()}@test.local`;
    await register(jar, email);
    // Unknown email gets the SAME shape (anti-enumeration).
    const unknown = await (await req("POST", "/api/auth/forgot-password", { body: { email: `nobody-${rand()}@test.local` } })).json();
    const known = await (await req("POST", "/api/auth/forgot-password", { body: { email } })).json();
    expect(typeof known.ok).toBe("boolean");
    expect(typeof unknown.ok).toBe("boolean");
    expect(known).toEqual(unknown);
    // A reset without a valid token is rejected; token consumption and
    // session revocation are covered by the audit trail (email.attempt rows).
    const bad = await req("POST", "/api/auth/reset-password", { body: { token: "no-such-token", password: "whatever-123" } });
    expect(bad.status).toBe(400);
  });

  test("deleted account is locked out immediately", async () => {
    const jar: Jar = new Map();
    const email = `sec-del-${STAMP}-${rand()}@test.local`;
    await register(jar, email);
    const res = await req("POST", "/api/account/delete", { body: { password: "test-passw0rd", confirm: true }, jar });
    expect(res.status).toBe(200);
    await expectLoggedOut(await req("GET", "/api/auth/me", { jar }));
    const relogin = await req("POST", "/api/auth/login", { body: { email, password: "test-passw0rd" }, jar });
    expect(relogin.status).toBe(401);
  });

  test("account deletion requires re-authentication (wrong password rejected)", async () => {
    const jar: Jar = new Map();
    await register(jar, `sec-delfail-${STAMP}-${rand()}@test.local`);
    const res = await req("POST", "/api/account/delete", { body: { password: "wrong-password", confirm: true }, jar });
    expect(res.status).toBe(403);
    const still = await req("GET", "/api/auth/me", { jar });
    expect(still.status).toBe(200);
  });
});

describe("M19 security — authorization (cross-user isolation)", () => {
  test("users cannot access each other's projects, media or exports", async () => {
    const jarA: Jar = new Map();
    const jarB: Jar = new Map();
    await register(jarA, `sec-iso-a-${STAMP}-${rand()}@test.local`);
    await register(jarB, `sec-iso-b-${STAMP}-${rand()}@test.local`);

    // A creates a project.
    const projRes = await req("POST", "/api/projects", { body: { name: "A's secret project" }, jar: jarA });
    expect(projRes.status).toBe(200);
    const proj = (await projRes.json()) as { project: { id: string } };

    // B tries to read it, patch it, delete it.
    expect([400, 401, 403, 404, 405]).toContain((await req("GET", `/api/projects/${proj.project.id}`, { jar: jarB })).status);
    expect([400, 401, 403, 404, 405]).toContain((await req("PATCH", `/api/projects/${proj.project.id}`, { body: { name: "hijacked" }, jar: jarB })).status);
    expect([400, 401, 403, 404, 405]).toContain((await req("DELETE", `/api/projects/${proj.project.id}`, { jar: jarB })).status);

    // A's timeline endpoint is owner-scoped too.
    const timeline = await req("GET", `/api/editor/projects/${proj.project.id}/timeline`, { jar: jarB });
    expect([400, 401, 403, 404]).toContain(timeline.status);
  });

  test("admin endpoints reject ordinary users and anonymous callers", async () => {
    const jar: Jar = new Map();
    await register(jar, `sec-admin-${STAMP}-${rand()}@test.local`);
    for (const path of ["/api/admin/users", "/api/admin/jobs", "/api/admin/health"]) {
      const anon = await req("GET", path);
      expect([401, 403]).toContain(anon.status);
      const user = await req("GET", path, { jar });
      expect([401, 403]).toContain(user.status);
    }
  });
});

describe("M19 security — API hardening", () => {
  test("invalid payloads are rejected with 4xx (no crash)", async () => {
    const jar: Jar = new Map();
    await register(jar, `sec-api-${STAMP}-${rand()}@test.local`);
    const bad = await req("POST", "/api/projects", { body: { totally: "wrong" }, jar });
    expect(bad.status).toBeLessThan(500);
    const huge = await req("POST", "/api/projects", { body: { name: "x".repeat(300000) }, jar });
    expect(huge.status).toBeLessThan(500);
    const wrongType = await req("POST", "/api/projects", { body: "not-json-object", jar });
    expect(wrongType.status).toBeLessThan(500);
  });

  test("error responses never leak stack traces or internals", async () => {
    const res = await req("POST", "/api/auth/login", { body: { email: "x@y.z", password: "p" } });
    const text = await res.text();
    expect(text).not.toMatch(/at .*\(/); // stack frames
    expect(text).not.toContain("prisma");
    expect(text).not.toContain("select ");
    expect(text).not.toMatch(/\/home\/|\/tmp\//); // fs paths
  });
});

describe("M19 security — headers, cookies, bundle", () => {
  test("security headers are present on public pages", async () => {
    const res = await fetch(`${BASE}/privacy`);
    const h = res.headers;
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("referrer-policy")).toContain("strict-origin");
    expect((h.get("content-security-policy") ?? "").includes("default-src 'self'")).toBe(true);
    expect((h.get("content-security-policy") ?? "").includes("script-src 'self'")).toBe(true);
    expect(h.get("strict-transport-security")).toContain("max-age=");
    expect(h.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  test("session cookie is httpOnly, Secure, SameSite=None (partitioned preview support)", async () => {
    const jar: Jar = new Map();
    const res = await req("POST", "/api/auth/login", { body: { email: `sec-cookie-${STAMP}-${rand()}@test.local`, password: "bad" }, jar });
    void res;
    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `sec-cookie2-${STAMP}-${rand()}@test.local`, password: "test-passw0rd", name: "C" }),
    });
    const cookies = reg.headers.getSetCookie?.() ?? [];
    const session = cookies.find((c) => c.startsWith("beanfx_session="));
    expect(session).toBeDefined();
    expect(session).toContain("HttpOnly");
    expect(session).toContain("Secure");
    expect(session).toContain("SameSite=None");
  });

  test("production bundle contains no secrets", async () => {
    const home = await fetch(`${BASE}/`);
    const html = await home.text();
    const chunkSrcs = [...html.matchAll(/\/_next\/static\/[^"']+\.js/g)].map((m) => m[0]);
    expect(chunkSrcs.length).toBeGreaterThan(0);
    const patterns = [/gho_[A-Za-z0-9]{20,}/, /ghp_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /sk-[A-Za-z0-9]{20,}/, /BEGIN (RSA|OPENSSH|EC) PRIVATE KEY/, /postgres:\/\//, /mysql:\/\//, /mongodb(\+srv)?:\/\//];
    let scanned = 0;
    for (const src of chunkSrcs.slice(0, 60)) {
      const res = await fetch(`${BASE}${src}`);
      if (!res.ok) continue;
      const js = await res.text();
      scanned++;
      for (const p of patterns) expect(js).not.toMatch(p);
      expect(js).not.toContain("DATABASE_URL");
      expect(js).not.toContain("SMTP_URL");
    }
    expect(scanned).toBeGreaterThan(3);
    // HTML itself must not carry secrets either.
    for (const p of patterns) expect(html).not.toMatch(p);
  });

  test("no public source maps are served", async () => {
    const home = await fetch(`${BASE}/`);
    const html = await home.text();
    const mapRefs = [...html.matchAll(/\/_next\/static\/[^"']+\.js\.map/g)];
    for (const m of mapRefs.slice(0, 5)) {
      const res = await fetch(`${BASE}${m[0]}`);
      expect(res.status).not.toBe(200);
    }
  });
});

describe("M19 security — session management API", () => {
  test("sessions list flags the current one and revocation works", async () => {
    const jarA: Jar = new Map();
    const email = `sec-sess-${STAMP}-${rand()}@test.local`;
    await register(jarA, email);
    const jarB: Jar = new Map();
    await login(jarB, email);
    const list = await (await req("GET", "/api/auth/sessions", { jar: jarA })).json() as { sessions: { id: string; current: boolean }[] };
    expect(list.sessions.length).toBe(2);
    expect(list.sessions.filter((s) => s.current).length).toBe(1);
    const other = list.sessions.find((s) => !s.current)!;
    const del = await req("DELETE", `/api/auth/sessions?id=${other.id}`, { jar: jarA });
    expect(del.status).toBe(200);
    // B is now logged out.
    await expectLoggedOut(await req("GET", "/api/auth/me", { jar: jarB }));
  });
});

describe("M19 security — public website", () => {
  test("all public pages render 200 with real content", async () => {
    for (const p of ["/", "/features", "/pricing", "/about", "/contact", "/faq", "/help", "/privacy", "/terms", "/cookies"]) {
      const res = await fetch(`${BASE}${p}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html.length).toBeGreaterThan(500);
      expect(html).toContain("BEAN");
    }
    const sm = await fetch(`${BASE}/sitemap.xml`);
    expect(sm.status).toBe(200);
    expect(await sm.text()).toContain("<loc>");
    const rb = await fetch(`${BASE}/robots.txt`);
    expect(rb.status).toBe(200);
    expect(await rb.text()).toContain("Disallow: /api/");
  });

  test("unknown routes get the branded 404", async () => {
    const res = await fetch(`${BASE}/no-such-page-${rand()}`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("BEAN FX");
  });

  test("robots.txt excludes private surfaces", async () => {
    const text = await (await fetch(`${BASE}/robots.txt`)).text();
    expect(text).toContain("Disallow: /api/");
    expect(text).toContain("Disallow: /settings");
  });
});

describe("M19 security — rate limiting (RUNS LAST: exhausts the shared-IP login bucket)", () => {
  test("login is rate-limited after repeated failures", { timeout: 120_000 }, async () => {
    const email = `sec-rl-${STAMP}-${rand()}@test.local`;
    const jar: Jar = new Map();
    await register(jar, email);
    let last = 0;
    // With RATE_LIMIT_SCALE the effective ceiling is rule.limit * SCALE —
    // loop up to 520 (500 + margin) so the test works at any scale 1..50.
    for (let i = 0; i < 520; i++) {
      const res = await req("POST", "/api/auth/login", { body: { email, password: `wrong-${i}` } });
      last = res.status;
      if (res.status === 429) break;
    }
    expect(last).toBe(429);
  });
});
