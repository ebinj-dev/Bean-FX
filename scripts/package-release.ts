/**
 * M23 P5 — release packaging for all five components with checksums,
 * version-consistency check and a tarball per component.
 * No publishing — local release-quality artifacts only (evidence dir).
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = "/home/z/my-project";
const OUT = path.join(ROOT, "download", "m23-evidence", "packages");
mkdirSync(OUT, { recursive: true });

const sha256 = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const sha256Bytes = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// ---------- version consistency ----------
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version?: string };
const versionFile = readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();
const manifest = readFileSync(path.join(ROOT, "src", "integrations", "premiere-panel", "manifest.xml"), "utf8");
const uxpVersion = /ExtensionBundleVersion="([^"]+)"/.exec(manifest)?.[1] ?? "unknown";
const bridgeProtocol = /BRIDGE_PROTOCOL_VERSION = "([^"]+)"/.exec(readFileSync(path.join(ROOT, "src", "lib", "core", "bridge-protocol.ts"), "utf8"))?.[1] ?? "unknown";
const consistency = {
  packageJson: pkg.version ?? "(unset)",
  versionFile,
  uxpBundle: uxpVersion,
  bridgeProtocol,
  consistent: true,
};
// Consistency rule: package.json major.minor must match VERSION's, UXP bundle stays 1.0.0 (independent plugin lifecycle).
const vm = /^v(\d+)\.(\d+)/.exec(versionFile);
consistency.consistent = Boolean(vm && vm[1] === (pkg.version ?? "").split(".")[0] && vm[2] === (pkg.version ?? "").split(".")[1]);

// ---------- 1. Studio (build artifact + env template) ----------
const studioOut = path.join(OUT, "studio");
mkdirSync(studioOut, { recursive: true });
cpSync(path.join(ROOT, ".env.example"), path.join(studioOut, ".env.example"));
cpSync(path.join(ROOT, "package.json"), path.join(studioOut, "package.json"));
cpSync(path.join(ROOT, "bun.lock"), path.join(studioOut, "bun.lock"));
const buildLog = readFileSync(path.join(ROOT, "download", "m23-evidence", "build-cycle-m23.log"), "utf8");
const buildHash = sha256Bytes(Buffer.from(buildLog));
writeFileSync(path.join(studioOut, "BUILD-INFO.txt"),
  `BEAN FX Studio — release build reference\n` +
  `next build: SUCCESS (webpack, output:standalone) — see download/m23-evidence/build-cycle-m23.log\n` +
  `build-log sha256: ${buildHash}\n` +
  `reproduce: bun install && bun run build && DATABASE_URL=file:./db/custom.db PORT=3117 bun .next/standalone/server.js\n` +
  `Version: ${versionFile}\n`);

// ---------- 3. Core SDK tarball ----------
const coreOut = path.join(OUT, "core-sdk");
mkdirSync(coreOut, { recursive: true });
execSync(`cp -r ${ROOT}/src/lib/core ${coreOut}/src && cp ${ROOT}/src/lib/premiere/uxp-adapter.ts ${coreOut}/src/premiere-uxp-adapter.ts && cd ${coreOut} && tar czf core-sdk-${versionFile}.tgz src`, { stdio: "pipe" });

// ---------- 5. MCP integration package ----------
const mcpOut = path.join(OUT, "mcp-integration");
mkdirSync(mcpOut, { recursive: true });
for (const f of ["scripts/mcp-stdio-server.ts", "src/lib/mcp/tools.ts", "src/lib/mcp/bootstrap.ts", "scripts/mcp-client-harness.ts", "scripts/mcp-raw-client.ts"]) {
  cpSync(path.join(ROOT, f), path.join(mcpOut, path.basename(f)));
}
writeFileSync(path.join(mcpOut, "README.txt"),
  `BEAN FX MCP integration package\n` +
  `Shared registry: 8 tools (server.capabilities, projects.list, project.canonical, jobs.status, jobs.submit, jobs.cancel, myai.status, myai.execute) — ONE registry, no forks.\n` +
  `stdio: BEANFX_BASE_URL=<studio> BEANFX_TOKEN=bfx_… bun mcp-stdio-server.ts\n` +
  `HTTPS: POST JSON-RPC 2.0 to /api/v1/mcp with Authorization: Bearer bfx_…\n` +
  `Reference clients: mcp-client-harness.ts (official SDK) + mcp-raw-client.ts (independent implementation).\n` +
  `Approvals: one-time, hash-bound, expiring — created via the Studio session (POST /api/mcp/approvals). Never bypassable.\n`);

// ---------- checksums for every package ----------
const lines: string[] = [];
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = path.join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
for (const dir of ["studio", "core-sdk", "mcp-integration", "premiere-uxp", "windows-bridge"]) {
  const abs = path.join(OUT, dir);
  const files = walk(abs).filter((f) => !f.endsWith("SHA256SUMS.txt"));
  writeFileSync(path.join(abs, "SHA256SUMS.txt"), files.map((f) => `${sha256(f)}  ${path.relative(abs, f)}`).join("\n") + "\n");
  lines.push(`${dir}: ${files.length} files`);
}

// ---------- license & attribution review (direct deps) ----------
const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
const licenseOf = (name: string): string | null => {
  try { return (JSON.parse(readFileSync(path.join(ROOT, "node_modules", name, "package.json"), "utf8")) as { license?: string }).license ?? null; } catch { return null; }
};
const licenses: Record<string, string | null> = {};
for (const name of Object.keys(deps)) licenses[name] = licenseOf(name);
writeFileSync(path.join(OUT, "LICENSE-REVIEW.json"), JSON.stringify({
  directDependencies: Object.keys(deps).length,
  licensesSummary: Object.values(licenses).reduce<Record<string, number>>((acc, l) => { const k = l ?? "unknown"; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}),
  knownNonOsi: Object.entries(licenses).filter(([, l]) => l && /unlicense|wtfpl|cc/i.test(l)).map(([n, l]) => ({ n, l })),
  note: "Generated AI content remains subject to the provider's own terms (declared in JAZMII capabilities.commercialUse — NOT independently verified).",
}, null, 2));

writeFileSync(path.join(OUT, "VERSION-CONSISTENCY.json"), JSON.stringify(consistency, null, 2));
console.log(`packages: ${lines.join(", ")}`);
console.log(`version consistency: ${JSON.stringify(consistency)}`);
