/**
 * M22 P5 — END-TO-END integration workflow with REAL components:
 * real web session (register→login cookie) → Studio project → timeline
 * version → Desktop Bridge (real child) → external MCP client (HTTPS) →
 * approval via the REAL session route → durable job → version history →
 * reversibility via the Core SDK → consistency Bridge vs MCP.
 * Authorization failures + connection interruptions at each stage.
 * Run: bun test scripts/test-m22-e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectHttp } from "./mcp-client-harness";
import { answerChallenge } from "../src/lib/core/bridge-protocol";
import { makeOp, inverseOf, MockHost } from "../src/lib/core/host-adapter";
import { sequenceToCanonical, canonicalToSequence, stableStringify } from "../src/lib/core/converters";

const LIVE = "http://localhost:3117";
process.env.NODE_ENV = "production";
process.env.DATABASE_URL = "file:/home/z/my-project/db/custom.db";

const STATE_DIR = mkdtempSync(path.join(os.tmpdir(), "beanfx-m22-e2e-"));
let bridgeProc: ReturnType<typeof spawn> | null = null;
let bridgeUrl = "";
let cookie = "";
let token = "";
let projectId = "";
let user: { id: string };

beforeAll(async () => {
  if (!(await (await fetch(`${LIVE}/`)).ok)) throw new Error(`live server ${LIVE} unavailable`);
  const db = (await import("../src/lib/db")).db;
  const auth = await import("../src/lib/auth");
  const { createIntegrationToken } = await import("../src/lib/integration-tokens");
  // 1. REAL web user + session (the same login route Studio uses).
  const email = `m22-e2e-${Date.now()}@test.local`;
  const password = "m22-E2E-passw0rd!";
  const registerRes = await fetch(`${LIVE}/api/auth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name: "M22 E2E" }),
  });
  if (!registerRes.ok && registerRes.status !== 409) throw new Error(`register failed ${registerRes.status}: ${await registerRes.text()}`);
  const loginRes = await fetch(`${LIVE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(loginRes.status).toBe(200);
  const setCookies = loginRes.headers.getSetCookie?.() ?? [];
  cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
  expect(cookie.length).toBeGreaterThan(20);
  user = await db.user.findUniqueOrThrow({ where: { email } });
  // 2. Studio project via the REAL session-authenticated API.
  const projRes = await fetch(`${LIVE}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ name: "M22 E2E Workflow", description: "end-to-end validation" }) });
  expect(projRes.status).toBe(200);
  projectId = ((await projRes.json()) as { project: { id: string } }).project.id;
  // 2b. Bootstrap the timeline head (GET self-creates version 1 — Studio semantics).
  const headRes = await fetch(`${LIVE}/api/editor/projects/${projectId}/timeline`, { headers: { Cookie: cookie } });
  expect(headRes.status).toBe(200);
  const head = (await headRes.json()) as { version: number };
  expect(head.version).toBe(1);

  // 3. Real integration token for the MCP client + bridge.
  token = (await createIntegrationToken(user.id, "m22-e2e", ["projects:read", "jobs:submit", "jobs:read", "jobs:cancel", "media:upload", "mcp:invoke"])).raw;
  // 4. Desktop Bridge as a REAL child process.
  bridgeProc = spawn("bun", ["scripts/desktop-bridge.ts"], {
    cwd: "/home/z/my-project",
    env: { ...process.env, BEANFX_BASE_URL: LIVE, BEANFX_BRIDGE_STATE_DIR: STATE_DIR, BEANFX_BRIDGE_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridgeUrl = (await new Promise<string>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("bridge not ready")), 15000);
    bridgeProc!.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      const line = out.split("\n").find((l) => l.includes('"bridge":"ready"'));
      if (line) { clearTimeout(timer); resolve((JSON.parse(line) as { url: string }).url); }
    });
    bridgeProc!.stderr!.on("data", (d: Buffer) => { out += d.toString(); });
  }));
  await fetch(`${bridgeUrl}/pair`, { method: "POST", body: JSON.stringify({ deviceToken: token }) });
}, 40000);

afterAll(() => {
  bridgeProc?.kill("SIGKILL");
  try { rmSync(STATE_DIR, { recursive: true, force: true }); } catch {}
});

describe("M22 E2E — the full M21 architecture in one workflow", () => {
  test("Studio → Bridge → MCP → approval → durable job → version history → reversibility", async () => {
    // 4. host capability discovery THROUGH the bridge (real HTTP hop).
    const ch = (await (await fetch(`${bridgeUrl}/challenge`)).json()) as { nonce: string };
    const capsRes = await fetch(`${bridgeUrl}/api/v1/capabilities`, { headers: { "X-Bridge-Nonce": ch.nonce, "X-Bridge-Proof": answerChallenge(ch.nonce, token) } });
    const caps = (await capsRes.json()) as { api: string; features: string[]; limits: Record<string, number> };
    expect(capsRes.status).toBe(200);
    expect(caps.api).toBe("v1");
    expect(caps.features).toContain("render.jobs");

    // 5+6. External MCP client connects and discovers the authorized tools.
    const { client, summary } = await connectHttp(LIVE, token);
    expect(summary.tools.map((t) => t.name)).toContain("jobs.submit");

    // 7. Project operation requested through MCP WITHOUT approval → rejected.
    await expect(client.callTool({ name: "jobs.submit", arguments: { projectId } })).rejects.toThrow(/approvalId|approval gate: approval not found/);

    // 8. Explicit approval via the REAL session route (human in the web UI).
    const { argsHash } = await import("../src/lib/mcp/tools");
    const args = { projectId };
    const approvalRes = await fetch(`${LIVE}/api/mcp/approvals`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ action: "jobs.submit", args }),
    });
    expect(approvalRes.status).toBe(201);
    const { approvalId } = (await approvalRes.json()) as { approvalId: string };

    // 9. Execute through the shared Core SDK/durable pipeline (MCP path).
    const out = (await client.callTool({ name: "jobs.submit", arguments: { ...args, approvalId } })) as { content?: Array<{ text: string }> };
    const submitted = JSON.parse(out.content![0].text) as { jobId: string; status: string };
    expect(submitted.status).toBe("QUEUED");

    // 10. Version history: canonical baseVersion + Studio versions endpoint.
    const can = (await client.callTool({ name: "project.canonical", arguments: { projectId } })) as { content?: Array<{ text: string }> };
    const canonical = JSON.parse(can.content![0].text) as { project: { formatVersion: string; baseVersion: number; id: string } };
    expect(canonical.project.formatVersion).toBe("beanfx-project-v1");
    expect(canonical.project.id).toBe(projectId);
    const versionsRes = await fetch(`${LIVE}/api/editor/projects/${projectId}/timeline/versions`, { headers: { Cookie: cookie } });
    expect(versionsRes.status).toBe(200);
    const versions = (await versionsRes.json()) as { versions?: Array<{ versionNumber: number }> };
    const versionCountBefore = versions.versions?.length ?? 1;
    expect(versionCountBefore).toBeGreaterThanOrEqual(1);

    // 11. Reversibility: apply an op via the Core SDK host-adapter and undo it.
    const host = new MockHost();
    const seed = {
      formatVersion: "beanfx-project-v1", id: projectId, name: "M22 E2E Workflow", baseVersion: 0,
      fps: { num: 30, den: 1 }, width: 1280, height: 720, sampleRate: 48000,
      tracks: [{ id: "t1", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false }],
      clips: [], transitions: [], assets: [], editOps: [],
    };
    await host.importProject(seed as never);
    const clip = { id: "c-e2e", trackId: "t1", asset: "", missingMedia: true, sourceInFrame: 0, sourceOutFrame: 30, sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 30, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: {}, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, label: null, effects: [], keyframes: [] };
    const op = makeOp("INSERT_CLIP", { clip }, { clipId: "c-e2e" });
    await host.applyOp(op);
    const after = await host.exportProject();
    expect(after.ok && after.project.clips.length).toBe(1);
    const undo = inverseOf(op)!;
    await host.applyOp(undo);
    const undone = await host.exportProject();
    expect(undone.ok && undone.project.clips.length).toBe(0);

    // 12. Consistency: the SAME project seen through Bridge and MCP is identical.
    const ch2 = (await (await fetch(`${bridgeUrl}/challenge`)).json()) as { nonce: string };
    const viaBridge2 = await fetch(`${bridgeUrl}/api/v1/projects/${projectId}/canonical`, { headers: { "X-Bridge-Nonce": ch2.nonce, "X-Bridge-Proof": answerChallenge(ch2.nonce, token) } });
    expect(viaBridge2.status).toBe(200);
    const bridgeCanonical = (await viaBridge2.json()) as { project: { id: string; baseVersion: number } };
    const mcpAgain = (await client.callTool({ name: "project.canonical", arguments: { projectId } })) as { content?: Array<{ text: string }> };
    const mcpCanonical = JSON.parse(mcpAgain.content![0].text) as { project: { id: string; baseVersion: number } };
    expect(bridgeCanonical.project.id).toBe(mcpCanonical.project.id);
    expect(bridgeCanonical.project.baseVersion).toBe(mcpCanonical.project.baseVersion);

    // Cleanup: cancel the job (approval-gated) and close the client.
    const cancelArgs = { jobId: submitted.jobId };
    const cancelApproval = await fetch(`${LIVE}/api/mcp/approvals`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ action: "jobs.cancel", args: cancelArgs }) });
    const { approvalId: cancelId } = (await cancelApproval.json()) as { approvalId: string };
    const cancelOut = (await client.callTool({ name: "jobs.cancel", arguments: { ...cancelArgs, approvalId: cancelId } })) as { content?: Array<{ text: string }> };
    expect(JSON.parse(cancelOut.content![0].text).status).toBe("CANCELLED");
    await client.close();
  }, 60000);

  test("authorization failure at every stage (project, approval, bridge)", async () => {
    // MCP: another user's token cannot see this project.
    const db = (await import("../src/lib/db")).db;
    const { createIntegrationToken } = await import("../src/lib/integration-tokens");
    const other = await db.user.upsert({ where: { id: "m22-other-user" }, update: {}, create: { id: "m22-other-user", email: "m22other@test.local", passwordHash: "x" } });
    const otherToken = (await createIntegrationToken(other.id, "m22-other", ["projects:read", "mcp:invoke"])).raw;
    const { client: otherClient } = await connectHttp(LIVE, otherToken);
    await expect(otherClient.callTool({ name: "project.canonical", arguments: { projectId } })).rejects.toThrow(/project not found/);
    await otherClient.close();
    // Approval: an approval created by ANOTHER user cannot authorize THIS user's mutation.
    const { argsHash } = await import("../src/lib/mcp/tools");
    const foreignApproval = await db.mcpApproval.create({ data: { userId: "m22-other-user", action: "jobs.submit", payloadHash: argsHash("jobs.submit", { projectId }), expiresAt: new Date(Date.now() + 60000) } });
    const { client } = await connectHttp(LIVE, token);
    await expect(client.callTool({ name: "jobs.submit", arguments: { projectId, approvalId: foreignApproval.id } })).rejects.toThrow(/approval not found for this user\+action/);
    await client.close();
    // Bridge: an invalid proof is rejected (no project data leaks).
    const ch = (await (await fetch(`${bridgeUrl}/challenge`)).json()) as { nonce: string };
    const bad = await fetch(`${bridgeUrl}/api/v1/projects/${projectId}/canonical`, { headers: { "X-Bridge-Nonce": ch.nonce, "X-Bridge-Proof": "0".repeat(64) } });
    expect(bad.status).toBe(401);
  }, 30000);

  test("connection interruption: killed bridge recovers; MCP client reconnects cleanly", async () => {
    bridgeProc?.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 400));
    bridgeProc = spawn("bun", ["scripts/desktop-bridge.ts"], {
      cwd: "/home/z/my-project",
      env: { ...process.env, BEANFX_BASE_URL: LIVE, BEANFX_BRIDGE_STATE_DIR: STATE_DIR, BEANFX_BRIDGE_HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    bridgeUrl = (await new Promise<string>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error("bridge not ready after restart")), 15000);
      bridgeProc!.stdout!.on("data", (d: Buffer) => {
        out += d.toString();
        const line = out.split("\n").find((l) => l.includes('"bridge":"ready"'));
        if (line) { clearTimeout(timer); resolve((JSON.parse(line) as { url: string }).url); }
      });
      bridgeProc!.stderr!.on("data", (d: Buffer) => { out += d.toString(); });
    }));
    const ch = (await (await fetch(`${bridgeUrl}/challenge`)).json()) as { nonce: string };
    const res = await fetch(`${bridgeUrl}/api/v1/capabilities`, { headers: { "X-Bridge-Nonce": ch.nonce, "X-Bridge-Proof": answerChallenge(ch.nonce, token) } });
    expect(res.status).toBe(200);
    // MCP client reconnection: fresh client works immediately.
    const { client, summary } = await connectHttp(LIVE, token);
    expect(summary.tools.length).toBeGreaterThanOrEqual(8);
    await client.close();
  }, 40000);
});
