/**
 * M23 P1/P5 — Production packaging for the BEAN FX Premiere UXP extension.
 * Assembles a loadable UXP package (manifest + built panel.js + index.html),
 * writes sha256 checksums, and emits a packaging manifest.
 * AUTOMATED evidence; the package itself is what the owner loads via UDT.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, cpSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = "/home/z/my-project";
const SRC = path.join(ROOT, "src", "integrations", "premiere-panel");
const OUT = path.join(ROOT, "download", "m23-evidence", "packages", "premiere-uxp");

mkdirSync(OUT, { recursive: true });

// 1. Build panel.js fresh (same target UDT loads).
execSync(`bun build ${path.join(SRC, "panel.ts")} --outfile ${path.join(SRC, "panel.js")} --target browser --minify`, { stdio: "pipe" });

// 2. Copy exactly the files UXP needs.
for (const f of ["manifest.xml", "panel.js", "index.html"]) {
  if (!existsSync(path.join(SRC, f))) throw new Error(`missing UXP file: ${f}`);
  cpSync(path.join(SRC, f), path.join(OUT, f));
}

// 3. Checksums.
const sha256 = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const files = ["manifest.xml", "panel.js", "index.html"];
const lines = files.map((f) => `${sha256(path.join(OUT, f))}  ${f}`);
writeFileSync(path.join(OUT, "SHA256SUMS.txt"), lines.join("\n") + "\n");

// 4. Packaging report.
const manifest = readFileSync(path.join(OUT, "manifest.xml"), "utf8");
const bundleId = /ExtensionBundleId="([^"]+)"/.exec(manifest)?.[1];
const bundleVersion = /ExtensionBundleVersion="([^"]+)"/.exec(manifest)?.[1];
writeFileSync(path.join(OUT, "PACKAGE.md"), `# BEAN FX Premiere UXP package
- Bundle: ${bundleId} v${bundleVersion}
- Host: PPRO [24.0, 99.9] (UXP, Version=7.0 manifest)
- Contents: manifest.xml, panel.js (built ${new Date().toISOString()}, includes the M22 in-panel harness as window.beanfxHarness), index.html
- Integrity: SHA256SUMS.txt (verify with: sha256sum -c SHA256SUMS.txt)
- Install: Adobe UXP Developer Tool → Add Plugin → manifest.xml → Load.
  (Marketplace/plugin folder install requires a signed .ccx — NOT produced;
  UDT loading is the supported path for this release.)
`);

console.log(`packaged ${bundleId} v${bundleVersion}`);
console.log(lines.join("\n"));
