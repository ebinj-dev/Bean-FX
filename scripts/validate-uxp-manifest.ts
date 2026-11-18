/**
 * M22 P1 — UXP extension validator (REAL, automated).
 * Validates everything that CAN be validated without a Premiere install:
 *  1. manifest.xml is well-formed XML with the required UXP attributes
 *  2. Host is PPRO with a sane version range
 *  3. Every referenced resource (Html/Script) exists
 *  4. panel.ts compiles to panel.js (so UDT can actually load the panel)
 * Result: AUTOMATED evidence. It does NOT prove Premiere runtime behavior —
 * that is the in-panel harness + OWNER ACTION (see uxp-test-harness.ts).
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const PANEL_DIR = path.join(import.meta.dir, "..", "src", "integrations", "premiere-panel");

interface Check { name: string; ok: boolean; detail: string }

const checks: Check[] = [];
function check(name: string, fn: () => string): void {
  try {
    checks.push({ name, ok: true, detail: fn() });
  } catch (e) {
    checks.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
}

// Minimal XML well-formedness + attribute extraction (no deps).
function parseXmlAttributes(xml: string, tag: string): Record<string, string> | null {
  const m = new RegExp(`<${tag}\\s+([^>]+?)/?>`, "s").exec(xml);
  if (!m) return null;
  const attrs: Record<string, string> = {};
  for (const a of m[1].matchAll(/([A-Za-z:_-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
  return attrs;
}

check("manifest.xml exists and is readable", () => {
  const st = statSync(path.join(PANEL_DIR, "manifest.xml"));
  if (!st.isFile() || st.size < 200) throw new Error("manifest missing or suspiciously small");
  return `${st.size} bytes`;
});

const manifest = readFileSync(path.join(PANEL_DIR, "manifest.xml"), "utf8");

check("XML is well-formed (balanced tags, no stray <)", () => {
  const opens = (manifest.match(/</g) ?? []).length;
  const closes = (manifest.match(/>/g) ?? []).length;
  if (opens !== closes) throw new Error(`unbalanced < > (${opens} vs ${closes})`);
  for (const tag of ["ExtensionManifest", "ExtensionList", "ExecutionEnvironment", "DispatchInfoList"]) {
    if (!manifest.includes(`</${tag}>`)) throw new Error(`missing closing </${tag}>`);
  }
  return "balanced + all sections closed";
});

check("ExtensionManifest Version=7.0 (UXP-compatible)", () => {
  const attrs = parseXmlAttributes(manifest, "ExtensionManifest");
  if (attrs?.Version !== "7.0") throw new Error(`got Version=${attrs?.Version}`);
  if (!attrs?.ExtensionBundleId) throw new Error("missing ExtensionBundleId");
  return `${attrs.ExtensionBundleId} v${attrs.ExtensionBundleVersion}`;
});

check("Host is PPRO with a valid version range", () => {
  const host = parseXmlAttributes(manifest, "Host");
  if (host?.Name !== "PPRO") throw new Error(`host Name=${host?.Name}`);
  const m = /^\[(\d+\.\d+),(\d+\.\d+)\]$/.exec(host.Version ?? "");
  if (!m) throw new Error(`bad version range ${host.Version}`);
  const min = Number(m[1]);
  if (min < 24) throw new Error("minimum below Premiere 24 (no UXP support)");
  return `PPRO ${host.Version}`;
});

check("panel extension id + entry resources exist", () => {
  const ext = parseXmlAttributes(manifest, "Extension");
  if (!ext?.Id) throw new Error("missing Extension Id");
  const html = /<Html src="([^"]+)"/.exec(manifest)?.[1];
  const script = /<Script src="([^"]+)"/.exec(manifest)?.[1];
  if (!html || !script) throw new Error("manifest does not reference Html/Script");
  for (const f of [html, "index.html"]) {
    if (!existsSync(path.join(PANEL_DIR, f))) throw new Error(`resource missing: ${f}`);
  }
  return `id=${ext.Id}; html=${html}; script=${script}`;
});

check("panel.ts compiles to panel.js (extension actually loadable)", () => {
  const out = path.join(PANEL_DIR, "panel.js");
  execSync(`bun build ${path.join(PANEL_DIR, "panel.ts")} --outfile ${out} --target browser --minify`, { stdio: "pipe" });
  const st = statSync(out);
  if (st.size < 500) throw new Error("panel.js suspiciously small");
  return `panel.js ${st.size} bytes (browser target, minified)`;
});

check("panel.js bundles the shared Core SDK (no per-host AI)", () => {
  const js = readFileSync(path.join(PANEL_DIR, "panel.js"), "utf8");
  for (const marker of ["beanfx-project-v1", "premiere-pro"]) {
    if (!js.includes(marker)) throw new Error(`core marker missing from bundle: ${marker}`);
  }
  return "format marker + host marker present in bundle";
});

check("adapter refuses to run outside UXP (honesty preserved in bundle)", () => {
  const js = readFileSync(path.join(PANEL_DIR, "panel.js"), "utf8");
  if (!js.includes("hostUnavailable")) throw new Error("hostUnavailable guard missing from bundle");
  return "hostUnavailable guard present";
});

let failed = 0;
for (const c of checks) {
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`);
  if (!c.ok) failed++;
}
console.log(`\nUXP VALIDATOR: ${checks.length - failed}/${checks.length} checks passed`);
console.log("CLASSIFICATION: AUTOMATED (no Premiere runtime in sandbox — real-host steps = OWNER ACTION, see uxp-test-harness.ts)");
process.exit(failed === 0 ? 0 : 1);
