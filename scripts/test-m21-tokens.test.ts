/**
 * M21 P2 tests — integration tokens + API v1 guards (bun test, isolated DB).
 * Direct module invocation, same pattern as the M8 automation API tests.
 * Run: bun test scripts/test-m21-tokens.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m21-tok-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
process.env.NODE_ENV = "production";

execSync("bunx prisma db push --skip-generate --accept-data-loss", {
  env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` },
  stdio: ["ignore", "ignore", "inherit"],
});

let db: typeof import("../src/lib/db").db;
let tok: typeof import("../src/lib/integration-tokens");
let coreTypes: typeof import("../src/lib/core/types");

const USER = "m21-token-user";

beforeAll(async () => {
  db = (await import("../src/lib/db")).db;
  tok = await import("../src/lib/integration-tokens");
  coreTypes = await import("../src/lib/core/types");
  await db.user.create({ data: { id: USER, email: "m21tok@test.local", passwordHash: "x", emailVerified: true } });
});

describe("integration token lifecycle (M21 §7)", () => {
  test("create returns raw token exactly once, stores only the hash + prefix", async () => {
    const created = await tok.createIntegrationToken(USER, "bridge-1", ["projects:read", "jobs:submit"], 30);
    expect(created.raw.startsWith("bfx_")).toBe(true);
    expect(created.raw.length).toBe(4 + 64); // 256-bit hex
    expect(created.prefix).toBe(created.raw.slice(0, 12));
    const row = await db.integrationToken.findUnique({ where: { id: created.id } });
    expect(row?.tokenHash).not.toBe(created.raw);
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.scopes).toBe(JSON.stringify(["projects:read", "jobs:submit"]));
    expect(row?.expiresAt).toBeTruthy();
    // raw never appears in list output
    const listed = await tok.listIntegrationTokens(USER);
    expect(listed.length).toBe(1);
    expect(JSON.stringify(listed)).not.toContain(created.raw);
  });

  test("verify accepts the raw token and throttles lastUsedAt writes", async () => {
    const created = await tok.createIntegrationToken(USER, "bridge-2", ["projects:read"]);
    const a1 = await tok.verifyIntegrationToken(`Bearer ${created.raw}`);
    expect(a1?.userId).toBe(USER);
    expect(a1?.scopes).toEqual(["projects:read"]);
    const row = await db.integrationToken.findUnique({ where: { id: created.id } });
    const t1 = row?.lastUsedAt;
    const a2 = await tok.verifyIntegrationToken(`Bearer ${created.raw}`);
    expect(a2).toBeTruthy();
    const row2 = await db.integrationToken.findUnique({ where: { id: created.id } });
    // second verify inside the 60s window → no extra write
    expect(row2?.lastUsedAt?.getTime()).toBe(t1?.getTime());
  });

  test("verify rejects malformed / unknown / revoked / expired tokens", async () => {
    expect(await tok.verifyIntegrationToken(null)).toBe(null);
    expect(await tok.verifyIntegrationToken("Bearer not-a-token")).toBe(null);
    expect(await tok.verifyIntegrationToken(`Bearer bfx_${"0".repeat(64)}`)).toBe(null);
    // revoked
    const t1 = await tok.createIntegrationToken(USER, "revokeme", ["projects:read"]);
    expect(await tok.verifyIntegrationToken(`Bearer ${t1.raw}`)).toBeTruthy();
    expect(await tok.revokeIntegrationToken(USER, t1.id)).toBe(true);
    expect(await tok.verifyIntegrationToken(`Bearer ${t1.raw}`)).toBe(null);
    // expired
    const t2 = await tok.createIntegrationToken(USER, "expireme", ["projects:read"]);
    await db.integrationToken.update({ where: { id: t2.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await tok.verifyIntegrationToken(`Bearer ${t2.raw}`)).toBe(null);
    // revoke of foreign user's token fails
    const t3 = await tok.createIntegrationToken(USER, "foreign", ["projects:read"]);
    expect(await tok.revokeIntegrationToken("someone-else", t3.id)).toBe(false);
    expect(await tok.verifyIntegrationToken(`Bearer ${t3.raw}`)).toBeTruthy();
  });

  test("deleted owner locks tokens out (M19 soft-delete carries over)", async () => {
    const tmp = "m21-deleted-owner";
    await db.user.create({ data: { id: tmp, email: "m21del@test.local", passwordHash: "x" } });
    const t = await tok.createIntegrationToken(tmp, "x", ["projects:read"]);
    expect(await tok.verifyIntegrationToken(`Bearer ${t.raw}`)).toBeTruthy();
    await db.user.update({ where: { id: tmp }, data: { deletedAt: new Date() } });
    expect(await tok.verifyIntegrationToken(`Bearer ${t.raw}`)).toBe(null);
  });

  test("invalid scope sets and names are rejected", async () => {
    await expect(tok.createIntegrationToken(USER, "bad", [] as never)).rejects.toThrow();
    await expect(tok.createIntegrationToken(USER, "bad", ["root:everything"] as never)).rejects.toThrow();
    await expect(tok.createIntegrationToken(USER, "  ", ["projects:read"])).rejects.toThrow();
  });

  test("scopes narrow: effectiveRole never exceeds editor", () => {
    expect(coreTypes.effectiveRole(["projects:read", "jobs:submit", "media:upload"])).toBe("editor");
    expect(coreTypes.TOKEN_SCOPES).not.toContain("admin:all");
    expect(coreTypes.TOKEN_SCOPES.length).toBe(7);
  });
});

describe("API version guard (M21 §13)", () => {
  test("v1 passes; unknown versions get 426 UPGRADE_REQUIRED", () => {
    expect(tok.apiVersionGuard("v1")).toEqual({ ok: true });
    expect(tok.apiVersionGuard(null)).toEqual({ ok: true }); // permissive default
    const r = tok.apiVersionGuard("v9");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(426);
      expect(r.code).toBe("UPGRADE_REQUIRED");
    }
  });
});
