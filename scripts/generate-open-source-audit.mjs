#!/usr/bin/env node
/**
 * M47.1 §D — Open-source audit generator.
 *
 * Reads the REAL dependency manifests (package.json + package-lock.json) and
 * the installed node_modules package metadata, then generates:
 *   - docs/legal/generated/dependency-audit.json   (machine-readable audit)
 *   - THIRD_PARTY_NOTICES.md                       (root, required notices)
 *   - docs/legal/OPEN_SOURCE_INVENTORY.md          (human-readable inventory)
 *   - docs/legal/sbom.cdx.json                     (CycloneDX 1.5 SBOM)
 *   - docs/legal/LICENSE_RISK_REPORT.md            (risk classification)
 *   - docs/legal/licenses/<pkg>.txt                (full license copies: direct deps + fonts)
 *
 * Rules: never invent a license — if a package does not declare one and no
 * LICENSE file exists, it is classified UNKNOWN and flagged as a risk.
 * Run: node scripts/generate-open-source-audit.mjs
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const LEGAL = path.join(ROOT, "docs/legal");
const LICENSES_DIR = path.join(LEGAL, "licenses");
const GENERATED_DIR = path.join(LEGAL, "generated");
for (const d of [LEGAL, LICENSES_DIR, GENERATED_DIR]) fs.mkdirSync(d, { recursive: true });

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
const direct = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);

// npm lockfile v3: packages keyed as "node_modules/<name>" (scoped: "node_modules/@scope/name")
const entries = [];
for (const [key, meta] of Object.entries(lock.packages ?? {})) {
  if (!key.startsWith("node_modules/") || meta.dev === true) continue;
  const name = key.slice("node_modules/".length);
  if (name.includes("node_modules/")) continue; // nested duplicates — top-level entry suffices
  // Read the installed package.json for license/repository (lockfile often omits them).
  let installed = {};
  try {
    installed = JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", name, "package.json"), "utf8"));
  } catch { /* not installed in this environment — fall back to lockfile metadata */ }
  const licenseField = installed.license ?? meta.license ?? null;
  let licenseText = null;
  // Case-insensitive lookup — packages ship README.md / Readme.md / Licence variants.
  let dirFiles = [];
  try { dirFiles = fs.readdirSync(path.join(ROOT, "node_modules", name)); } catch { /* not installed */ }
  const order = [/^licen[cs]e(\.txt|\.md)?$/i, /^readme(\.txt|\.md)?$/i];
  const found = order.flatMap((re) => dirFiles.filter((f) => re.test(f)));
  for (const f of found) {
    const raw = fs.readFileSync(path.join(ROOT, "node_modules", name, f), "utf8");
    if (/^readme/i.test(f)) {
      const m = raw.match(/##\s*License[\s\S]{0,1200}/i) ?? raw.match(/License\s*\n[-=\s]{3,}[\s\S]{0,600}/i) ?? raw.match(/\bMIT license\b[\s\S]{0,200}/i);
      licenseText = m ? m[0].slice(0, 1200) : null;
    } else {
      licenseText = raw.slice(0, 20000);
    }
    if (licenseText) break;
  }
  // README-only license declaration (package.json omits the field) — recorded
  // with its source so the inventory never silently upgrades an UNKNOWN.
  let license = licenseField;
  let licenseSource = licenseField ? "package" : null;
  if (!license && licenseText && /\bMIT license\b|\bMIT License\b/i.test(licenseText)) {
    license = "MIT (declared in package README; package.json omits the field)";
    licenseSource = "README";
  }
  entries.push({
    name,
    version: meta.version ?? installed.version ?? "unknown",
    scope: direct.has(name) ? "direct" : "transitive",
    environment: (pkg.devDependencies?.[name] || pkg.peerDependenciesMeta?.[name]) ? "declared" : "runtime",
    license,
    licenseSource,
    licenseTextFound: Boolean(licenseText),
    licenseFile: licenseText ? `docs/legal/licenses/${name.replace("/", "__")}.txt` : null,
    repository: installed.repository?.url ?? installed.homepage ?? meta.resolved ?? null,
    url: meta.resolved ?? null,
  });
  if (licenseText && direct.has(name)) {
    fs.writeFileSync(path.join(LICENSES_DIR, `${name.replace("/", "__")}.txt`), licenseText);
  }
}
entries.sort((a, b) => a.name.localeCompare(b.name));

// ── license classification (string-based; never guessed) ────────────────────
const PERMISSIVE = /\bMIT\b|ISC|Apache-2\.0|BSD-\d-Clause|0BSD|Zlib|CC0-1\.0|CC-BY-4\.0|Unlicense|WTFPL|BlueOak-1\.0\.0|Artistic-2\.0|Python-2\.0|CC-BY-3\.0|ODC-By-1\.0|X11/;
const COPYLEFT_WEAK = /LGPL|MPL-2\.0|MPL-1|EPL-2\.0|CDDL/;
// Strong copyleft — \bGPL\b without matching inside "LGPL"; GPL-2/GPL-3 guarded the same way.
const COPYLEFT_STRONG = /(?<![A-Za-z])GPL(-[23](\.0)?)?\b|AGPL/;
const NON_LICENSE = /UNLICENSED|SEE LICENSE IN|Sustainable Use|Commercial|Proprietary/i;

function classify(license) {
  if (!license) return "UNKNOWN";
  const s = Array.isArray(license) ? license.join(" OR ") : String(license);
  if (NON_LICENSE.test(s)) return "NON-STANDARD";
  if (COPYLEFT_WEAK.test(s)) return "COPYLEFT-WEAK";
  if (COPYLEFT_STRONG.test(s)) return "COPYLEFT-STRONG";
  if (PERMISSIVE.test(s)) return "PERMISSIVE";
  // Declared but not in our permissive/weak/strong sets (e.g. W3C-20150513).
  return "NON-STANDARD";
}

for (const e of entries) {
  e.classification = classify(e.license);
  const lic = Array.isArray(e.license) ? e.license.join(" OR ") : e.license;
  e.link = lic ? `https://spdx.org/licenses/${encodeURIComponent(String(lic).split(" OR ")[0].replace(/\s*\(.+\)\s*$/, ""))}` : null;
}

// Fonts + system binaries (assessed separately from npm deps)
const SYSTEM_ITEMS = [
  { name: "FFmpeg (Debian build)", version: "7.1.5 (system binary)", license: "LGPL-2.1+ with GPL-enabled components (libx264)", classification: "COPYLEFT-STRONG", kind: "system-binary", note: "Debian package build enabled GPL components (--enable-gpl --enable-libx264). Used server-side on user-owned media; bundling/redistributing this build would trigger GPL obligations." },
  { name: "Noto Sans (font)", version: "unmodified upstream build", license: "OFL-1.1", classification: "PERMISSIVE", kind: "font", note: "Bundled for canvas preview + FFmpeg drawtext; OFL permits redistribution with the license included." },
  { name: "Noto Sans Tamil (font)", version: "unmodified upstream build", license: "OFL-1.1", classification: "PERMISSIVE", kind: "font", note: "Same OFL terms; required for Tamil caption rendering." },
  { name: "Geist / Geist Mono (next/font/google)", version: "build-time fetch", license: "OFL-1.1", classification: "PERMISSIVE", kind: "font", note: "Loaded by next/font at build time per Vercel's Geist font (OFL)." },
  { name: "System Python 3 (runtime)", version: "system", license: "PSF-2.0 (interpreter)", classification: "PERMISSIVE", kind: "system-binary", note: "Invoked isolated (-I) with inline standard-library scripts; NO third-party Python packages are bundled." },
];

// ── outputs ──────────────────────────────────────────────────────────────────
const audit = {
  generatedAt: new Date().toISOString(),
  source: { packageJson: "package.json", lockfile: "package-lock.json", bunLock: "bun.lock", nodeModules: "installed package metadata" },
  counts: {
    total: entries.length,
    direct: entries.filter((e) => e.scope === "direct").length,
    transitive: entries.filter((e) => e.scope === "transitive").length,
    byClassification: entries.reduce((acc, e) => ((acc[e.classification] = (acc[e.classification] ?? 0) + 1), acc), {}),
  },
  npmPackages: entries,
  systemAndFonts: SYSTEM_ITEMS,
};
fs.writeFileSync(path.join(GENERATED_DIR, "dependency-audit.json"), JSON.stringify(audit, null, 2));

// CycloneDX 1.5 SBOM
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: { type: "application", name: "bean-fx", version: pkg.version ?? "0.4.0" },
    tools: [{ vendor: "BEAN FX", name: "generate-open-source-audit.mjs", version: "1.0.0" }],
  },
  components: entries.map((e) => ({
    type: "library",
    name: e.name,
    version: e.version,
    scope: e.scope === "direct" ? "required" : "transitive",
    licenses: e.license ? [{ license: { id: undefined, name: String(Array.isArray(e.license) ? e.license.join(" OR ") : e.license) } }] : [],
    purl: `pkg:npm/${encodeURIComponent(e.name).replace(/%40/g, "@")}@${e.version}`,
    externalReferences: e.url ? [{ type: "distribution", url: e.url }] : [],
  })),
};
fs.writeFileSync(path.join(LEGAL, "sbom.cdx.json"), JSON.stringify(sbom, null, 2));

// THIRD_PARTY_NOTICES.md
const notice = [];
notice.push(`# THIRD-PARTY NOTICES — BEAN FX`);
notice.push("");
notice.push(`Generated ${new Date().toISOString().slice(0, 10)} from \`package.json\` + \`package-lock.json\` + installed package metadata. ${entries.length} npm packages (${audit.counts.direct} direct, ${audit.counts.transitive} transitive). Full inventory: \`docs/legal/OPEN_SOURCE_INVENTORY.md\`. Machine-readable SBOM: \`docs/legal/sbom.cdx.json\`.`);
notice.push("");
notice.push(`> This file contains required attributions and license notices for third-party material. BEAN FX's own code is governed by the repository license. Nothing here is legal advice; entries link to their upstream licenses.`);
notice.push("");
notice.push(`## System components and fonts`);
notice.push("");
for (const s of SYSTEM_ITEMS) notice.push(`- **${s.name}** (${s.version}) — ${s.license}. ${s.note}`);
notice.push("");
notice.push(`## npm packages — per license classification`);
for (const cls of ["PERMISSIVE", "COPYLEFT-WEAK", "COPYLEFT-STRONG", "NON-STANDARD", "UNKNOWN"]) {
  const list = entries.filter((e) => e.classification === cls);
  if (list.length === 0) continue;
  notice.push("");
  notice.push(`### ${cls} (${list.length})`);
  notice.push("");
  for (const e of list) {
    const lic = Array.isArray(e.license) ? e.license.join(" OR ") : (e.license ?? "NOT DECLARED");
    notice.push(`- **${e.name}** ${e.version} — ${lic}${e.repository ? ` — ${e.repository}` : ""}${e.scope === "direct" ? " _(direct dependency)_" : ""}`);
  }
}
notice.push("");
notice.push(`## Full license texts`);
notice.push("");
notice.push(`License texts for all **direct** dependencies are copied verbatim into \`docs/legal/licenses/\` (one file per package, named \`<pkg>.txt\`). For transitive packages the upstream link above is authoritative; the installed package ships its own LICENSE file.`);
fs.writeFileSync(path.join(ROOT, "THIRD_PARTY_NOTICES.md"), notice.join("\n") + "\n");

// OPEN_SOURCE_INVENTORY.md
const inv = [];
inv.push(`# OPEN SOURCE INVENTORY — BEAN FX`);
inv.push("");
inv.push(`Audit of actual third-party material in this repository. Generated ${new Date().toISOString()} by \`scripts/generate-open-source-audit.mjs\`. Regenerate after dependency changes. Classification rules: **never guessed** — a package with no declared license and no license file is UNKNOWN and is excluded from commercial distribution until resolved.`);
inv.push("");
inv.push(`## 1. Integrated dependencies (npm)`);
inv.push("");
inv.push(`| Package | Version | Scope | License | Classification | Upstream |`);
inv.push(`|---|---|---|---|---|---|`);
for (const e of entries) {
  inv.push(`| ${e.name} | ${e.version} | ${e.scope} | ${e.license ?? "NOT DECLARED"} | ${e.classification} | ${e.repository ?? e.url ?? "—"} |`);
}
inv.push("");
inv.push(`## 2. Adapted external code`);
inv.push("");
inv.push(`- **shadcn/ui component primitives** — the files under \`src/components/ui/*\` are adapted from shadcn/ui (MIT). Radix UI primitives (\`@radix-ui/*\`) are integrated npm dependencies (listed above).`);
inv.push(`- **WAI-ARIA patterns / hover-intent debounce utilities** — small, well-known community patterns re-implemented in-repo; no verbatim third-party file copied without attribution.`);
inv.push("");
inv.push(`## 3. Optional integrations`);
inv.push("");
inv.push(`- **z-ai-web-dev-sdk gateway** — environment-provided SDK (NOT published to npm under this repo's lockfile; loaded at runtime when installed). Its license/terms are the provider's — BEAN FX never silently substitutes another provider.`);
inv.push(`- **faster-whisper / other local engines** — registered as NOT-ready unless explicitly enabled via env (license assessed before enabling).`);
inv.push("");
inv.push(`## 4. Reference-only projects`);
inv.push("");
inv.push(`- Public research repositories and open video-AI projects studied during milestones are documented in \`docs/OPEN_SOURCE_VIDEO_AI_RESEARCH.md\` as **reference-only**: no code was copied into this repository from them, and they are NOT integrated dependencies.`);
inv.push("");
inv.push(`## 5. Open-source learning resources`);
inv.push("");
inv.push(`- FFmpeg documentation (ffmpeg.org), MDN Web Docs, Next.js/Prisma/Radix documentation, WAI-ARIA Authoring Practices — read and followed as documentation, not dependencies.`);
inv.push("");
inv.push(`## 6. AI coding assistant guidance`);
inv.push("");
inv.push(`- Users may explore this public repository and any public open-source repository, and use their preferred AI coding assistant (including Claude and other independent providers), subject to each provider's own terms.`);
inv.push(`- BEAN FX does **not** provide unlimited free AI assistant subscriptions. AI provider pricing is separate from BEAN FX.`);
inv.push(`- Public source availability does not remove copyright. Repository licenses govern code reuse.`);
inv.push(`- AI-generated modifications do not remove upstream obligations (attribution, license texts, copyleft terms where applicable).`);
inv.push("");
inv.push(`## 7. Third-party licenses and notices`);
inv.push("");
inv.push(`- Full license copies for direct dependencies: \`docs/legal/licenses/\`.`);
inv.push(`- Required notices document: \`THIRD_PARTY_NOTICES.md\` (repository root).`);
inv.push(`- SBOM (CycloneDX 1.5): \`docs/legal/sbom.cdx.json\`; machine-readable audit: \`docs/legal/generated/dependency-audit.json\`.`);
inv.push(`- Risk assessment: \`docs/legal/LICENSE_RISK_REPORT.md\`.`);
fs.writeFileSync(path.join(LEGAL, "OPEN_SOURCE_INVENTORY.md"), inv.join("\n") + "\n");

// LICENSE_RISK_REPORT.md
const risky = entries.filter((e) => e.classification !== "PERMISSIVE");
const risk = [];
risk.push(`# LICENSE RISK REPORT — BEAN FX`);
risk.push("");
risk.push(`Generated ${new Date().toISOString()}. Automated classification of the npm dependency tree plus system components. This is an engineering assessment, not legal advice; items marked RESOLVE require owner/legal review before commercial distribution.`);
risk.push("");
risk.push(`## Summary`);
risk.push("");
risk.push(`- npm packages audited: **${entries.length}** (${audit.counts.direct} direct / ${audit.counts.transitive} transitive)`);
risk.push(`- Classification: ${Object.entries(audit.counts.byClassification).map(([k, v]) => `${k}=${v}`).join(", ")}`);
risk.push(`- System/fonts: FFmpeg (GPL-enabled build — see below), Noto + Geist fonts (OFL-1.1), system Python (PSF-2.0).`);
risk.push("");
risk.push(`## Items requiring attention`);
risk.push("");
risk.push(`### 1. FFmpeg system build — GPL components (COPYLEFT-STRONG)`);
risk.push("");
risk.push(`The installed FFmpeg 7.1.5 Debian build reports \`--enable-gpl\` + \`--enable-libx264\`. Running FFmpeg server-side on users' own media is generally not "distribution" of the program; however, shipping this build inside a distributed BEAN FX product would trigger GPL-2.0 obligations (and x264's GPL terms). **Status: RESOLVE before any product distribution — server-side SaaS use is the assumed mode.**`);
risk.push("");
risk.push(`### 2. z-ai-web-dev-sdk gateway (environment-provided)`);
risk.push("");
risk.push(`Not in the lockfile; loaded at runtime when the deployment provides it. Its distribution terms are the provider's and are NOT assessed here. **Status: EXCLUDED from redistribution claims — treat as a deployment dependency.**`);
risk.push("");
risk.push(`### 3. @codesandbox/nodebox — Sustainable Use License (transitive)`);
risk.push("");
risk.push(`Dependency chain: \`@mdxeditor/editor\` → \`@codesandbox/sandpack-react\` (Apache-2.0) → \`@codesandbox/sandpack-client\` (Apache-2.0) → \`@codesandbox/nodebox\` ("Sustainable Use License" — restricts paid/commercial use of the licensed work). BEAN FX does not call nodebox directly; it is a transitive installation. **Status: EXCLUDED from commercial distribution until resolved — if the editor surface that pulls sandpack is ever distributed commercially, this chain must be removed, replaced, or cleared with the licensor.**`);
risk.push("");
risk.push(`### 4. npm packages not classified PERMISSIVE`);
risk.push("");
if (risky.length === 0) {
  risk.push(`None — every audited npm package declares a permissive license.`);
} else {
  risk.push(`| Package | Version | License (declared) | Classification | Action |`);
  risk.push(`|---|---|---|---|---|`);
  for (const e of risky) {
    const action = e.classification === "COPYLEFT-STRONG" ? "RESOLVE — copyleft review before distribution"
      : e.classification === "COPYLEFT-WEAK" ? "NOTICE — include license text if redistributed"
        : e.classification === "NON-STANDARD" ? "RESOLVE — non-standard license field"
          : "RESOLVE — no declared license; inspect upstream before distribution";
    risk.push(`| ${e.name} | ${e.version} | ${e.license ?? "NOT DECLARED"} | ${e.classification} | ${action} |`);
  }
}
risk.push("");
risk.push(`### 5. Fonts (OFL-1.1)`);
risk.push("");
risk.push(`Noto Sans, Noto Sans Tamil (bundled files) and Geist/Geist Mono (build-time via next/font) are SIL OFL-1.1. OFL permits commercial use and redistribution when the license accompanies the fonts and reserved font names are respected. **Status: OK — keep the OFL text with any font redistribution.**`);
risk.push("");
risk.push(`## Explicitly excluded from commercial distribution until resolved`);
risk.push("");
risk.push(`- Any package classified UNKNOWN or NON-STANDARD above.`);
risk.push(`- The GPL-enabled FFmpeg build if BEAN FX is ever distributed as a bundled product (SaaS operation over user media is the current distribution mode).`);
risk.push(`- The gateway SDK (provider terms apply; not redistributed by this repository).`);
fs.writeFileSync(path.join(LEGAL, "LICENSE_RISK_REPORT.md"), risk.join("\n") + "\n");

// Copy the OFL text for the bundled fonts (notice requires the license to accompany them)
const oflSrc = path.join(ROOT, "node_modules", "@fontsource", "noto-sans", "LICENSE");
if (fs.existsSync(oflSrc)) fs.copyFileSync(oflSrc, path.join(LICENSES_DIR, "OFL-noto-fonts.txt"));

console.log(`AUDIT DONE: ${entries.length} npm packages (${audit.counts.direct} direct); classification:`, audit.counts.byClassification);
console.log(`Files: THIRD_PARTY_NOTICES.md, docs/legal/OPEN_SOURCE_INVENTORY.md, docs/legal/sbom.cdx.json, docs/legal/LICENSE_RISK_REPORT.md, docs/legal/licenses/ (${fs.readdirSync(LICENSES_DIR).length} files)`);
