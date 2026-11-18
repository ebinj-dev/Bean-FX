/**
 * M21 P2 — integration token management (API v1 auth surface).
 *
 * Security model (M21_EXECUTION_SPEC §7):
 *  - raw token format: `bfx_<64 hex>` (256-bit entropy, crypto.randomBytes)
 *  - storage: SHA-256 hex hash only, unique; raw shown once at creation
 *  - verification: timing-safe compare against the stored hash
 *  - scopes narrow the OWNER's own permissions — a token can never widen
 *    what its inviting user may do (role checks stay server-side)
 *  - revocation is immediate (checked on every request)
 *  - `lastUsedAt` is throttled (one write per 60s window per token)
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import type { TokenScope } from "@/lib/core/types";
import { TOKEN_SCOPES } from "@/lib/core/types";

export const TOKEN_PREFIX = "bfx_";

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export interface CreatedToken {
  id: string;
  raw: string; // returned ONLY here, once
  prefix: string;
  scopes: TokenScope[];
  expiresAt: Date | null;
}

export async function createIntegrationToken(userId: string, name: string, scopes: TokenScope[], ttlDays?: number): Promise<CreatedToken> {
  if (!name.trim() || name.length > 80) throw new Error("token name must be 1-80 chars");
  const clean = [...new Set(scopes)];
  if (clean.length === 0 || clean.some((s) => !TOKEN_SCOPES.includes(s))) {
    throw new Error(`scopes must be a non-empty subset of ${TOKEN_SCOPES.join(",")}`);
  }
  const raw = TOKEN_PREFIX + randomBytes(32).toString("hex");
  const expiresAt = ttlDays && ttlDays > 0 ? new Date(Date.now() + ttlDays * 86400000) : null;
  const row = await db.integrationToken.create({
    data: {
      userId,
      name: name.trim(),
      tokenHash: hashToken(raw),
      tokenPrefix: raw.slice(0, 12),
      scopes: JSON.stringify(clean),
      expiresAt,
    },
  });
  return { id: row.id, raw, prefix: row.tokenPrefix, scopes: clean, expiresAt };
}

export interface TokenAuth {
  tokenId: string;
  userId: string;
  scopes: TokenScope[];
}

/** Verify an `Authorization: Bearer bfx_…` header. Returns null when the
 *  token is missing/unknown/revoked/expired. Never leaks which case failed. */
export async function verifyIntegrationToken(authorization: string | null): Promise<TokenAuth | null> {
  if (!authorization) return null;
  const m = /^Bearer\s+(bfx_[0-9a-f]{64})$/i.exec(authorization.trim());
  if (!m) return null;
  const raw = m[1].toLowerCase();
  const hash = hashToken(raw);
  const row = await db.integrationToken.findUnique({ where: { tokenHash: hash } });
  if (!row || row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
  const owner = await db.user.findUnique({ where: { id: row.userId }, select: { deletedAt: true } });
  if (!owner || owner.deletedAt) return null; // deleted owner locks tokens out too
  // Throttled lastUsedAt (skip when fresh) — avoids a write per request.
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60000) {
    await db.integrationToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }
  let scopes: TokenScope[] = [];
  try { scopes = JSON.parse(row.scopes) as TokenScope[]; } catch { return null; }
  return { tokenId: row.id, userId: row.userId, scopes };
}

export function tokenHasScope(auth: TokenAuth, scope: TokenScope): boolean {
  return auth.scopes.includes(scope);
}

export async function revokeIntegrationToken(userId: string, tokenId: string): Promise<boolean> {
  const row = await db.integrationToken.findUnique({ where: { id: tokenId } });
  if (!row || row.userId !== userId || row.revokedAt) return false;
  await db.integrationToken.update({ where: { id: tokenId }, data: { revokedAt: new Date() } });
  return true;
}

export async function listIntegrationTokens(userId: string) {
  const rows = await db.integrationToken.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, tokenPrefix: true, scopes: true, createdAt: true, lastUsedAt: true, expiresAt: true },
  });
  return rows.map((r) => ({
    ...r,
    scopes: (() => { try { return JSON.parse(r.scopes) as TokenScope[]; } catch { return []; } })(),
  }));
}

// ---------- API version gate (M21 §13) ----------

const SUPPORTED = new Set(["v1"]);

/** 426 UPGRADE_REQUIRED when a client pins an unsupported api version.
 *  Absent header = "v1" (permissive default for first-party callers). */
export function apiVersionGuard(headerValue: string | null): { ok: true } | { ok: false; status: 426; code: string; error: string } {
  const v = (headerValue ?? "v1").trim().toLowerCase();
  if (SUPPORTED.has(v)) return { ok: true };
  return { ok: false, status: 426, code: "UPGRADE_REQUIRED", error: `api version "${v}" unsupported; supported: ${[...SUPPORTED].join(", ")}` };
}
