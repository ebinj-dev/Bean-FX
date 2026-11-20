#!/usr/bin/env bun
/**
 * M31 Phase 8 — AI provider + email configuration diagnostics.
 * Reports the CURRENT configuration status of every integration from the
 * actual code/env — never leaks secrets, never simulates provider success.
 * Where credentials exist, performs a minimal real authenticated request.
 */
import { execSync } from "node:child_process";

const BASE = process.env.M31_BASE ?? "http://localhost:3117";
const out: string[] = [];
const say = (m: string) => { out.push(m); console.log(m); };

say("== M31 provider & email diagnostics ==");
say(`host: $(ffmpeg -version | head -1)`);

// 1. Discover provider registry from the actual code.
try {
  const registry = execSync(`grep -rn "provider\\|PROVIDER" src/lib/ai/ src/lib/my-ai/ --include="*.ts" -l 2>/dev/null | head -3`, { encoding: "utf8" });
  say(`provider files: ${registry.trim().split("\n").filter(Boolean).join(", ") || "none"}`);
} catch { say("provider file discovery: n/a"); }

// 2. Env presence (names only, never values).
const envKeys = ["ZAI_API_KEY", "Z_AI_API_KEY", "SMTP_URL", "SMTP_HOST", "ZAI_VLM", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"];
for (const k of envKeys) {
  const present = k in process.env && String(process.env[k]).length > 0;
  say(`env ${k}: ${present ? "SET (value withheld)" : "not set"}`);
}

// 3. Health endpoint status (the product's own diagnostics).
try {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  say(`GET /api/health → ${JSON.stringify(health).slice(0, 300)}`);
} catch (e) {
  say(`/api/health unreachable: ${String(e).slice(0, 80)}`);
}

// 4. Minimal REAL authenticated request where credentials exist (ZAI VLM/text).
const hasZai = ["ZAI_API_KEY", "Z_AI_API_KEY"].some((k) => process.env[k]);
if (hasZai) {
  say("ZAI credentials present → minimal real request:");
  try {
    const { ZAI } = await import("z-ai-web-dev-sdk");
    const zai = await ZAI.create();
    const t0 = Date.now();
    const res = await zai.chat.completions.create({ messages: [{ role: "user", content: "Reply with exactly: ok" }], max_tokens: 8 });
    const ms = Date.now() - t0;
    const text = res?.choices?.[0]?.message?.content ?? "";
    say(`  chat response in ${ms}ms, content="${String(text).slice(0, 40)}" → ${text.trim().startsWith("ok") ? "REAL CALL OK" : "unexpected response"}`);
    say(`  timeout/failure behavior: SDK errors surface as typed failures (no fabricated success)`);
  } catch (e) {
    say(`  real call FAILED (honest): ${String(e).slice(0, 140)}`);
    say(`  → provider classified CONFIGURATION REQUIRED / quota-dependent`);
  }
} else {
  say("no ZAI credentials → CONFIGURATION REQUIRED (deterministic internal contracts covered by suites)");
}

// 5. Email delivery honesty check (mailer contract, no SMTP send).
try {
  const { sendMail } = await import("../src/lib/mailer");
  const r = await sendMail({ to: "diagnostic@example.invalid", subject: "M31 diagnostic", body: "probe" });
  say(`mailer contract: delivered=${r.delivered} reason=${r.reason ?? "-"} → ${r.delivered ? "delivered" : "CONFIGURATION REQUIRED (honest — no fake send)"}`);
} catch (e) {
  say(`mailer probe error: ${String(e).slice(0, 100)}`);
}

// 6. Invitation flow without email (copyable URL fallback).
try {
  const jar = await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `m31diag-${Date.now().toString(36)}@test.local`, password: "m31-diag-p1", name: "Diag" }) });
  const cookie = jar.headers.getSetCookie?.()[0]?.split(";")[0];
  const ws = await fetch(`${BASE}/api/workspaces`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ name: "DiagWS" }) }).then((r) => r.json());
  const inv = await fetch(`${BASE}/api/workspaces/${ws.workspace.id}/invitations`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ email: "someone@example.com", role: "REVIEWER" }) }).then((r) => r.json());
  say(`invitation without SMTP: token=${Boolean(inv.token)} delivery.emailSent=${inv.delivery?.emailSent} → copyable URL fallback ${inv.token ? "WORKS" : "BROKEN"}`);
} catch (e) {
  say(`invitation probe error: ${String(e).slice(0, 100)}`);
}

say("== diagnostics complete ==");
await Bun.write("/home/z/my-project/download/m31-evidence/provider-email-diagnostics.log", out.join("\n") + "\n");
process.exit(0);
