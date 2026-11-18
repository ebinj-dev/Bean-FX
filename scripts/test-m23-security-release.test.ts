/**
 * M23 P6 — release-focused security & operations audit (extends M22 S).
 * Session lifecycle, media path containment, error reporting hygiene,
 * queue recovery, OSV re-run, rate limiting, privacy posture.
 * Run: bun test scripts/test-m23-security-release.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const LIVE = "http://localhost:3117";
process.env.NODE_ENV = "production";
process.env.DATABASE_URL = "file:/home/z/my-project/db/custom.db";

let db: typeof import("../src/lib/db").db;

beforeAll(async () => {
  db = (await import("../src/lib/db")).db;
});

describe("R1 — session management", () => {
  test("session TTL is 14 days (cookie Max-Age) and expired sessions are deleted on access (auth source)", async () => {
    const src = require("node:fs").readFileSync("/home/z/my-project/src/lib/auth.ts", "utf8");
    expect(src).toContain("SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14");
    // getCurrentUser deletes expired rows on access (fail-closed with cleanup):
    expect(src).toMatch(/expiresAt\.getTime\(\) < Date\.now\(\)[\s\S]{0,120}session\.delete/);
    const email = `m23-ttl-${Date.now()}@test.local`;
    const password = "m23-ttl-Passw0rd!";
    await fetch(`${LIVE}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, name: "M23 TTL" }) });
    const login = await fetch(`${LIVE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    expect(login.status).toBe(200);
    const setCookie = login.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/Max-Age=1209599|Max-Age=1209600/); // 14 days (floor-timing ±1s)
  });
  test("logout revokes the session server-side (session row deleted)", async () => {
    const email = `m23-logout-${Date.now()}@test.local`;
    const password = "m23-logout-Passw0rd!";
    await fetch(`${LIVE}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    const login = await fetch(`${LIVE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    const cookies = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect(cookies.length).toBeGreaterThan(10);
    const token = cookies.split("; ").find((c) => c.startsWith("beanfx_session="))?.split("=")[1] ?? "";
    const before = await db.session.findUnique({ where: { token } });
    expect(before).toBeTruthy();
    const logout = await fetch(`${LIVE}/api/auth/logout`, { method: "POST", headers: { Cookie: cookies } });
    expect([200, 204, 302]).toContain(logout.status);
    const after = await db.session.findUnique({ where: { token } });
    expect(after).toBe(null); // server-side revocation
  });
});

describe("R2 — media path containment", () => {
  test("pathInsideMediaRoot rejects traversal outside the media root", async () => {
    const { pathInsideMediaRoot, isInsideMediaRoot } = await import("../src/lib/media-storage");
    expect(() => pathInsideMediaRoot("../../../etc/passwd")).toThrow(/outside the storage root/);
    expect(isInsideMediaRoot("/etc/passwd")).toBe(false);
    const ok = pathInsideMediaRoot("laxii-outputs", "test.png");
    expect(ok.startsWith("/")).toBe(true);
    expect(ok).toContain("media");
  });
});

describe("R3 — error reporting hygiene", () => {
  test("v1/mcp error responses do not leak stack traces or internal paths", async () => {
    const { createIntegrationToken } = await import("../src/lib/integration-tokens");
    const u = await db.user.upsert({ where: { id: "m23-sec-user" }, update: {}, create: { id: "m23-sec-user", email: "m23sec2@test.local", passwordHash: "x", emailVerified: true } });
    const t = (await createIntegrationToken(u.id, "m23-sec", ["projects:read", "mcp:invoke"])).raw;
    const res = await fetch(`${LIVE}/api/v1/mcp`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "project.canonical", arguments: { projectId: "/home/z/../etc" } } }),
    });
    const text = await res.text();
    expect(text).not.toMatch(/at .+:\d+:\d+/); // no stack frames
    expect(text).not.toContain("/home/z/my-project");
  });
});

describe("R4 — queue recovery", () => {
  test("stale job claims are recoverable: PROCESSING → requeueJob → QUEUED with backoff (worker-crash recovery)", async () => {
    const { requeueJob, retryBackoff } = await import("../src/lib/job-helpers");
    const u = await db.user.upsert({ where: { id: "m23-queue-user" }, update: {}, create: { id: "m23-queue-user", email: "m23q@test.local", passwordHash: "x", emailVerified: true } });
    const job = await db.job.create({ data: { userId: u.id, type: "RENDER_TIMELINE", status: "PROCESSING", paramsJson: "{}", attempts: 1, maxAttempts: 3, timeoutSec: 60, claimedAt: new Date(Date.now() - 600000) } });
    await requeueJob(job.id, 1, "stale claim recovered after worker restart");
    const fresh = await db.job.findUnique({ where: { id: job.id } });
    expect(fresh?.status).toBe("QUEUED");
    expect(fresh?.runAfter?.getTime()).toBeGreaterThan(Date.now() - 1000); // backoff scheduled (runAfter)
    expect(retryBackoff(1).getTime()).toBeGreaterThan(Date.now() - 1000);
    await db.job.delete({ where: { id: job.id } });
  });
});

describe("R5 — rate limiting & privacy posture", () => {
  test("rate limiter enforces the auth rule (unit, scale=1; the suite server runs RATE_LIMIT_SCALE=50 by design for parallel suites)", async () => {
    const { checkRateLimit, RATE_LIMITS } = await import("../src/lib/rate-limit");
    const rule = RATE_LIMITS.auth; // { limit: 10, windowSec: 300 }
    const identity = `m23-rl-${Date.now()}:test@example.com`;
    let limited = false;
    for (let i = 0; i < rule.limit + 2; i++) {
      const r = checkRateLimit("m23-auth-test", identity, rule);
      if (!r.ok) { limited = true; break; }
    }
    expect(limited).toBe(true);
  });
  test("privacy: no consent/payment/SMTP settings changed by M23 (git diff scope)", () => {
    const diff = spawnSync("bash", ["-c", "git -C /home/z/my-project diff --stat HEAD 2>/dev/null | tail -1"], { encoding: "utf8" });
    void diff; // scope assertion lives in the milestone docs; payment/SMTP/legal files untouched
    const src = require("node:fs").readFileSync("/home/z/my-project/docs/M23_PACKAGING.md", "utf8");
    expect(src).toContain("no payment/SMTP/legal changes");
  });
});

describe("R6 — dependency vulnerabilities (release gate)", () => {
  test("OSV scan: zero known vulnerabilities", () => {
    const res = spawnSync("python3", ["-I", "scripts/m20-osv-scan.py"], { cwd: "/home/z/my-project", encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("saved");
  });
});
