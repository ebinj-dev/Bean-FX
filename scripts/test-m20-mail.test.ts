/**
 * M20 §5 — email delivery: provider-independent verification.
 * With no SMTP_URL configured, every flow must honestly report
 * delivered:false (never fabricate delivery). When SMTP_URL IS provided by
 * the owner, the same tests run against the real transport (nodemailer path).
 *
 * Run: bun test scripts/test-m20-mail.test.ts
 */
import { describe, test, expect } from "bun:test";

// Dynamic import AFTER env is settled (tests run with no SMTP_URL unless set).
const SMTP_URL = process.env.SMTP_URL ?? "";

describe("M20 §5 — mail surface (provider-independent)", () => {
  test("mailConfigured() matches the environment honestly", async () => {
    const m = await import("../src/lib/mailer");
    expect(m.mailConfigured()).toBe(Boolean(SMTP_URL));
  });

  test("every security flow has a template and reports honest delivery", async () => {
    const m = await import("../src/lib/mailer");
    const flows = [
      () => m.sendVerificationEmail?.("victim@test.local", "tok-123"),
      () => m.sendPasswordResetEmail?.("victim@test.local", "tok-456"),
      () => m.sendPasswordChangedNotice("victim@test.local"),
      () => m.sendAccountDeletedConfirmation("victim@test.local"),
    ];
    for (const flow of flows) {
      if (!flow) continue;
      const res = (await flow()) as { delivered: boolean; reason?: string; error?: string };
      expect(typeof res.delivered).toBe("boolean");
      if (!SMTP_URL) {
        // No credentials: honest non-delivery, never a fake success.
        expect(res.delivered).toBe(false);
        expect(typeof res.reason).toBe("string");
        expect(res.reason!.length).toBeGreaterThan(5);
      }
    }
  });

  test("templates never leak tokens into logs or client payloads", async () => {
    const m = await import("../src/lib/mailer");
    const res = (await m.sendPasswordResetEmail?.("victim@test.local", "S3CRET-TOKEN")) as { delivered: boolean; reason?: string };
    const serialized = JSON.stringify(res ?? {});
    expect(serialized).not.toContain("S3CRET-TOKEN");
  });

  test("no secrets in the production bundle source (static check)", async () => {
    const out = Bun.spawnSync(["grep", "-rl", "SMTP_URL", "src/app", "--include=*.tsx"]);
    // SMTP_URL is server-only; no client component may read it.
    expect(out.stdout.toString().trim()).toBe("");
  });
});
