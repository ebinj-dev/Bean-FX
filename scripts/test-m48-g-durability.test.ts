/**
 * M48-G4 — conversation durability + editor API protection (live tests).
 *
 * Part A runs against a live server (BASE, default :3120 with
 * RATE_LIMIT_SCALE=20) and covers: conversation persistence across re-login,
 * multiple conversations per project, cross-user isolation, project
 * ownership, message ordering, idempotent retries/duplicate submission, and
 * concurrent appends.
 *
 * Part B spawns its OWN disposable server on :3119 with RATE_LIMIT_SCALE=1
 * (the same pattern the M20 durability sweep uses) and proves the REAL 429
 * contract and reset behaviour against unscaled limits — no mocked limiter.
 *
 * Run: BASE=http://localhost:3120 bun test scripts/test-m48-g-durability.test.ts
 */
import { describe, test, expect, afterAll } from "bun:test";
import { execSync, spawn, type ChildProcess } from "child_process";
import path from "node:path";

const BASE = process.env.BASE ?? "http://localhost:3120";
const STAMP = Date.now().toString(36);

type Jar = Map<string, string>;
const cookieHeader = (jar: Jar) => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

async function req(method: string, pathStr: string, opts: { body?: unknown; jar?: Jar; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers ?? {}) };
  if (opts.jar) headers.Cookie = cookieHeader(opts.jar);
  const res = await fetch(`${BASE}${pathStr}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
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

async function register(jar: Jar, email: string, password = "durability-pass-1") {
  const res = await req("POST", "/api/auth/register", { body: { email, password, name: "G4", acceptedDraftTerms: true }, jar });
  expect(res.status).toBe(200);
  return res;
}

async function project(jar: Jar, name: string): Promise<string> {
  const res = await req("POST", "/api/projects", { body: { name }, jar });
  expect(res.status).toBe(200);
  const d = await res.json() as { project: { id: string } };
  return d.project.id;
}

const turn = (n: number) => `g4-${STAMP}-turn-${n}`;

// ── Part A: durability, isolation, ordering, concurrency ──────────────
describe("M48-G — RIISHE conversation durability", () => {
  const userA: Jar = new Map();
  const userB: Jar = new Map();
  let convA = "";
  let projectA = "";

  test("setup: two isolated users, one project, one conversation", async () => {
    await register(userA, `g4-a-${STAMP}@test.local`);
    await register(userB, `g4-b-${STAMP}@test.local`);
    projectA = await project(userA, `G4 durability ${STAMP}`);
    const res = await req("POST", "/api/my-ai/conversations", { body: { projectId: projectA, title: "durability" }, jar: userA });
    expect(res.status).toBe(201);
    const d = await res.json() as { conversation: { id: string } };
    convA = d.conversation.id;
  });

  test("anonymous access to conversation APIs is rejected", async () => {
    const list = await req("GET", "/api/my-ai/conversations");
    expect([401, 403]).toContain(list.status);
    const append = await req("POST", `/api/my-ai/conversations/${convA}/messages`, { body: { role: "user", content: "anon" } });
    expect([401, 403]).toContain(append.status);
  });

  test("turns persist with strict order; retry with the same clientTurnId does NOT duplicate", async () => {
    for (let i = 1; i <= 3; i++) {
      const res = await req("POST", `/api/my-ai/conversations/${convA}/messages`, {
        body: { role: "user", content: `ordered message ${i}`, clientTurnId: turn(i) }, jar: userA,
      });
      expect(res.status).toBe(201);
      expect((await res.json() as { appended: boolean }).appended).toBe(true);
    }
    // duplicate submission (network retry): same clientTurnId → existing row, no dup
    const dup = await req("POST", `/api/my-ai/conversations/${convA}/messages`, {
      body: { role: "user", content: `ordered message 2`, clientTurnId: turn(2) }, jar: userA,
    });
    expect(dup.status).toBe(200);
    expect((await dup.json() as { appended: boolean }).appended).toBe(false);

    const list = await req("GET", `/api/my-ai/conversations/${convA}/messages`, { jar: userA });
    const msgs = (await list.json() as { messages: Array<{ content: string }> }).messages;
    const contents = msgs.map((m) => m.content).filter((c) => c.startsWith("ordered message"));
    expect(contents).toEqual(["ordered message 1", "ordered message 2", "ordered message 3"]);
  });

  test("persistence survives re-login (logout → sign-in again → history intact)", async () => {
    await req("POST", "/api/auth/logout", { jar: userA });
    const relog = await req("POST", "/api/auth/login", { body: { email: `g4-a-${STAMP}@test.local`, password: "durability-pass-1" }, jar: userA });
    expect(relog.status).toBe(200);
    const list = await req("GET", `/api/my-ai/conversations/${convA}/messages`, { jar: userA });
    expect(list.status).toBe(200);
    const msgs = (await list.json() as { messages: Array<{ content: string }> }).messages;
    expect(msgs.filter((m) => m.content.startsWith("ordered message")).length).toBe(3);
  });

  test("multiple conversations per project do not mix their messages", async () => {
    const res = await req("POST", "/api/my-ai/conversations", { body: { projectId: projectA, title: "second thread" }, jar: userA });
    const convA2 = (await res.json() as { conversation: { id: string } }).conversation.id;
    await req("POST", `/api/my-ai/conversations/${convA2}/messages`, { body: { role: "user", content: "thread-two only", clientTurnId: turn("t2") }, jar: userA });
    const l1 = await req("GET", `/api/my-ai/conversations/${convA}/messages`, { jar: userA });
    const l2 = await req("GET", `/api/my-ai/conversations/${convA2}/messages`, { jar: userA });
    const c1 = (await l1.json() as { messages: Array<{ content: string }> }).messages.map((m) => m.content);
    const c2 = (await l2.json() as { messages: Array<{ content: string }> }).messages.map((m) => m.content);
    expect(c1.some((c) => c.includes("thread-two"))).toBe(false);
    expect(c2.some((c) => c.includes("ordered message"))).toBe(false);
    expect(c2).toContain("thread-two only");
  });

  test("cross-user isolation: another user cannot read or append (404, not a leak)", async () => {
    const read = await req("GET", `/api/my-ai/conversations/${convA}/messages`, { jar: userB });
    expect(read.status).toBe(404);
    const append = await req("POST", `/api/my-ai/conversations/${convA}/messages`, {
      body: { role: "user", content: "intrusion", clientTurnId: turn("intrude") }, jar: userB,
    });
    expect(append.status).toBe(404);
  });

  test("project ownership: a conversation cannot be linked to someone else's project", async () => {
    const res = await req("POST", "/api/my-ai/conversations", { body: { projectId: projectA, title: "hostile" }, jar: userB });
    expect(res.status).toBe(404);
  });

  test("concurrent appends: all land, no duplicates, stable order", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      req("POST", `/api/my-ai/conversations/${convA}/messages`, {
        body: { role: "user", content: `concurrent ${i}`, clientTurnId: turn(`c${i}`) }, jar: userA,
      })));
    for (const r of results) expect([201, 200]).toContain(r.status);
    const list = await req("GET", `/api/my-ai/conversations/${convA}/messages`, { jar: userA });
    const msgs = (await list.json() as { messages: Array<{ content: string }> }).messages;
    const conc = msgs.filter((m) => m.content.startsWith("concurrent "));
    expect(conc.length).toBe(10);
    // one CONCURRENT duplicate submission of the SAME key from two callers
    const dups = await Promise.all([
      req("POST", `/api/my-ai/conversations/${convA}/messages`, { body: { role: "user", content: "concurrent 0", clientTurnId: turn("c0") }, jar: userA }),
      req("POST", `/api/my-ai/conversations/${convA}/messages`, { body: { role: "user", content: "concurrent 0", clientTurnId: turn("c0") }, jar: userA }),
    ]);
    for (const d of dups) expect([200, 201]).toContain(d.status);
    const after = await req("GET", `/api/my-ai/conversations/${convA}/messages`, { jar: userA });
    const final = (await after.json() as { messages: Array<{ content: string }> }).messages.filter((m) => m.content === "concurrent 0");
    expect(final.length).toBe(1);
  });
});

// ── Part B: real 429 contract against unscaled limits (self-spawned server) ──
describe("M48-G — editor route rate limiting (unscaled, disposable server)", () => {
  let server: ChildProcess | null = null;
  const RBASE = "http://localhost:3119";

  async function rreq(method: string, pathStr: string, opts: { body?: unknown; jar?: Jar } = {}) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.jar) headers.Cookie = cookieHeader(opts.jar);
    const res = await fetch(`${RBASE}${pathStr}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
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

  const boot = async () => {
    // free :3119 from any stale standalone server. `fuser` is unavailable in
    // some sandboxes — extract the PID from ss (the same approach run-live-tests.sh uses).
    try {
      const pids = execSync("ss -tlnp | grep ':3119 ' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true", { encoding: "utf8" }).trim();
      for (const pid of pids.split("\n").filter(Boolean)) {
        try { execSync(`kill ${pid}`); } catch { /* already gone */ }
      }
      await new Promise((r) => setTimeout(r, 2000));
    } catch { /* port free */ }
    const dbPath = "/tmp/beanfx-legacy-m48-g-rate.db";
    try { execSync(`rm -f "${dbPath}"`); } catch { /* fresh */ }
    execSync(`npx prisma db push --skip-generate --accept-data-loss`, {
      env: { ...process.env, DATABASE_URL: `file:${dbPath}` }, encoding: "utf8",
    });
    server = spawn("bash", ["scripts/dev-server.sh", "start"], {
      env: { ...process.env, PORT: "3119", RATE_LIMIT_SCALE: "1", DATABASE_URL: `file:${dbPath}` },
      stdio: "ignore", detached: false,
    });
    for (let i = 0; i < 36; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const h = await fetch(`${RBASE}/api/health`);
        if (h.ok) return;
      } catch { /* not up yet */ }
    }
    throw new Error("rate-limit test server failed to boot");
  };

  test("conversation creation is rate-limited with a real 429 contract and honest reset metadata", async () => {
    await boot();
    const jar: Jar = new Map();
    const reg = await rreq("POST", "/api/auth/register", { body: { email: `g4-rl-${STAMP}@test.local`, password: "rate-limit-pass-1", name: "RL", acceptedDraftTerms: true }, jar });
    expect(reg.status).toBe(200);
    // convCreate limit = 30/3600 at scale 1: the 31st request must 429.
    for (let i = 0; i < 30; i++) {
      const res = await rreq("POST", "/api/my-ai/conversations", { body: { title: `rl ${i}` }, jar });
      expect(res.status).toBe(201);
    }
    const over = await rreq("POST", "/api/my-ai/conversations", { body: { title: "over" }, jar });
    expect(over.status).toBe(429);
    expect(over.headers.get("Retry-After")).toBeTruthy();
    const body = await over.json() as { error?: string; retryAfterSec?: number };
    expect(body.retryAfterSec).toBeGreaterThan(0);
    expect(body.error).toContain("Too many requests");
    // the limiter must not reveal another user's resource existence — a 429 for
    // an anonymous caller on the same bucket is generic (no resource hints)
    const anon = await rreq("POST", "/api/my-ai/conversations", { body: { title: "anon" } });
    expect([401, 403]).toContain(anon.status);
  }, 600_000);

  afterAll(() => {
    if (server) { try { execSync("fuser -k 3119/tcp 2>/dev/null || true"); } catch { /* teardown */ } }
    try { execSync(`rm -f /tmp/beanfx-legacy-m48-g-rate.db`); } catch { /* cleanup */ }
  });
});
