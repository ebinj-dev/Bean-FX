#!/usr/bin/env node
/**
 * M47.2-B — COMPLETE dependency-instance audit generator.
 *
 * Rewrites the M47.1 generator, which skipped nested `node_modules` lockfile
 * entries and therefore under-counted the installed dependency set (537
 * components vs 995 lockfile entries; 40 nested production entries, 39 of
 * which carry versions DIFFERENT from their top-level counterpart).
 *
 * Model (documented in the outputs):
 *   - lockfile ENTRY   = one `node_modules/...` path in package-lock.json
 *   - INSTANCE         = one entry, production (!dev) or development (dev)
 *   - UNIQUE PACKAGE   = distinct name — instances may repeat it
 *   - DISTINCT VERSION = distinct name@version — never collapsed
 *
 * Every instance carries: name, exact version, resolved source, integrity
 * metadata, direct/transitive/nested classification, license + evidence
 * source. License evidence precedence:
 *   1. installed top-level copy (LICENSE file read here);
 *   2. npm registry metadata for the exact name@version (npm view);
 *   3. UNRESOLVED — labeled explicitly, never guessed.
 *
 * Outputs: docs/legal/generated/dependency-audit.json, THIRD_PARTY_NOTICES.md,
 * docs/legal/OPEN_SOURCE_INVENTORY.md, docs/legal/sbom.cdx.json (CycloneDX
 * 1.5, one component per instance, unique bom-refs), docs/legal/
 * LICENSE_RISK_REPORT.md, docs/legal/licenses/<pkg>.txt.
 * Run: node scripts/generate-open-source-audit.mjs [--skip-registry]
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const LEGAL = path.join(ROOT, "docs/legal");
const LICENSES_DIR = path.join(LEGAL, "licenses");
const GENERATED_DIR = path.join(LEGAL, "generated");
for (const d of [LEGAL, LICENSES_DIR, GENERATED_DIR]) fs.mkdirSync(d, { recursive: true });
const SKIP_REGISTRY = process.argv.includes("--skip-registry");

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
const directDeps = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
const prodDirect = new Set(Object.keys(pkg.dependencies ?? {}));

const entries = Object.entries(lock.packages ?? {}).filter(([k]) => k.startsWith("node_modules/"));

// ── local license evidence (top-level installed copies) ─────────────────────
const localEvidence = new Map(); // name@version → { license, text }
const nmRoot = path.join(ROOT, "node_modules");
if (fs.existsSync(nmRoot)) {
  for (const dir of fs.readdirSync(nmRoot)) {
    if (dir.startsWith(".")) continue;
    const scopeRoot = path.join(nmRoot, dir);
    const names = dir.startsWith("@") ? fs.readdirSync(scopeRoot).map((n) => `${dir}/${n}`) : [dir];
    for (const name of names) {
      const pdir = path.join(nmRoot, name);
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(pdir, "package.json"), "utf8")); } catch { continue; }
      const key = `${name}@${meta.version ?? "?"}`;
      if (localEvidence.has(key)) continue;
      let license = meta.license ?? null;
      let text = null;
      const files = fs.readdirSync(pdir);
      const order = [/^licen[cs]e(\.txt|\.md)?$/i, /^readme(\.txt|\.md)?$/i];
      const found = order.flatMap((re) => files.filter((f) => re.test(f)));
      for (const f of found) {
        const raw = fs.readFileSync(path.join(pdir, f), "utf8");
        if (/^readme/i.test(f)) {
          const m = raw.match(/##\s*License[\s\S]{0,1200}/i) ?? raw.match(/License\s*\n[-=\s]{3,}[\s\S]{0,600}/i) ?? raw.match(/\bMIT license\b[\s\S]{0,200}/i);
          text = m ? m[0].slice(0, 1200) : null;
        } else {
          text = raw.slice(0, 20000);
        }
        if (text) break;
      }
      if (!license && text && /\bMIT license\b|\bMIT License\b/i.test(text)) {
        license = "MIT (declared in package README; package.json omits the field)";
      }
      localEvidence.set(key, { license, text });
    }
  }
}

// ── registry evidence for instances with no local copy (nested versions) ────
const registryCache = new Map(); // name@version → license | null
function registryLicense(name, version) {
  const key = `${name}@${version}`;
  if (registryCache.has(key)) return registryCache.get(key);
  let license = null;
  try {
    const out = execFileSync("npm", ["view", `${name}@${version}`, "license", "--json"], { encoding: "utf8", timeout: 30000 });
    const v = JSON.parse(out);
    license = typeof v === "string" ? v : null;
  } catch {
    license = null;
  }
  registryCache.set(key, license);
  return license;
}

// ── classification (string-based; never guessed) ────────────────────────────
const PERMISSIVE = /\bMIT\b|ISC|Apache-2\.0|BSD-\d-Clause|0BSD|Zlib|CC0-1\.0|CC-BY-4\.0|Unlicense|WTFPL|BlueOak-1\.0\.0|Artistic-2\.0|Python-2\.0|CC-BY-3\.0|ODC-By-1\.0|X11/;
const COPYLEFT_WEAK = /LGPL|MPL-2\.0|MPL-1|EPL-2\.0|CDDL/;
const COPYLEFT_STRONG = /(?<![A-Za-z])GPL(-[23](\.0)?)?\b|AGPL/;
const NON_LICENSE = /UNLICENSED|SEE LICENSE IN|Sustainable Use|Commercial|Proprietary/i;
function classify(license) {
  if (!license) return "UNKNOWN";
  const s = Array.isArray(license) ? license.join(" OR ") : String(license);
  if (NON_LICENSE.test(s)) return "NON-STANDARD";
  if (COPYLEFT_WEAK.test(s)) return "COPYLEFT-WEAK";
  if (COPYLEFT_STRONG.test(s)) return "COPYLEFT-STRONG";
  if (PERMISSIVE.test(s)) return "PERMISSIVE";
  return "NON-STANDARD";
}

// ── system components, fonts, optional integrations (assessed separately) ───
const SYSTEM_ITEMS = [
  { name: "FFmpeg (Debian build)", version: "7.1.5 (system binary)", license: "LGPL-2.1+ with GPL-enabled components (libx264)", classification: "COPYLEFT-STRONG", kind: "system-binary", note: "Debian build enabled GPL components (--enable-gpl --enable-libx264). Server-side use over user-owned media; bundling/redistributing this build triggers GPL obligations. Technical detection here is NOT legal clearance." },
  { name: "Noto Sans (font)", version: "unmodified upstream build", license: "OFL-1.1", classification: "PERMISSIVE", kind: "font", note: "Bundled for canvas preview + FFmpeg drawtext; OFL permits redistribution with the license included." },
  { name: "Noto Sans Tamil (font)", version: "unmodified upstream build", license: "OFL-1.1", classification: "PERMISSIVE", kind: "font", note: "Required for Tamil caption rendering; same OFL terms." },
  { name: "Geist / Geist Mono (next/font/google)", version: "build-time fetch", license: "OFL-1.1", classification: "PERMISSIVE", kind: "font", note: "Loaded by next/font at build time (Vercel Geist, OFL)." },
  { name: "System Python 3 (runtime)", version: "system", license: "PSF-2.0 (interpreter)", classification: "PERMISSIVE", kind: "system-binary", note: "Invoked isolated (-I) with inline standard-library scripts; NO third-party Python packages are bundled." },
  { name: "z-ai gateway SDK", version: "environment-provided", license: "UNASSESSED (provider terms)", classification: "NON-STANDARD", kind: "optional-integration", note: "Loaded at runtime when the deployment provides it; NOT a package of this lockfile; excluded from redistribution claims." },
];

// ── instance enumeration ─────────────────────────────────────────────────────
const instances = [];
const devInstances = [];
const needsRegistry = new Map();
for (const [keyPath, meta] of entries) {
  const name = keyPath.slice("node_modules/".length).split("node_modules/").pop();
  const version = meta.version ?? "unknown";
  const isNested = keyPath.split("node_modules/").length > 2;
  const isDev = meta.dev === true;
  const local = localEvidence.get(`${name}@${version}`);
  const inst = {
    name,
    version,
    lockfilePath: keyPath,
    nesting: isNested ? "nested" : "top-level",
    environment: isDev ? "development" : "production",
    optional: meta.optional === true,
    platform: meta.os || meta.cpu ? `${(meta.os ?? []).join("|") || "any"}/${(meta.cpu ?? []).join("|") || "any"}` : null,
    scope: !isDev && prodDirect.has(name) && !isNested ? "direct" : isDev ? "dev" : "transitive",
    resolved: meta.resolved ?? null,
    integrity: meta.integrity ?? null,
    license: local?.license ?? null,
    licenseSource: local ? "installed-package" : null,
    licenseTextFound: Boolean(local?.text),
    classification: null,
    bomRef: `inst:${keyPath}`,
    purl: `pkg:npm/${name.replace("/", "%2f")}@${version}`,
  };
  if (!inst.license && !SKIP_REGISTRY) needsRegistry.set(`${name}@${version}`, { name, version });
  if (isDev) devInstances.push(inst); else instances.push(inst);
}

// Registry lookups (only for instances without local evidence).
if (needsRegistry.size > 0) {
  console.log(`Registry license lookups for ${needsRegistry.size} package@version pair(s) without a local copy…`);
  for (const [key, { name, version }] of needsRegistry) {
    const license = registryLicense(name, version);
    if (license) {
      for (const inst of [...instances, ...devInstances]) {
        if (inst.name === name && inst.version === version && !inst.license) {
          inst.license = license;
          inst.licenseSource = "npm-registry";
        }
      }
    }
  }
}
for (const inst of [...instances, ...devInstances]) {
  inst.classification = inst.license ? classify(inst.license) : "UNKNOWN";
  if (!inst.license) inst.licenseSource = inst.licenseSource ?? (SKIP_REGISTRY ? "skipped-registry" : "unresolved");
}

// License copies for direct PRODUCTION dependencies (redistribution-ready texts).
for (const name of prodDirect) {
  const topKey = [...localEvidence.keys()].find((k) => k.startsWith(`${name}@`));
  const ev = topKey ? localEvidence.get(topKey) : null;
  if (ev?.text) fs.writeFileSync(path.join(LICENSES_DIR, `${name.replace("/", "__")}.txt`), ev.text);
}

const uniqueNames = new Set(instances.map((i) => i.name));
const uniqueVersions = new Set(instances.map((i) => `${i.name}@${i.version}`));
const nestedInstances = instances.filter((i) => i.nesting === "nested");
// INSTANCE count (not collapsed): nested occurrences whose version differs
// from their top-level counterpart — or that have no top-level copy at all.
const nestedDifferingInstances = nestedInstances.filter((i) => {
  const top = instances.find((x) => x.name === i.name && x.nesting === "top-level");
  return top ? top.version !== i.version : true;
});
// M47.2-B — declared-but-uninstalled dependencies: package.json entries with
// NO lockfile entry at all (breaks `npm ci` reproducibility). Flagged, never
// silently dropped.
const declaredNotInLockfile = [...prodDirect].filter((name) => !entries.some(([k]) => k === `node_modules/${name}`));

const audit = {
  generatedAt: new Date().toISOString(),
  source: { packageJson: "package.json", lockfile: "package-lock.json", installedTopLevel: "node_modules package metadata", registry: SKIP_REGISTRY ? "skipped" : "npm view (exact name@version)" },
  model: {
    lockfileEntry: "one node_modules/** path in package-lock.json",
    instance: "one entry; production (!dev) or development (dev)",
    uniquePackage: "distinct name",
    distinctVersion: "distinct name@version — never collapsed",
  },
  counts: {
    lockfileEntries: entries.length,
    productionInstances: instances.length,
    developmentInstances: devInstances.length,
    uniqueProductionPackageNames: uniqueNames.size,
    uniqueProductionVersions: uniqueVersions.size,
    nestedProductionInstances: nestedInstances.length,
    nestedVersionInstancesDifferingFromTopLevel: nestedDifferingInstances.length,
    declaredButNotInLockfile: declaredNotInLockfile,
    byClassification: instances.reduce((acc, i) => ((acc[i.classification] = (acc[i.classification] ?? 0) + 1), acc), {}),
    devByClassification: devInstances.reduce((acc, i) => ((acc[i.classification] = (acc[i.classification] ?? 0) + 1), acc), {}),
    unverifiedLicenseInstances: instances.filter((i) => !i.license).length,
  },
  npmPackages: instances,
  devPackages: devInstances,
  systemAndFonts: SYSTEM_ITEMS,
};
fs.writeFileSync(path.join(GENERATED_DIR, "dependency-audit.json"), JSON.stringify(audit, null, 2));

// ── CycloneDX 1.5 SBOM — one component per INSTANCE, unique bom-refs ────────
const toComponent = (i) => ({
  type: "library",
  "bom-ref": i.bomRef,
  name: i.name,
  version: i.version,
  scope: i.environment === "development" ? "excluded" : i.optional ? "optional" : "required",
  licenses: i.license ? [{ license: { name: String(i.license) } }] : [],
  purl: i.purl,
  externalReferences: i.resolved ? [{ type: "distribution", url: i.resolved }] : [],
  properties: [
    { name: "beanfx:lockfile-path", value: i.lockfilePath },
    { name: "beanfx:nesting", value: i.nesting },
    { name: "beanfx:license-evidence", value: i.licenseSource ?? "unresolved" },
    ...(i.integrity ? [{ name: "beanfx:integrity", value: i.integrity }] : []),
    ...(i.platform ? [{ name: "beanfx:platform", value: i.platform }] : []),
  ],
});
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: { type: "application", name: "bean-fx", version: pkg.version ?? "0.4.0" },
    tools: [{ vendor: "BEAN FX", name: "generate-open-source-audit.mjs", version: "2.0.0" }],
  },
  components: [...instances, ...devInstances].map(toComponent),
};
fs.writeFileSync(path.join(LEGAL, "sbom.cdx.json"), JSON.stringify(sbom, null, 2));

// ── THIRD_PARTY_NOTICES.md ──────────────────────────────────────────────────
const notice = [];
notice.push(`# THIRD-PARTY NOTICES — BEAN FX`);
notice.push("");
notice.push(`Generated ${new Date().toISOString().slice(0, 10)} from \`package.json\` + \`package-lock.json\` + installed package metadata + npm registry metadata. The audit enumerates **instances** (lockfile install paths), not collapsed package names: ${audit.counts.lockfileEntries} lockfile entries = ${audit.counts.productionInstances} production instances + ${audit.counts.developmentInstances} development instances; ${audit.counts.uniqueProductionPackageNames} unique package names; ${audit.counts.nestedProductionInstances} nested production instances (of which ${audit.counts.nestedVersionInstancesDifferingFromTopLevel} carry versions differing from their top-level counterpart). Full inventory: \`docs/legal/OPEN_SOURCE_INVENTORY.md\`. SBOM: \`docs/legal/sbom.cdx.json\`.`);
notice.push("");
notice.push(`> Required attributions and license notices for third-party material. Not legal advice: technical license DETECTION below is not legal CLEARANCE. License texts for direct production dependencies ship in \`docs/legal/licenses/\`.`);
notice.push("");
notice.push(`## System components, fonts and optional integrations`);
notice.push("");
for (const s of SYSTEM_ITEMS) notice.push(`- **${s.name}** (${s.version}) — ${s.license}. ${s.note}`);
notice.push("");
notice.push(`## npm instances — per license classification (production)`);
for (const cls of ["PERMISSIVE", "COPYLEFT-WEAK", "COPYLEFT-STRONG", "NON-STANDARD", "UNKNOWN"]) {
  const list = instances.filter((e) => e.classification === cls);
  if (list.length === 0) continue;
  notice.push("");
  notice.push(`### ${cls} (${list.length} instances)`);
  notice.push("");
  const seen = new Map();
  for (const e of list) {
    const k = `${e.name}@${e.version}|${e.license ?? ""}`;
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(e.lockfilePath);
  }
  for (const [k, paths] of seen) {
    const nv = k.split("|")[0];
    const lic = k.split("|")[1];
    const name = nv.slice(0, nv.lastIndexOf("@"));
    const ver = nv.slice(nv.lastIndexOf("@") + 1);
    notice.push(`- **${name}** ${ver} — ${lic || "LICENSE NOT ESTABLISHED"}${prodDirect.has(name) ? " _(direct dependency)_" : ""} — ${paths.length} install path(s)${paths.length <= 2 ? `: ${paths.join(", ")}` : ""}`);
  }
}
notice.push("");
notice.push(`## Development-only instances`);
notice.push("");
notice.push(`${audit.counts.developmentInstances} development instances (dev-only tooling) are enumerated in the audit JSON and SBOM (scope \`excluded\`) but are NOT shipped in this notices file; they are excluded from distribution claims. Classification: ${Object.entries(audit.counts.devByClassification).map(([k, v]) => `${k}=${v}`).join(", ")}.`);
fs.writeFileSync(path.join(ROOT, "THIRD_PARTY_NOTICES.md"), notice.join("\n") + "\n");

// ── OPEN_SOURCE_INVENTORY.md ────────────────────────────────────────────────
const inv = [];
inv.push(`# OPEN SOURCE INVENTORY — BEAN FX`);
inv.push("");
inv.push(`Audit of the dependencies ACTUALLY INSTALLED by this repository's lockfile — every install path (instance), not just convenient top-level packages. Generated ${new Date().toISOString()} by \`scripts/generate-open-source-audit.mjs\`. Regenerate after dependency changes. Classification rules: never guessed — an instance whose license cannot be confidently established is labeled UNRESOLVED and excluded from commercial distribution until resolved.`);
inv.push("");
inv.push(`## Model — entries vs instances vs unique packages`);
inv.push("");
inv.push(`| Measure | Count |`);
inv.push(`|---|---|`);
inv.push(`| Lockfile entries (node_modules/** paths) | ${audit.counts.lockfileEntries} |`);
inv.push(`| Production instances (installed for the product) | ${audit.counts.productionInstances} |`);
inv.push(`| Development-only instances (dev tooling, scope \`excluded\`) | ${audit.counts.developmentInstances} |`);
inv.push(`| Unique production package NAMES | ${audit.counts.uniqueProductionPackageNames} |`);
inv.push(`| Unique production name@version pairs | ${audit.counts.uniqueProductionVersions} |`);
inv.push(`| Nested production instances | ${audit.counts.nestedProductionInstances} |`);
inv.push(`| Nested instances whose version differs from the top-level copy | ${audit.counts.nestedVersionInstancesDifferingFromTopLevel} |`);
inv.push(`| Instances with UNRESOLVED license evidence | ${audit.counts.unverifiedLicenseInstances} |`);
inv.push("");
inv.push(`Why these differ: npm's lockfile records one entry per INSTALL PATH. A package can be installed several times at different versions under different parents (e.g. \`react-is@17.0.2\` nested under @codesandbox/sandpack-react while the top level carries 18.3.1). A complete inventory must describe the instances actually installed — collapsing by name would hide version conflicts that matter for licenses and security.`);
inv.push("");
inv.push(`## 1. Integrated dependencies — production instances`);
inv.push("");
inv.push(`| Instance (name@version) | Install path | Scope | License | Evidence | Classification |`);
inv.push(`|---|---|---|---|---|---|`);
for (const e of instances) {
  inv.push(`| ${e.name}@${e.version} | ${e.lockfilePath} | ${e.scope}${e.optional ? " (optional)" : ""} | ${e.license ?? "UNRESOLVED"} | ${e.licenseSource ?? "none"} | ${e.classification} |`);
}
inv.push("");
inv.push(`## 2. Development-only instances (not shipped, enumerated for completeness)`);
inv.push("");
inv.push(`${audit.counts.developmentInstances} instances — full list in \`docs/legal/generated/dependency-audit.json\` (\`devPackages\`) and the SBOM (scope \`excluded\`). Classification: ${Object.entries(audit.counts.devByClassification).map(([k, v]) => `${k}=${v}`).join(", ")}.`);
inv.push("");
inv.push(`## 3. Adapted external code`);
inv.push("");
inv.push(`- **shadcn/ui component primitives** — files under \`src/components/ui/*\` are adapted from shadcn/ui (MIT), built on Radix UI primitives (npm instances above).`);
inv.push(`- Small well-known community patterns are re-implemented in-repo; no verbatim third-party file is copied without attribution.`);
inv.push("");
inv.push(`## 4. Optional integrations`);
inv.push("");
inv.push(`- **z-ai gateway SDK** — environment-provided SDK for LLM/ASR/TTS when the deployment supplies it. Not a package of this lockfile; its terms are the provider's; excluded from redistribution claims. Absent → capabilities disclosed, never faked.`);
inv.push(`- **Local transcription engines** (e.g. faster-whisper) — registered NOT-ready unless explicitly enabled; licenses assessed before enabling. No silent engine downloads.`);
inv.push("");
inv.push(`## 5. Reference-only projects`);
inv.push("");
inv.push(`- Research repositories studied during milestones (\`docs/OPEN_SOURCE_VIDEO_AI_RESEARCH.md\`) are reference-only: no code copied, NOT integrated dependencies.`);
inv.push("");
inv.push(`## 6. Open-source learning resources`);
inv.push("");
inv.push(`- FFmpeg documentation, MDN Web Docs, WAI-ARIA Authoring Practices, Next.js/Prisma/Radix/CodeMirror docs — documentation, not dependencies.`);
inv.push("");
inv.push(`## 7. AI coding assistant guidance`);
inv.push("");
inv.push(`- Users may explore this public repository — and any public open-source repository — and use their preferred AI coding assistant (including Claude and other independent providers), subject to each provider's own terms.`);
inv.push(`- BEAN FX does **not** provide unlimited free AI assistant subscriptions. AI provider pricing is separate.`);
inv.push(`- Public source availability does not remove copyright. Repository licenses govern code reuse.`);
inv.push(`- AI-generated modifications do not remove upstream obligations (attribution, license texts, copyleft terms).`);
inv.push(`- Not every coding assistant is free — check each provider's terms.`);
inv.push("");
inv.push(`## 8. Third-party licenses and notices`);
inv.push("");
inv.push(`- Full license copies for direct production dependencies: \`docs/legal/licenses/\`.`);
inv.push(`- Required notices: \`THIRD_PARTY_NOTICES.md\` (repository root).`);
inv.push(`- SBOM (CycloneDX 1.5, one component per instance, unique bom-refs): \`docs/legal/sbom.cdx.json\`; machine-readable audit: \`docs/legal/generated/dependency-audit.json\`.`);
inv.push(`- Risk assessment: \`docs/legal/LICENSE_RISK_REPORT.md\`.`);
fs.writeFileSync(path.join(LEGAL, "OPEN_SOURCE_INVENTORY.md"), inv.join("\n") + "\n");

// ── LICENSE_RISK_REPORT.md ──────────────────────────────────────────────────
const risky = instances.filter((e) => e.classification !== "PERMISSIVE");
const risk = [];
risk.push(`# LICENSE RISK REPORT — BEAN FX`);
risk.push("");
risk.push(`Generated ${new Date().toISOString()}. Engineering assessment of the complete instance inventory — technical detection is NOT legal clearance. Not legal advice. Items marked RESOLVE require owner/legal review before commercial distribution.`);
risk.push("");
risk.push(`## Summary`);
risk.push("");
risk.push(`- ${audit.counts.lockfileEntries} lockfile entries → ${audit.counts.productionInstances} production / ${audit.counts.developmentInstances} development instances (${audit.counts.uniqueProductionPackageNames} unique names, ${audit.counts.uniqueProductionVersions} unique versions).`);
risk.push(`- Production classification: ${Object.entries(audit.counts.byClassification).map(([k, v]) => `${k}=${v}`).join(", ")}`);
risk.push(`- Nested production instances: ${audit.counts.nestedProductionInstances} (${audit.counts.nestedVersionInstancesDifferingFromTopLevel} at versions differing from the top-level copy — evaluated as their OWN instances).`);
risk.push(`- Unresolved license evidence: ${audit.counts.unverifiedLicenseInstances} instance(s) — EXCLUDED from commercial distribution until evaluated.`);
risk.push(`- System/fonts: FFmpeg GPL-enabled build (below), Noto + Geist fonts (OFL-1.1), system Python (PSF-2.0), gateway SDK (provider terms).`);
risk.push("");
risk.push(`## Items requiring attention`);
risk.push("");
risk.push(`### 1. FFmpeg system build — GPL components (COPYLEFT-STRONG)`);
risk.push("");
risk.push(`FFmpeg 7.1.5 Debian build reports \`--enable-gpl\` + \`--enable-libx264\`. Server-side operation over users' own media is generally not "distribution" of the program; shipping this build inside a distributed BEAN FX product would trigger GPL-2.0 obligations (and x264's GPL terms). Open questions for legal review: the exact build configuration in production, the distribution model (SaaS vs bundled), and any bundled-encoder policy. **Status: RESOLVE before product distribution.**`);
risk.push("");
risk.push(`### 2. @codesandbox/nodebox — Sustainable Use License (transitive chain)`);
risk.push("");
risk.push(`Chain: \`@mdxeditor/editor\` → \`@codesandbox/sandpack-react\` (Apache-2.0) → \`@codesandbox/sandpack-client\` (Apache-2.0) → \`@codesandbox/nodebox\` ("Sustainable Use License" — restricts paid/commercial use of the licensed work). BEAN FX does not call nodebox directly; it is an installed transitive instance. Open questions: whether the MDX editor surface that pulls sandpack ships in the commercial product, and whether a paid-use arrangement or removal is required. **Status: EXCLUDED from commercial distribution until resolved.**`);
risk.push("");
risk.push(`### 3. Declared dependencies missing from the lockfile (install-state integrity)`);
risk.push("");
if (declaredNotInLockfile.length === 0) {
  risk.push(`None — every \`package.json\` dependency has lockfile entries. \`npm ci\` reproducibility is intact.`);
} else {
  risk.push(`The following \`package.json\` dependencies have NO lockfile entry (not installed by the last install run). \`npm ci\` fails on this mismatch and a clean install would resolve them to whatever version satisfies the range at install time — non-reproducible:`);
  risk.push("");
  for (const name of declaredNotInLockfile) risk.push(`- **${name}** (${(pkg.dependencies ?? {})[name] ?? (pkg.devDependencies ?? {})[name]})`);
  risk.push("");
  risk.push(`**Status: RESOLVE — run a full \`npm install\` to regenerate the lockfile (review the diff), or remove the declaration if the dependency is unused. Do not clear this flag by editing package.json alone.**`);
}
risk.push("");
risk.push(`### 4. z-ai gateway SDK (environment-provided)`);
risk.push("");
risk.push(`Not in the lockfile; loaded at runtime when the deployment provides it. Provider terms NOT assessed here. **Status: EXCLUDED from redistribution claims — deployment dependency.**`);
risk.push("");
risk.push(`### 5. npm instances not classified PERMISSIVE (production)`);
risk.push("");
if (risky.length === 0) {
  risk.push(`None — every production instance has established permissive-license evidence.`);
} else {
  risk.push(`| Instance | Install path | License (evidence) | Classification | Action |`);
  risk.push(`|---|---|---|---|---|`);
  for (const e of risky) {
    const action = e.classification === "COPYLEFT-STRONG" ? "RESOLVE — copyleft review before distribution"
      : e.classification === "COPYLEFT-WEAK" ? "NOTICE — include license text if redistributed"
        : e.classification === "NON-STANDARD" ? "RESOLVE — non-standard or restricted license"
          : "RESOLVE — no license evidence; inspect upstream";
    risk.push(`| ${e.name}@${e.version} | ${e.lockfilePath} | ${e.license ?? "UNRESOLVED"} (${e.licenseSource ?? "none"}) | ${e.classification} | ${action} |`);
  }
}
risk.push("");
risk.push(`### 6. Fonts (OFL-1.1)`);
risk.push("");
risk.push(`Noto Sans, Noto Sans Tamil (bundled) and Geist/Geist Mono (build-time) are SIL OFL-1.1. OFL permits commercial use and redistribution when the license accompanies the fonts and reserved font names are respected. **Status: OK — keep the OFL text with any font redistribution.**`);
risk.push("");
risk.push(`## Explicitly excluded from commercial distribution until resolved`);
risk.push("");
risk.push(`- Every instance classified UNKNOWN / NON-STANDARD above (including the nodebox chain).`);
risk.push(`- The GPL-enabled FFmpeg build if BEAN FX is distributed as a bundled product.`);
risk.push(`- The gateway SDK (provider terms apply; not redistributed by this repository).`);
fs.writeFileSync(path.join(LEGAL, "LICENSE_RISK_REPORT.md"), risk.join("\n") + "\n");

console.log(`AUDIT DONE: ${audit.counts.lockfileEntries} lockfile entries → ${audit.counts.productionInstances} production instances (${audit.counts.uniqueProductionPackageNames} unique names, ${audit.counts.nestedProductionInstances} nested), ${audit.counts.developmentInstances} dev instances.`);
console.log(`Classification (production):`, audit.counts.byClassification);
console.log(`Unresolved license evidence: ${audit.counts.unverifiedLicenseInstances}`);
console.log(`SBOM components: ${sbom.components.length}`);
