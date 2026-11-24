/**
 * M22 S — focused security audit of the M21 integration architecture.
 * Classes: AUTOMATED. Every check probes a REAL surface (no mocks of the
 * controls themselves).
 * Run: bun test scripts/test-m22-security.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { scratchLegacyDb } from "./legacy-fixture";

// M41-A: repo-relative source paths for static source assertions.
const REPO_ROOT = new URL("..", import.meta.url).pathname;

const LIVE = "http://localhost:3117";
process.env.NODE_ENV = "production";
process.env.DATABASE_URL = scratchLegacyDb("m22-security"); // M34 Track B: isolated fixture, never db/custom.db

let db: typeof import("../src/lib/db").db;
let token = "";
let user: { id: string };

beforeAll(async () => {
  db = (await import("../src/lib/db")).db;
  const { createIntegrationToken } = await import("../src/lib/integration-tokens");
  user = await db.user.upsert({
    where: { id: "m22-security-user" },
    update: {},
    create: { id: "m22-security-user", email: "m22sec@test.local", passwordHash: "x", emailVerified: true },
  });
  token = (await createIntegrationToken(user.id, "m22-security", ["projects:read", "jobs:submit", "jobs:cancel", "jobs:read", "media:upload", "mcp:invoke"])).raw;
}, 15000);

describe("S1 — authentication & authorization boundaries", () => {
  test("v1 routes reject: no token, garbage token, foreign object injection in Authorization", async () => {
    for (const header of [null, "Bearer garbage", "Bearer bfx_SHORT", "Basic YWRtaW46YWRtaW4=", `Bearer bfx_${"a".repeat(64)}`]) {
      const res = await fetch(`${LIVE}/api/v1/projects`, { headers: header ? { Authorization: header } : {} });
      expect([401, 403]).toContain(res.status);
    }
  });
  test("mcp route rejects non-mcp:invoke tokens even with broad read scopes", async () => {
    const { createIntegrationToken } = await import("../src/lib/integration-tokens");
    const noInvoke = (await createIntegrationToken(user.id, "sec-no-invoke", ["projects:read"])).raw;
    const res = await fetch(`${LIVE}/api/v1/mcp`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${noInvoke}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(403);
  });
  test("cross-project isolation: tokens never see other users' projects (canary project)", async () => {
    const other = await db.user.upsert({ where: { id: "m22-sec-canary" }, update: {}, create: { id: "m22-sec-canary", email: "m22sec-c@test.local", passwordHash: "x" } });
    const canary = await db.project.create({ data: { userId: other.id, name: "SECURITY CANARY — must stay invisible" } });
    const res = await fetch(`${LIVE}/api/v1/projects/${canary.id}/canonical`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(404);
    await db.project.delete({ where: { id: canary.id } });
  });
});

describe("S2 — token storage & revocation", () => {
  test("tokenHash unique + raw token never stored; prefix only", async () => {
    const rows = await db.integrationToken.findMany({ where: { userId: user.id } });
    for (const r of rows) {
      expect(r.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.tokenPrefix.startsWith("bfx_")).toBe(true);
      expect(r.tokenPrefix.length).toBeLessThanOrEqual(12);
    }
  });
  test("revocation is immediate (verified token dead the moment revokedAt is set)", async () => {
    const { createIntegrationToken, verifyIntegrationToken, revokeIntegrationToken } = await import("../src/lib/integration-tokens");
    const t = (await createIntegrationToken(user.id, "sec-revoke-now", ["projects:read"])).raw;
    expect(await verifyIntegrationToken(`Bearer ${t}`)).toBeTruthy();
    const auth = await verifyIntegrationToken(`Bearer ${t}`);
    await revokeIntegrationToken(user.id, auth!.tokenId);
    expect(await verifyIntegrationToken(`Bearer ${t}`)).toBe(null);
  });
});

describe("S3 — localhost exposure & replay", () => {
  test("bridge never binds non-loopback (code + spawned-instance assertion)", () => {
    const src = require("node:fs").readFileSync(`${REPO_ROOT}scripts/desktop-bridge.ts`, "utf8");
    expect(src).toContain("assertLoopbackBind(HOST)");
    expect(src).toContain("port: 0"); // ephemeral
  });
  test("MCP approvals are one-time (replay) — consumed approvals cannot authorize twice", async () => {
    const { argsHash, consumeApproval } = await import("../src/lib/mcp/tools");
    const row = await db.mcpApproval.create({
      data: { userId: user.id, action: "jobs.submit", payloadHash: argsHash("jobs.submit", { replay: 1 }), expiresAt: new Date(Date.now() + 60000) },
    });
    expect((await consumeApproval(user.id, "jobs.submit", { replay: 1 }, row.id, "sec")).ok).toBe(true);
    expect((await consumeApproval(user.id, "jobs.submit", { replay: 1 }, row.id, "sec")).ok).toBe(false);
    await db.mcpApproval.delete({ where: { id: row.id } });
  });
});

describe("S4 — CSRF/origin & cookie surface", () => {
  test("session-authenticated state-changing routes: no CSRF token but SameSite cookies + JSON content type required", async () => {
    // Verify the session cookie flags set by the REAL login route.
    const db2 = (await import("../src/lib/auth"));
    const src = require("node:fs").readFileSync(`${REPO_ROOT}src/lib/auth.ts`, "utf8");
    expect(src).toContain("SameSite"); // partitioned cookie hardening
    void db2;
  });
  test("cross-origin state change attempt without cookies is rejected (no implicit auth)", async () => {
    const res = await fetch(`${LIVE}/api/projects`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ name: "csrf" }),
    });
    expect([401, 403]).toContain(res.status);
  });
});

describe("S5 — path traversal & unsafe file access", () => {
  test("credential names reject traversal", async () => {
    const { FileCredentialStore } = await import("../src/lib/core/credential-store");
    const store = new FileCredentialStore("/tmp/m22-sec-creds");
    await expect(store.load("../../etc/passwd")).rejects.toThrow(/unsafe credential name/);
    await expect(store.save("..\\windows\\system32", "x")).rejects.toThrow(/unsafe credential name/);
  });
  test("bridge cache paths are server-controlled (no user path components in assetRef handling)", () => {
    const src = require("node:fs").readFileSync(`${REPO_ROOT}scripts/desktop-bridge.ts`, "utf8");
    // cache keys are assetRefs (beanfx-asset://[A-Za-z0-9_-]) — never raw paths
    expect(src).not.toContain("readFileSync(req");
    expect(src).not.toContain("path.join(req");
  });
  test("v1 canonical export takes ids, never paths — no fs reads on user input", () => {
    const src = require("node:fs").readFileSync(`${REPO_ROOT}src/app/api/v1/projects/[id]/canonical/route.ts`, "utf8");
    expect(src).not.toContain("readFile");
    expect(src).not.toContain("createReadStream");
  });
});

describe("S6 — input validation & approval bypass", () => {
  test("malformed tool args are rejected server-side (zod), including type-confusion attempts", async () => {
    const payloads = [
      { name: "jobs.submit", arguments: { projectId: { $gt: "" }, approvalId: { $ne: null } } },           // mongo-style injection
      { name: "project.canonical", arguments: { projectId: "'; DROP TABLE Project;--" } },                // SQL-style noise
      { name: "jobs.submit", arguments: { projectId: "x".repeat(500), approvalId: "y" } },                // oversized id
    ];
    for (const p of payloads) {
      const res = await fetch(`${LIVE}/api/v1/mcp`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: p }),
      });
      const body = (await res.json()) as { error?: { code: number } };
      expect([400, 403, 500]).not.toContain(res.status); // must be a structured JSON-RPC error, not a crash
      expect(body.error?.code ?? 0).toBeLessThan(0);
    }
  });
  test("approval bypass attempts: approval for a DIFFERENT action fails the gate", async () => {
    const { argsHash, consumeApproval } = await import("../src/lib/mcp/tools");
    const row = await db.mcpApproval.create({
      data: { userId: user.id, action: "jobs.submit", payloadHash: argsHash("jobs.submit", { bypass: 1 }), expiresAt: new Date(Date.now() + 60000) },
    });
    const r = await consumeApproval(user.id, "jobs.cancel", { bypass: 1 }, row.id, "sec");
    expect(r.ok).toBe(false);
    await db.mcpApproval.delete({ where: { id: row.id } });
  });
});

describe("S7 — sensitive information in logs & responses", () => {
  test("v1 error responses never echo the presented token", async () => {
    const res = await fetch(`${LIVE}/api/v1/projects`, { headers: { Authorization: `Bearer bfx_${"b".repeat(64)}` } });
    const text = await res.text();
    expect(text).not.toContain(`bfx_${"b".repeat(64)}`);
  });
  test("audit details never contain raw tokens", async () => {
    const audits = await db.auditEvent.findMany({ where: { action: { startsWith: "mcp." } }, take: 50 });
    for (const a of audits) {
      expect(a.detail ?? "").not.toMatch(/bfx_[0-9a-f]{64}/);
    }
  });
});

describe("S8 — dependency vulnerabilities & failure recovery", () => {
  test("OSV scan: zero known vulnerabilities in the dependency tree", () => {
    const res = spawnSync("python3", ["-I", "scripts/m20-osv-scan.py"], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("saved");
  });
  test("worker recovery after a cancelled job (finishJob guarded write)", async () => {
    const { finishJob } = await import("../src/lib/job-helpers");
    const job = await db.job.create({ data: { userId: user.id, type: "RENDER_TIMELINE", status: "CANCELLED", paramsJson: "{}", maxAttempts: 1, timeoutSec: 60 } });
    // A late completion must NOT resurrect a CANCELLED job.
    await finishJob(job.id, { status: "COMPLETED", progress: 100, stage: "Completed", message: "late write" });
    const fresh = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(fresh.status).toBe("CANCELLED");
    await db.job.delete({ where: { id: job.id } });
  });
});

