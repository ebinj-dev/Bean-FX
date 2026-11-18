/**
 * M21 P6 — Desktop Bridge protocol (shared by the local service and tests).
 *
 * Trust model (M21 spec §5):
 *  - the bridge binds 127.0.0.1 ONLY, on an EPHEMERAL port; binding any
 *    external interface is refused at startup
 *  - local callers authenticate by PROOF OF POSSESSION: the bridge issues a
 *    nonce, the caller answers HMAC-SHA256(nonce, deviceToken) — the device
 *    token never crosses the wire after pairing
 *  - the device token IS a BEAN FX integration token (server-scoped); the
 *    bridge acts as an untrusted client: the server applies the same quota,
 *    scope and isolation rules as for any other caller
 *  - secrets live in the state file with 0600 perms; the OS-keychain hook
 *    is platform work (owner action) — file perms are the sandbox-safe floor
 */
import { createHash, createHmac, randomBytes } from "node:crypto";

export const BRIDGE_PROTOCOL_VERSION = "beanfx-bridge-v1";

export interface PairRequest {
  protocolVersion: string;
  /** Raw BEAN FX integration token presented once during pairing. */
  deviceToken: string;
}

export interface PairResponse {
  ok: boolean;
  error?: string;
  bridgeId: string;
  scopes: string[];
}

export interface ChallengeInfo {
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

/** HMAC proof the local caller returns for a challenge. */
export function answerChallenge(nonce: string, deviceToken: string): string {
  return createHmac("sha256", deviceToken).update(nonce).digest("hex");
}

export function verifyChallenge(nonce: string, deviceToken: string, answer: string): boolean {
  const expected = answerChallenge(nonce, deviceToken);
  const a = Buffer.from(answer, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && a.length === 64 && createHash("sha256").update(a).digest("hex") === createHash("sha256").update(b).digest("hex");
}

export function newNonce(): string {
  return randomBytes(24).toString("hex");
}

/** Ephemeral-port loopback bind: refuses any non-loopback host. */
export function assertLoopbackBind(host: string): void {
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(`Desktop Bridge refuses non-loopback bind (got ${host})`);
  }
}

// ---------- local cache (media reaper, §9) ----------

export interface CacheEntry {
  assetRef: string;
  path: string;
  sizeBytes: number;
  lastHitAt: number;
  checksum: string;
}

/** LRU-ish reaper: drop entries over budget, oldest hits first. */
export function reapCache(entries: CacheEntry[], budgetBytes: number): CacheEntry[] {
  let total = entries.reduce((s, e) => s + e.sizeBytes, 0);
  if (total <= budgetBytes) return entries;
  const kept = [...entries].sort((a, b) => a.lastHitAt - b.lastHitAt);
  const out: CacheEntry[] = [];
  for (const e of kept) {
    if (total > budgetBytes) {
      total -= e.sizeBytes;
    } else {
      out.push(e);
    }
  }
  return out.sort((a, b) => b.lastHitAt - a.lastHitAt); // most-recent first
}

export function fileChecksum(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}
