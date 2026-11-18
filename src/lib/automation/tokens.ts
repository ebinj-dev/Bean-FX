/**
 * Automation credentials (M8 §9B) — per-client tokens for MCP / JSON-RPC.
 * Raw token format: `bfx_<prefix>_<secret>`; ONLY the SHA-256 hash is stored.
 * Profile: read-only (default) | editing. Optional tool allowlist.
 */
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";

export type AutomationProfile = "read-only" | "editing";

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export interface CreatedToken {
  id: string;
  raw: string; // shown ONCE
  prefix: string;
  profile: AutomationProfile;
}

export async function createToken(userId: string, name: string, profile: AutomationProfile, allowlist?: string[]): Promise<CreatedToken> {
  const prefix = randomBytes(4).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  const raw = `bfx_${prefix}_${secret}`;
  const row = await db.automationToken.create({
    data: {
      userId,
      name: name.slice(0, 80),
      tokenHash: hashToken(raw),
      prefix,
      profile,
      allowlistJson: allowlist && allowlist.length > 0 ? JSON.stringify(allowlist.slice(0, 100)) : null,
    },
  });
  return { id: row.id, raw, prefix, profile };
}

export interface VerifiedToken {
  id: string;
  userId: string;
  profile: AutomationProfile;
  allowlist: string[];
}

/** Constant-time verification; touches lastUsedAt. */
export async function verifyToken(raw: string): Promise<VerifiedToken | null> {
  if (!raw.startsWith("bfx_")) return null;
  const hash = hashToken(raw);
  const rows = await db.automationToken.findMany({
    where: { revokedAt: null },
    select: { id: true, userId: true, tokenHash: true, profile: true, allowlistJson: true },
    take: 500,
  });
  const match = rows.find((r) => {
    const a = Buffer.from(r.tokenHash ?? "", "hex");
    const b = Buffer.from(hash, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  });
  if (!match) return null;
  void db.automationToken.update({ where: { id: match.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return {
    id: match.id,
    userId: match.userId,
    profile: match.profile === "editing" ? "editing" : "read-only",
    allowlist: match.allowlistJson ? (JSON.parse(match.allowlistJson) as string[]) : [],
  };
}

export async function revokeToken(id: string, userId: string): Promise<boolean> {
  const res = await db.automationToken.updateMany({ where: { id, userId, revokedAt: null }, data: { revokedAt: new Date() } });
  return res.count === 1;
}

export async function listTokens(userId: string): Promise<{ id: string; name: string; prefix: string; profile: string; lastUsedAt: Date | null; createdAt: Date }[]> {
  return db.automationToken.findMany({
    where: { userId, revokedAt: null },
    select: { id: true, name: true, prefix: true, profile: true, lastUsedAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
}
