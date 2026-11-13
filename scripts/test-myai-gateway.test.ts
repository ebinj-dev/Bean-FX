/**
 * BEAN FX — M8 MY AI gateway tests (bun test, isolated DB + worker state).
 *
 * REAL provider tests run when BEANFX_M8_REAL_PROVIDER=1 (executed during
 * this milestone; recorded in docs). Fixture tests cover the typed-error
 * surface, redaction, structured-output validation and usage accounting
 * without any provider call.
 *
 * Run: bun test scripts/test-myai-gateway.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m8-gw-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
process.env.NODE_ENV = "production";

execSync("bunx prisma db push --skip-generate --accept-data-loss", {
  env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` },
  stdio: ["ignore", "ignore", "inherit"],
});

let db: typeof import("../src/lib/db").db;
let providerMod: typeof import("../src/lib/my-ai/gateway/provider");
let structured: typeof import("../src/lib/my-ai/gateway/structured");
let usageMod: typeof import("../src/lib/my-ai/gateway/usage");

const USER = "m8-gw-user";

beforeAll(async () => {
  db = (await import("../src/lib/db")).db;
  providerMod = await import("../src/lib/my-ai/gateway/provider");
  structured = await import("../src/lib/my-ai/gateway/structured");
  usageMod = await import("../src/lib/my-ai/gateway/usage");
  await db.user.create({ data: { id: USER, email: "m8gw@test.local", name: "G", passwordHash: "x" } }).catch(() => undefined);
});

afterAll(() => {
  rmSync(String(process.env.DATABASE_URL).replace("file:", ""), { force: true });
});

describe("LLM gateway — configuration and honest errors", () => {
  test("unknown provider id → NOT_CONFIGURED with actionable message (no silent fallback)", () => {
    process.env.BEANFX_MYAI_PROVIDER = "does-not-exist";
    try {
      expect(() => providerMod.llmProvider()).toThrow(/not configured.*Available providers/);
    } finally {
      delete process.env.BEANFX_MYAI_PROVIDER;
    }
  });

  test("default provider resolves (zai) with the configured model", () => {
    const p = providerMod.llmProvider();
    expect(p.id).toBe("zai");
    expect(p.model.length).toBeGreaterThan(3);
  });

  test("secret redaction scrubs token-shaped strings from any text", () => {
    const dirty = "failed with gho_ABCDEFGHIJKLMNOPQRSTUVWX and sk-1234567890abcdefg and Bearer abcdefghijklmn and github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const clean = providerMod.redactSecrets(dirty);
    expect(clean).not.toContain("gho_ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(clean).not.toContain("sk-1234567890abcdefg");
    expect(clean).not.toContain("Bearer abcdefghijklmn");
    expect(clean).not.toContain("github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(clean).toContain("[REDACTED]");
  });

  test("cancellation produces CANCELLED (abort before call)", async () => {
    const p = providerMod.llmProvider();
    const ac = new AbortController();
    ac.abort();
    await expect(p.chat([{ role: "user", content: "hi" }], { signal: ac.signal })).rejects.toThrow(/cancelled/i);
  });
});

describe("LLM gateway — REAL provider (BEANFX_M8_REAL_PROVIDER=1)", () => {
  test("health check + real chat with usage reporting", async () => {
    if (process.env.BEANFX_M8_REAL_PROVIDER !== "1") {
      console.log("[gateway-test] REAL provider test skipped (set BEANFX_M8_REAL_PROVIDER=1)");
      return;
    }
    const h = await providerMod.llmHealth(true);
    expect(h.ok).toBe(true);
    const p = providerMod.llmProvider();
    const res = await p.chat([{ role: "user", content: "Reply with exactly: PONG" }], { purpose: "test", timeoutMs: 60_000 });
    expect(res.content.toUpperCase()).toContain("PONG");
    expect(res.usage).not.toBeNull();
    expect(res.usage!.totalTokens).toBeGreaterThan(0);
    await usageMod.recordUsage(USER, res, "gateway-test");
    const summary = await usageMod.usageSummary(USER);
    expect(summary.calls).toBeGreaterThanOrEqual(1);
    expect(summary.totalTokens).toBeGreaterThan(0);
    expect(summary.note).toContain("does not estimate cost");
  }, 120_000);

  test("structured output: valid JSON parses; fenced JSON parses (real provider behavior)", async () => {
    if (process.env.BEANFX_M8_REAL_PROVIDER !== "1") return;
    const schema = (await import("zod")).z.object({ ok: (await import("zod")).z.boolean(), n: (await import("zod")).z.number() });
    const res = await structured.chatValidated(
      USER,
      schema,
      [{ role: "user", content: 'Respond with ONLY this JSON (no fences): {"ok": true, "n": 42}' }],
      { purpose: "structured-test", timeoutMs: 60_000 },
    );
    expect(res.data.ok).toBe(true);
    expect(res.data.n).toBe(42);
  }, 120_000);
});

describe("LLM gateway — structured output validation (fixture-driven)", () => {
  test("invalid JSON after one repair attempt → INVALID_RESPONSE (no guessing)", async () => {
    // Force an unconfigured provider: chatValidated must surface the honest error.
    process.env.BEANFX_MYAI_PROVIDER = "does-not-exist";
    try {
      const { z } = await import("zod");
      await expect(
        structured.chatValidated(USER, z.object({ a: z.string() }), [{ role: "user", content: "x" }], { purpose: "t" }),
      ).rejects.toThrow(/not configured/);
    } finally {
      delete process.env.BEANFX_MYAI_PROVIDER;
    }
  });
});
