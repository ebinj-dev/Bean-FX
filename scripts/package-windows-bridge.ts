/**
 * M23 P2 — assemble the Windows Desktop Bridge validation package.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = "/home/z/my-project";
const OUT = path.join(ROOT, "download", "m23-evidence", "packages", "windows-bridge");
mkdirSync(OUT, { recursive: true });

for (const f of [
  "scripts/desktop-bridge.ts",
  "src/lib/core/credential-store.ts",
  "src/lib/core/bridge-protocol.ts",
  "src/lib/core/host-adapter.ts",
  "scripts/bridge-install.ps1",
  "scripts/bridge-uninstall.ps1",
  "docs/M23_WINDOWS_BRIDGE_GUIDE.md",
]) {
  cpSync(path.join(ROOT, f), path.join(OUT, path.basename(f)));
}

const sha256 = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const files = ["desktop-bridge.ts", "credential-store.ts", "bridge-protocol.ts", "host-adapter.ts", "bridge-install.ps1", "bridge-uninstall.ps1", "M23_WINDOWS_BRIDGE_GUIDE.md"];
writeFileSync(path.join(OUT, "SHA256SUMS.txt"), files.map((f) => `${sha256(path.join(OUT, f))}  ${f}`).join("\n") + "\n");

console.log("windows-bridge package assembled:");
files.forEach((f) => console.log(`  ${sha256(path.join(OUT, f)).slice(0, 12)}…  ${f}`));
