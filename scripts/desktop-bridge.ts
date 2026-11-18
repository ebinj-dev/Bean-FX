/**
 * M21 P6 — Desktop Bridge service (real loopback server, bun).
 * Run: BEANFX_BASE_URL=http://localhost:3117 bun scripts/desktop-bridge.ts
 *
 * Endpoints (loopback only, ephemeral port, logged at startup):
 *   GET  /health    — liveness + protocol version
 *   POST /pair      — exchange a raw integration token once; stores it 0600
 *   GET  /challenge — nonce for proof-of-possession
 *   POST /api/*     — proxy to BEAN FX /api/v1/* with the stored token
 *                     (requires a valid challenge answer header)
 * The bridge is an UNTRUSTED client: the server enforces scopes/quotas.
 * No shell execution, no arbitrary code paths, no secrets in responses.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  BRIDGE_PROTOCOL_VERSION, assertLoopbackBind, newNonce, verifyChallenge,
  type ChallengeInfo, type CacheEntry, reapCache, fileChecksum,
} from "../src/lib/core/bridge-protocol";

const BASE = (process.env.BEANFX_BASE_URL ?? "http://localhost:3117").replace(/\/$/, "");
const STATE_DIR = process.env.BEANFX_BRIDGE_STATE_DIR ?? "/tmp/beanfx-bridge-state";
const STATE_FILE = join(STATE_DIR, "state.json");
const CACHE_DIR = process.env.BEANFX_BRIDGE_CACHE_DIR ?? join(STATE_DIR, "cache");
const CACHE_BUDGET = Number(process.env.BEANFX_BRIDGE_CACHE_BUDGET ?? 268435456); // 256MB
const HOST = process.env.BEANFX_BRIDGE_HOST ?? "127.0.0.1";

assertLoopbackBind(HOST);
mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(CACHE_DIR, { recursive: true });

interface BridgeState { bridgeId: string; deviceToken: string; pairedAt: string; scopes: string[] }
let state: BridgeState | null = null;
if (existsSync(STATE_FILE)) {
  try { state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as BridgeState; } catch { state = null; }
}

function persistState() {
  if (!state) return;
  writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
}

let challenge: (ChallengeInfo & { answer: string }) | null = null;
const cache = new Map<string, CacheEntry>();

function requireAuthz(req: Request): Response | null {
  // Proof of possession: X-Bridge-Nonce + X-Bridge-Proof must match the
  // ACTIVE challenge (single-flight, 60s TTL).
  if (!state) return json({ ok: false, error: "bridge not paired" }, 401);
  if (!challenge || Date.now() > challenge.expiresAt) return json({ ok: false, error: "no active challenge" }, 401);
  const nonce = req.headers.get("x-bridge-nonce");
  const proof = req.headers.get("x-bridge-proof");
  if (nonce !== challenge.nonce || !proof || !verifyChallenge(challenge.nonce, state.deviceToken, proof)) {
    return json({ ok: false, error: "challenge verification failed" }, 401);
  }
  return null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function proxy(req: Request, url: URL): Promise<Response> {
  // Only NON-versioned /api/* paths get the v1 prefix; /api/v1/* passes through.
  const path = url.pathname.startsWith("/api/v1/") ? url.pathname : url.pathname.replace(/^\/api\//, "/api/v1/");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${state!.deviceToken}`,
    "X-BeanFX-Api-Version": "v1",
  };
  const res = await fetch(`${BASE}${path}${url.search}`, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text() });
  const text = await res.text();
  return new Response(text, { status: res.status, headers: { "Content-Type": res.headers.get("content-type") ?? "application/json", "X-Bridge-Proxied": "1" } });
}

const server = Bun.serve({
  hostname: HOST,
  port: 0, // ephemeral — logged below
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return json({ ok: true, protocol: BRIDGE_PROTOCOL_VERSION, paired: !!state, bridgeId: state?.bridgeId ?? null });
    }
    if (url.pathname === "/pair") {
      if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);
      const body = (await req.json().catch(() => null)) as { deviceToken?: string } | null;
      const token = body?.deviceToken ?? "";
      if (!/^bfx_[0-9a-f]{64}$/i.test(token)) return json({ ok: false, error: "device token must be bfx_<64 hex>" }, 400);
      // Probe the token against the server BEFORE storing (fail closed).
      const probe = await fetch(`${BASE}/api/v1/capabilities`, { headers: { Authorization: `Bearer ${token}`, "X-BeanFX-Api-Version": "v1" } });
      if (!probe.ok) return json({ ok: false, error: `token rejected by server (${probe.status})` }, 400);
      const caps = (await probe.json()) as { features?: string[] };
      state = {
        bridgeId: `bridge-${Date.now().toString(36)}`,
        deviceToken: token,
        pairedAt: new Date().toISOString(),
        scopes: ["projects:read", "jobs:submit", "jobs:read", "jobs:cancel", "media:upload"],
      };
      persistState();
      challenge = null; // force re-challenge after pairing
      return json({ ok: true, bridgeId: state.bridgeId, protocol: BRIDGE_PROTOCOL_VERSION, serverFeatures: caps.features ?? [] });
    }
    if (url.pathname === "/challenge") {
      if (!state) return json({ ok: false, error: "bridge not paired" }, 401);
      challenge = { nonce: newNonce(), issuedAt: Date.now(), expiresAt: Date.now() + 60000, answer: "" };
      return json({ nonce: challenge.nonce, expiresAt: challenge.expiresAt, protocol: BRIDGE_PROTOCOL_VERSION });
    }
    if (url.pathname.startsWith("/api/")) {
      const denied = requireAuthz(req);
      if (denied) return denied;
      challenge = null; // single-use challenge
      return proxy(req, url);
    }
    if (url.pathname === "/cache/list") {
      const denied = requireAuthz(req);
      if (denied) return denied;
      return json({ entries: [...cache.values()], budgetBytes: CACHE_BUDGET });
    }
    if (url.pathname === "/cache/reap") {
      const denied = requireAuthz(req);
      if (denied) return denied;
      const before = [...cache.values()];
      const kept = reapCache(before, CACHE_BUDGET);
      const keptRefs = new Set(kept.map((e) => e.assetRef));
      for (const e of before) {
        if (!keptRefs.has(e.assetRef)) {
          try { unlinkSync(e.path); } catch {}
          cache.delete(e.assetRef);
        }
      }
      return json({ removed: before.length - kept.length, remaining: kept.length });
    }
    return json({ ok: false, error: "not found" }, 404);
  },
});

console.log(JSON.stringify({
  bridge: "ready",
  protocol: BRIDGE_PROTOCOL_VERSION,
  url: `http://${HOST}:${server.port}`,
  pid: process.pid,
  paired: !!state,
}));

export { server };
