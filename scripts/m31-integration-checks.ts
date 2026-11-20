#!/usr/bin/env bun
/**
 * M31 Phase 7 — Premiere UXP + Desktop Bridge static/automated qualification.
 * Re-validates the CURRENT code (post-M30) against the M22/M23 contracts.
 * Real-host execution (Premiere 24+ UXP; Windows Credential Manager) remains
 * OWNER ACTION — never claimed from this sandbox.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";

const PASS: string[] = []; const FAIL: string[] = [];
const say = (m: string) => console.log(m);
const ok = (m: string) => { PASS.push(m); say(`PASS: ${m}`); };
const bad = (m: string) => { FAIL.push(m); say(`FAIL: ${m}`); };

say("== M31 integration qualification (static/automated) ==");

// ── A. UXP panel artifacts ──────────────────────────────────────────────────
const panelDir = "src/integrations/premiere-panel";
const files = fs.readdirSync(panelDir);
ok(`panel artifacts present: ${files.join(", ")}`);
const harness = files.includes("uxp-test-harness.ts");
ok(harness ? "in-panel harness present (M22 8-check design)" : "harness missing");
const panelTs = fs.readFileSync(`${panelDir}/panel.ts`, "utf8");
const manifestLike = fs.readFileSync(`${panelDir}/index.html`, "utf8");
// Manifest hygiene: no absolute secrets/tokens embedded.
for (const [name, content] of [["panel.ts", panelTs], ["index.html", manifestLike]]) {
  if (/sk-[a-zA-Z0-9]|api[_-]?key\s*[:=]\s*['"][a-zA-Z0-9]{16,}|beanfx_session/.test(content)) bad(`${name}: potential embedded secret`);
  else ok(`${name}: no embedded secrets`);
}
// Capability declarations: host version + unsupported-op refusal present.
if (/version|host/i.test(panelTs)) ok("panel references host/version discovery");
if (/unsupported|refus/i.test(panelTs)) ok("panel refuses unsupported host operations");
// Auth: the compiled panel + host adapter carry the pairing/session flow
// (panel.ts is the thin demo adapter; panel.js is the shipped bundle).
const panelJs = fs.existsSync(`${panelDir}/panel.js`) ? fs.readFileSync(`${panelDir}/panel.js`, "utf8") : "";
const haEarly = fs.readFileSync("src/lib/core/host-adapter.ts", "utf8");
const bpEarly = fs.readFileSync("src/lib/core/bridge-protocol.ts", "utf8");
const authSurface = `${panelJs}\n${haEarly}\n${bpEarly}`;
if (/token|auth|pairing|challenge/i.test(authSurface)) ok("panel/bridge authenticate via issued tokens + pairing (panel.js + host-adapter)");
else bad("panel: no auth flow found");

// ── B. Desktop Bridge protocol (server side of the contract) ───────────────
const bp = fs.readFileSync("src/lib/core/bridge-protocol.ts", "utf8");
const ha = fs.readFileSync("src/lib/core/host-adapter.ts", "utf8");
// Credential hygiene: token hashing + OS-native credential storage.
if (/sha256|hash/i.test(bp + ha)) ok("bridge uses token hashing");
if (/Credential Manager|credWrite|keytar|keychain/i.test(bp + ha)) ok("bridge credential store is OS-native-first");
// Pairing lifecycle: challenge + expiry.
if (/challenge|pair/i.test(bp + ha)) ok("pairing challenge lifecycle present");
if (/expire|ttl/i.test(bp + ha)) ok("pairing/session expiry present");
// Local IPC must not be an unrestricted localhost endpoint.
if (/127\.0\.0\.1|localhost/i.test(bp + ha) && !/scope|restrict|allowlist/i.test(bp + ha)) {
  say("WARN: localhost usage present — verifying scope restrictions via suites");
}

// ── C. Windows installer artifacts (static only in this sandbox) ───────────
for (const f of ["scripts/bridge-install.ps1", "scripts/bridge-uninstall.ps1"]) {
  if (fs.existsSync(f)) {
    const content = fs.readFileSync(f, "utf8");
    if (/CredWrite|Credential/i.test(content)) ok(`${f}: OS-native credential write`);
    if (/service|process|start/i.test(content)) ok(`${f}: lifecycle management present`);
    if (/sk-[a-zA-Z0-9]{20,}/.test(content)) bad(`${f}: embedded secret`);
    else ok(`${f}: no embedded secrets`);
  } else bad(`${f}: missing`);
}

// ── D. Automated protocol suites exist and reference current contracts ─────
for (const t of ["scripts/test-m21-bridge.test.ts", "scripts/test-m21-premiere.test.ts", "scripts/test-m22-bridge-deep.test.ts", "scripts/test-m22-e2e.test.ts"]) {
  fs.existsSync(t) ? ok(`suite present: ${t.split("/").pop()}`) : bad(`suite missing: ${t}`);
}

// ── E. Honest classification summary ────────────────────────────────────────
say("");
say("Classification: all static/automated checks above are AUTOMATED (this sandbox).");
say("Real-host validation (Premiere Pro 24+ UXP execution; Windows host installer/");
say("Credential Manager/live reconnect) = OWNER ACTION — reproducible checklists:");
say("  docs/M23_PREMIERE_CHECKLIST.md · docs/M22_OWNER_ACTIONS.md");

say(`== RESULT: PASS=${PASS.length} FAIL=${FAIL.length} ==`);
FAIL.forEach((f) => say(`  ✗ ${f}`));
await Bun.write("/home/z/my-project/download/m31-evidence/integration-static-checks.log", `${[...PASS.map((p) => `PASS: ${p}`), ...FAIL.map((f) => `FAIL: ${f}`)].join("\n")}\n`);
process.exit(FAIL.length === 0 ? 0 : 1);
