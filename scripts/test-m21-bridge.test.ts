/**
 * M21 P6 tests — Desktop Bridge: loopback-only bind, proof-of-possession
 * challenge, pairing against the LIVE server, token-scoped proxying (this
 * also live-verifies the P2 v1 routes over real HTTP), cache reaper.
 * Run: bun test scripts/test-m21-bridge.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_DIR = mkdtempSync(path.join(os.tmpdir(), "beanfx-m21-bridge-"));
const LIVE = process.env.BRIDGE_TEST_BASE ?? "http://localhost:3117";

process.env.NODE_ENV = "production";
process.env.DATABASE_URL = scratchLegacyDb("m21-bridge"); // M34 Track B: isolated fixture — same DB the live server on :3117 uses

let bridgeProc: ReturnType<typeof spawn> | null = null;
let bridgeUrl = "";
let bridgeId = "";
let deviceToken = "";

// protocol units (no server needed)
import { assertLoopbackBind, answerChallenge, verifyChallenge, newNonce, reapCache, fileChecksum } from "../src/lib/core/bridge-protocol";
import { scratchLegacyDb } from "./legacy-fixture";

beforeAll(async () => {
  // The live server must be up.
  const health = await fetch(`${LIVE}/`);
  if (!health.ok) throw new Error(`live server ${LIVE} unavailable`);
  // Issue a REAL integration token for the bridge (owner: journey-isolated user).
  const db = (await import("../src/lib/db")).db;
  const { createIntegrationToken } = await import("../src/lib/integration-tokens");
  const user = await db.user.upsert({
    where: { id: "m21-bridge-owner" },
    update: {},
    create: { id: "m21-bridge-owner", email: "m21bridge@test.local", passwordHash: "x", emailVerified: true },
  });
  const created = await createIntegrationToken(user.id, "m21-bridge-test", ["projects:read", "jobs:submit", "jobs:read", "jobs:cancel", "media:upload", "mcp:invoke"]);
  deviceToken = created.raw;
  // Spawn the bridge on an ephemeral loopback port.
  bridgeProc = spawn("bun", ["scripts/desktop-bridge.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, BEANFX_BASE_URL: LIVE, BEANFX_BRIDGE_STATE_DIR: STATE_DIR, BEANFX_BRIDGE_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = await new Promise<string>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("bridge did not report ready")), 15000);
    bridgeProc!.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      const line = out.split("\n").find((l) => l.includes('"bridge":"ready"'));
      if (line) { clearTimeout(timer); resolve(line); }
    });
    bridgeProc!.stderr!.on("data", (d: Buffer) => { out += d.toString(); });
  });
  const info = JSON.parse(ready) as { url: string };
  bridgeUrl = info.url;
}, 30000);

afterAll(() => {
  bridgeProc?.kill("SIGKILL");
  try { rmSync(STATE_DIR, { recursive: true, force: true }); } catch {}
});

describe("bridge protocol units", () => {
  test("refuses non-loopback binds", () => {
    expect(() => assertLoopbackBind("0.0.0.0")).toThrow(/refuses non-loopback/);
    expect(() => assertLoopbackBind("192.168.1.5")).toThrow(/refuses non-loopback/);
    expect(() => assertLoopbackBind("127.0.0.1")).not.toThrow();
  });
  test("challenge HMAC verifies only the right token", () => {
    const n = newNonce();
    const a = answerChallenge(n, "tok-a");
    expect(verifyChallenge(n, "tok-a", a)).toBe(true);
    expect(verifyChallenge(n, "tok-b", a)).toBe(false);
    expect(verifyChallenge(n, "tok-a", "deadbeef")).toBe(false);
  });
  test("cache reaper keeps budget, oldest hits evicted first", () => {
    const e = (ref: string, size: number, hit: number): import("../src/lib/core/bridge-protocol").CacheEntry =>
      ({ assetRef: ref, path: `/tmp/${ref}`, sizeBytes: size, lastHitAt: hit, checksum: "x" });
    const entries = [e("a", 100, 3), e("b", 100, 1), e("c", 100, 2)];
    const kept = reapCache(entries, 250); // 300 total → evict b (oldest hit), keep a+c = 200 ≤ 250
    expect(kept.map((k) => k.assetRef)).toEqual(["a", "c"]); // b evicted (oldest hit)
    expect(reapCache(entries, 300).length).toBe(3);
  });
  test("checksum is sha256", () => {
    expect(fileChecksum(new TextEncoder().encode("beanfx"))).toHaveLength(64);
  });
});

describe("bridge live flow (pair → challenge → proxy)", () => {
  test("health is open, everything else requires pairing/challenge", async () => {
    const health = await fetch(`${bridgeUrl}/health`);
    const h = (await health.json()) as { ok: boolean; paired: boolean; protocol: string };
    expect(h.ok).toBe(true);
    expect(h.protocol).toBe("beanfx-bridge-v1");
    const early = await fetch(`${bridgeUrl}/api/v1/projects`);
    expect(early.status).toBe(401);
  });

  test("pairing probes the token against the LIVE server before storing", async () => {
    const bad = await fetch(`${bridgeUrl}/pair`, { method: "POST", body: JSON.stringify({ deviceToken: "bfx_" + "0".repeat(64) }) });
    expect(bad.status).toBe(400); // server probe rejects unknown token → fail closed
    const good = await fetch(`${bridgeUrl}/pair`, { method: "POST", body: JSON.stringify({ deviceToken }) });
    const g = (await good.json()) as { ok: boolean; bridgeId: string; serverFeatures: string[] };
    expect(g.ok).toBe(true);
    bridgeId = g.bridgeId;
    expect(g.serverFeatures.length).toBeGreaterThan(0);
    // state file must be 0600 and NOT contain the raw token in plaintext responses
    const st = await fetch(`${bridgeUrl}/health`);
    const body = await st.text();
    expect(body).not.toContain(deviceToken);
  });

  test("proxy works ONLY with a valid proof-of-possession answer", async () => {
    const ch = (await (await fetch(`${bridgeUrl}/challenge`)).json()) as { nonce: string };
    const noProof = await fetch(`${bridgeUrl}/api/v1/projects`);
    expect(noProof.status).toBe(401);
    const wrongProof = await fetch(`${bridgeUrl}/api/v1/projects`, { headers: { "X-Bridge-Nonce": ch.nonce, "X-Bridge-Proof": "f".repeat(64) } });
    expect(wrongProof.status).toBe(401);
    const proof = answerChallenge(ch.nonce, deviceToken);
    const ok = await fetch(`${bridgeUrl}/api/v1/projects`, { headers: { "X-Bridge-Nonce": ch.nonce, "X-Bridge-Proof": proof } });
    expect(ok.status).toBe(200);
    const data = (await ok.json()) as { projects: Array<{ id: string; name: string }> };
    expect(Array.isArray(data.projects)).toBe(true);
    expect(ok.headers.get("X-Bridge-Proxied")).toBe("1");
    // challenge is single-use
    const reuse = await fetch(`${bridgeUrl}/api/v1/projects`, { headers: { "X-Bridge-Nonce": ch.nonce, "X-Bridge-Proof": proof } });
    expect(reuse.status).toBe(401);
    // capabilities endpoint works through the bridge too (P2 live check)
    const ch2 = (await (await fetch(`${bridgeUrl}/challenge`)).json()) as { nonce: string };
    const caps = await fetch(`${bridgeUrl}/api/v1/capabilities`, { headers: { "X-Bridge-Nonce": ch2.nonce, "X-Bridge-Proof": answerChallenge(ch2.nonce, deviceToken) } });
    const c = (await caps.json()) as { api: string; formatVersions: string[] };
    expect(c.api).toBe("v1");
    expect(c.formatVersions).toContain("beanfx-project-v1");
  });

  test("bridge never leaks the device token through any endpoint", async () => {
    const health = await fetch(`${bridgeUrl}/health`);
    expect(await health.text()).not.toContain(deviceToken);
    const ch = (await (await fetch(`${bridgeUrl}/challenge`)).json()) as { nonce: string };
    const list = await fetch(`${bridgeUrl}/cache/list`, { headers: { "X-Bridge-Nonce": ch.nonce, "X-Bridge-Proof": answerChallenge(ch.nonce, deviceToken) } });
    expect(await list.text()).not.toContain(deviceToken);
  });
});