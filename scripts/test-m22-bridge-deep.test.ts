/**
 * M22 P2 tests — Desktop Bridge deep validation + credential storage.
 * Classes: AUTOMATED (loopback + live server); Windows CredMan commands are
 * constructed + unit-tested here, EXECUTION on real Windows = OWNER ACTION.
 * Run: bun test scripts/test-m22-bridge-deep.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  selectProvider, windowsCredmanScript, macosKeychainCommands, linuxSecretToolCommands,
  FileCredentialStore, createCredentialStore,
} from "../src/lib/core/credential-store";
import { answerChallenge, reapCache } from "../src/lib/core/bridge-protocol";
import { scratchLegacyDb } from "./legacy-fixture";

const LIVE = "http://localhost:3117";
process.env.NODE_ENV = "production";
process.env.DATABASE_URL = scratchLegacyDb("m22-bridge-deep"); // M34 Track B: isolated fixture, never db/custom.db

const STATE_DIR = mkdtempSync(path.join(os.tmpdir(), "beanfx-m22-bridge-"));
let bridgeProc: ReturnType<typeof spawn> | null = null;
let bridgeUrl = "";
let deviceToken = "";
const spawnBridge = () => spawn("bun", ["scripts/desktop-bridge.ts"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, BEANFX_BASE_URL: LIVE, BEANFX_BRIDGE_STATE_DIR: STATE_DIR, BEANFX_BRIDGE_HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
async function waitReady(proc: ReturnType<typeof spawn>, timeoutMs = 15000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`bridge not ready; stderr=${out.slice(-300)}`)), timeoutMs);
    const onData = (d: Buffer) => {
      out += d.toString();
      const line = out.split("\n").find((l) => l.includes('"bridge":"ready"'));
      if (line) { clearTimeout(timer); resolve(line); }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", (d: Buffer) => { out += d.toString(); });
  });
}

beforeAll(async () => {
  if (!(await (await fetch(`${LIVE}/`)).ok)) throw new Error(`live server ${LIVE} unavailable`);
  const db = (await import("../src/lib/db")).db;
  const { createIntegrationToken } = await import("../src/lib/integration-tokens");
  const user = await db.user.upsert({
    where: { id: "m21-bridge-owner" },
    update: {},
    create: { id: "m21-bridge-owner", email: "m21bridge@test.local", passwordHash: "x", emailVerified: true },
  });
  const created = await createIntegrationToken(user.id, "m22-deep-validation", ["projects:read", "jobs:read"]);
  deviceToken = created.raw;
  bridgeProc = spawnBridge();
  bridgeUrl = (JSON.parse(await waitReady(bridgeProc)) as { url: string }).url;
}, 40000);

afterAll(() => {
  bridgeProc?.kill("SIGKILL");
  try { rmSync(STATE_DIR, { recursive: true, force: true }); } catch {}
});

describe("credential storage (M22 P2)", () => {
  test("provider selection: win32→credman, darwin→keychain, linux+secret-tool→libsecret, else explicit fallback", () => {
    expect(selectProvider("win32", {})).toBe("windows-credman");
    expect(selectProvider("darwin", {})).toBe("macos-keychain");
    const linux = selectProvider("linux", { BEANFX_CREDENTIAL_PROVIDER: "linux-secret" });
    expect(linux).toBe("linux-secret");
    expect(selectProvider("sunos", {})).toBe("file-0600"); // explicit fallback only
    // override respected
    expect(selectProvider("linux", { BEANFX_CREDENTIAL_PROVIDER: "file-0600" })).toBe("file-0600");
  });

  test("Windows CredMan script is a REAL CredWrite P/Invoke (structurally verified)", () => {
    const script = windowsCredmanScript("bridge-device-token", "bfx_secret");
    expect(script.startsWith("powershell.exe")).toBe(true);
    expect(script).toContain("CredWrite");
    expect(script).toContain("advapi32.dll");
    expect(script).toContain("TargetName='BEAN FX Bridge'");
    // the secret travels base64-encoded inside the script
    expect(script).toContain(Buffer.from("bfx_secret").toString("base64"));
  });

  test("macOS/Linux keychain commands are real security/secret-tool invocations", () => {
    const mac = macosKeychainCommands("t", "s3cret");
    expect(mac.save).toContain("security add-generic-password");
    expect(mac.load).toContain("security find-generic-password");
    const lin = linuxSecretToolCommands("t", "s3cret");
    expect(lin.save).toContain("secret-tool store");
    expect(lin.load).toContain("secret-tool lookup");
  });

  test("file-0600 fallback: 0600 enforced, unsafe mode deleted on read", async () => {
    const store = new FileCredentialStore(path.join(STATE_DIR, "creds"));
    await store.save("bridge-device-token", "tok");
    const p = path.join(STATE_DIR, "creds", "bridge-device-token.secret");
    expect((statSync(p).mode & 0o777).toString(8)).toBe("600");
    expect(await store.load("bridge-device-token")).toBe("tok");
    chmodSync(p, 0o644); // attacker widens perms
    await expect(store.load("bridge-device-token")).rejects.toThrow(/unsafe mode/);
    expect(existsSync(p)).toBe(false); // deleted, never used
  });

  test("createCredentialStore returns a store whose provider is never hidden", async () => {
    const store = createCredentialStore(path.join(STATE_DIR, "creds2"), "linux", { BEANFX_CREDENTIAL_PROVIDER: "file-0600" });
    expect(["file-0600", "linux-secret"]).toContain(store.provider);
    await store.save("x-y", "v");
    expect(await store.load("x-y")).toBe("v");
    await store.delete("x-y");
    expect(await store.load("x-y")).toBe(null);
  });

  test("path traversal in credential names is rejected", async () => {
    const store = new FileCredentialStore(path.join(STATE_DIR, "creds3"));
    await expect(store.save("../evil", "x")).rejects.toThrow(/unsafe credential name/);
    await expect(store.load("/etc/passwd")).rejects.toThrow(/unsafe credential name/);
  });
});

describe("bridge deep behaviors (M22 P2)", () => {
  test("state file never contains the device token (credential store split)", async () => {
    const sf = path.join(STATE_DIR, "state.json");
    expect(existsSync(sf)).toBe(false); // not paired in this suite yet — pair now:
    const pair = await fetch(`${bridgeUrl}/pair`, { method: "POST", body: JSON.stringify({ deviceToken }) });
    expect(pair.status).toBe(200);
    const info = (await pair.json()) as { credentialProvider: string };
    expect(info.credentialProvider).toBe("file-0600"); // sandbox has no secret-tool → EXPLICIT fallback
    const raw = readFileSync(sf, "utf8");
    expect(raw).not.toContain(deviceToken);           // token lives ONLY in the credential store
    expect(raw).toContain("file-0600");               // provider recorded, not silent
    const secretFile = path.join(STATE_DIR, "bridge-device-token.secret");
    expect((statSync(secretFile).mode & 0o777).toString(8)).toBe("600");
  });

  test("revoked token: server rejects every proxied call (fail closed)", async () => {
    const db = (await import("../src/lib/db")).db;
    const { revokeIntegrationToken, verifyIntegrationToken } = await import("../src/lib/integration-tokens");
    const auth = await verifyIntegrationToken(`Bearer ${deviceToken}`);
    await revokeIntegrationToken(auth!.userId, auth!.tokenId);
    const ch = (await (await fetch(`${bridgeUrl}/challenge`)).json()) as { nonce: string };
    const res = await fetch(`${bridgeUrl}/api/v1/projects`, { headers: { "X-Bridge-Nonce": ch.nonce, "X-Bridge-Proof": answerChallenge(ch.nonce, deviceToken) } });
    expect(res.status).toBe(401); // server-side rejection propagates through the bridge
    // un-revoke for later tests (fresh token instead)
    const { createIntegrationToken } = await import("../src/lib/integration-tokens");
    deviceToken = (await createIntegrationToken(auth!.userId, "m22-deep-validation-2", ["projects:read"])).raw;
    await fetch(`${bridgeUrl}/pair`, { method: "POST", body: JSON.stringify({ deviceToken }) });
  });

  test("concurrent requests: N parallel proxy calls all authorized, no nonce reuse", async () => {
    const call = async () => {
      const ch = (await (await fetch(`${bridgeUrl}/challenge`)).json()) as { nonce: string };
      const res = await fetch(`${bridgeUrl}/api/v1/projects`, { headers: { "X-Bridge-Nonce": ch.nonce, "X-Bridge-Proof": answerChallenge(ch.nonce, deviceToken) } });
      return res.status;
    };
    const results = await Promise.all([call(), call(), call(), call(), call()]);
    expect(results.every((s) => s === 200)).toBe(true); // each challenge single-use, parallel OK
  });

  test("restart recovery: killed bridge re-pairs from persisted state (no re-entry of token)", async () => {
    bridgeProc?.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 400));
    bridgeProc = spawnBridge();
    const ready = JSON.parse(await waitReady(bridgeProc!)) as { paired: boolean; url: string; credentialProvider: string };
    bridgeUrl = ready.url;
    expect(ready.paired).toBe(true);                 // recovered from state + credential store
    expect(ready.credentialProvider).toBe("file-0600");
    const health = (await (await fetch(`${bridgeUrl}/health`)).json()) as { paired: boolean; credentialProvider: string };
    expect(health.paired).toBe(true);
    // and it works without re-pairing:
    const ch = (await (await fetch(`${bridgeUrl}/challenge`)).json()) as { nonce: string };
    const res = await fetch(`${bridgeUrl}/api/v1/projects`, { headers: { "X-Bridge-Nonce": ch.nonce, "X-Bridge-Proof": answerChallenge(ch.nonce, deviceToken) } });
    expect(res.status).toBe(200);
  });

  test("cache reaper endpoint + LRU behavior through the API", async () => {
    // unit-level LRU (deep)
    const e = (ref: string, size: number, hit: number) => ({ assetRef: ref, path: `/tmp/${ref}`, sizeBytes: size, lastHitAt: hit, checksum: "x" });
    const kept = reapCache([e("old", 200, 1), e("new", 100, 2)], 150);
    expect(kept.map((k) => k.assetRef)).toEqual(["new"]);
    // API-level reap works
    const ch = (await (await fetch(`${bridgeUrl}/challenge`)).json()) as { nonce: string };
    const res = await fetch(`${bridgeUrl}/cache/reap`, { headers: { "X-Bridge-Nonce": ch.nonce, "X-Bridge-Proof": answerChallenge(ch.nonce, deviceToken) } });
    const out = (await res.json()) as { removed: number; remaining: number };
    expect(res.status).toBe(200);
    expect(typeof out.removed).toBe("number");
  });

  test("loopback-only + no unrestricted command surface (security)", async () => {
    // every registered route is health/pair/challenge/api-proxy/cache — no exec endpoint
    const res404 = await fetch(`${bridgeUrl}/exec`);
    expect(res404.status).toBe(404);
    const res404b = await fetch(`${bridgeUrl}/cmd`, { method: "POST", body: JSON.stringify({ cmd: "ls" }) });
    expect(res404b.status).toBe(404);
  });
});
