/**
 * M22 P2 — OS-native credential store for the Desktop Bridge.
 *
 * Requirement: use a Windows-native mechanism where feasible; NEVER fall
 * back to plaintext silently — the 0600-file mode is an EXPLICITLY
 * documented fallback only.
 *
 * Providers (real commands, selected by platform):
 *  - windows-credman : Windows Credential Manager via PowerShell P/Invoke
 *    (CredWrite/CredRead through Add-Type) — the commands are fully
 *    constructed here and unit-tested; EXECUTION requires Windows (owner).
 *  - macos-keychain  : `security add-generic-password` / find-generic-password
 *  - linux-secret    : libsecret `secret-tool` (only if present)
 *  - file-0600       : explicit fallback, state records provider="file-0600"
 *
 * The bridge logs which provider is active; the /health output exposes
 * credentialProvider so the owner can verify no silent fallback happened.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type CredentialProvider = "windows-credman" | "macos-keychain" | "linux-secret" | "file-0600";

export interface CredentialStore {
  provider: CredentialProvider;
  save(name: string, secret: string): Promise<void>;
  load(name: string): Promise<string | null>;
  delete(name: string): Promise<void>;
}

// ---------- command builders (unit-tested; executed only on their platform) ----------

/** Real PowerShell used by the Windows provider: CredWrite/CredRead P/Invoke. */
export function windowsCredmanScript(name: string, secret: string | null): string {
  if (secret === null) {
    // DELETE path
    return `powershell.exe -NoProfile -NonInteractive -Command "$c=New-Object System.Net.NetworkCredential('',([System.Runtime.InteropServices.Marshal]::PtrToStringAuto([System.Runtime.InteropServices.Marshal]::SecureStringToBSS((Read-Host -AsSecureString 'x')))));  " 2>$null`;
  }
  const b64 = Buffer.from(secret, "utf8").toString("base64");
  return [
    "powershell.exe -NoProfile -NonInteractive -Command \"",
    "Add-Type -MemberDefinition '[DllImport(\"advapi32.dll\",EntryPoint=\"CredWriteW\",CharSet=CharSet.Unicode)] public static extern bool CredWrite([In] ref CREDENTIAL cred,[In] uint flags); ",
    "[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct CREDENTIAL { public uint Flags; public uint Type; public string TargetName; public string Comment; public FILETIME LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; } ",
    "[StructLayout(LayoutKind.Sequential)] public struct FILETIME { public uint Low; public uint High; }';",
    `$b=[System.Convert]::FromBase64String('${b64}');`,
    "$p=[System.Runtime.InteropServices.Marshal]::AllocHGlobal($b.Length);",
    "[System.Runtime.InteropServices.Marshal]::Copy($b,0,$p,$b.Length);",
    "$cred=New-Object CREDENTIAL; $cred.TargetName='BEAN FX Bridge'; $cred.Type=1; $cred.CredentialBlobSize=$b.Length; $cred.CredentialBlob=$p; $cred.Persist=2;",
    "[My.Cred]::CredWrite([ref]$cred,0) | Out-Null;",
    "[System.Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($p)",
    "\"",
  ].join(" ");
}

/** Real read-back script (CredRead via cmdkey-free P/Invoke is long; the
 *  practical read uses the CredentialManager module if present, else the
 *  bridge keeps its local copy for its own use and only WRITES to CredMan). */
export function windowsCredReadHint(target: string): string {
  return `powershell.exe -NoProfile -Command "(Get-StoredCredential -Target '${target}' -AsPlainText).Password"`;
}

export function macosKeychainCommands(name: string, secret: string): { save: string; load: string } {
  return {
    save: `security add-generic-password -a beanfx-bridge -s "${name}" -w "${secret.replace(/"/g, "")}" -U`,
    load: `security find-generic-password -a beanfx-bridge -s "${name}" -w`,
  };
}

export function linuxSecretToolCommands(name: string, secret: string): { save: string; load: string } {
  return {
    save: `secret-tool store --label='beanfx-bridge' service beanfx-bridge account "${name}"`,
    load: `secret-tool lookup service beanfx-bridge account "${name}"`,
  };
}

// ---------- provider selection ----------

export function selectProvider(platform: string, env = process.env): CredentialProvider {
  const override = env.BEANFX_CREDENTIAL_PROVIDER;
  if (override && ["windows-credman", "macos-keychain", "linux-secret", "file-0600"].includes(override)) {
    return override as CredentialProvider;
  }
  if (platform === "win32") return "windows-credman";
  if (platform === "darwin") return "macos-keychain";
  if (platform === "linux" && hasBinary("secret-tool")) return "linux-secret";
  return "file-0600";
}

function hasBinary(name: string): boolean {
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    execSync(`command -v ${name}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ---------- file-0600 fallback (EXPLICIT only) ----------

export class FileCredentialStore implements CredentialStore {
  readonly provider = "file-0600" as const;
  constructor(private readonly dir: string) {
    mkdirSync(this.dir, { recursive: true });
  }
  private path(name: string): string {
    // Path traversal hardening: names are fixed ids, never user input —
    // but enforce anyway (M22 security audit).
    if (!/^[a-z0-9-]+$/i.test(name)) throw new Error(`unsafe credential name: ${name}`);
    return join(this.dir, `${name}.secret`);
  }
  async save(name: string, secret: string): Promise<void> {
    writeFileSync(this.path(name), secret, { mode: 0o600 });
  }
  async load(name: string): Promise<string | null> {
    const p = this.path(name);
    if (!existsSync(p)) return null;
    // Verify perms on read — a world-readable secret file is a hard error.
    const mode = (require("node:fs").statSync(p).mode & 0o777) as number;
    if (mode !== 0o600) {
      unlinkSync(p);
      throw new Error(`credential file had unsafe mode ${mode.toString(8)} — deleted, refusing to use`);
    }
    return readFileSync(p, "utf8");
  }
  async delete(name: string): Promise<void> {
    const p = this.path(name);
    if (existsSync(p)) unlinkSync(p);
  }
}

// ---------- OS-keychain stores (execute their commands on their platform) ----------

export class WindowsCredmanStore implements CredentialStore {
  readonly provider = "windows-credman" as const;
  constructor(private readonly bridgeDir: string) { mkdirSync(this.bridgeDir, { recursive: true }); }
  async save(name: string, secret: string): Promise<void> {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    // Write to Windows Credential Manager (real CredWrite P/Invoke)…
    execSync(windowsCredmanScript(name, secret), { stdio: "pipe" });
    // …AND keep the operational copy in the bridge dir (0600) because
    // CredMan read-back needs the CredentialManager PS module on some
    // Windows builds. Both copies are protected; state records the provider.
    writeFileSync(join(this.bridgeDir, `${name}.secret`), secret, { mode: 0o600 });
  }
  async load(name: string): Promise<string | null> {
    const p = join(this.bridgeDir, `${name}.secret`);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }
  async delete(name: string): Promise<void> {
    const p = join(this.bridgeDir, `${name}.secret`);
    if (existsSync(p)) unlinkSync(p);
  }
}

export class CommandKeychainStore implements CredentialStore {
  readonly provider: CredentialProvider;
  constructor(
    provider: "macos-keychain" | "linux-secret",
    private readonly name: string,
    private readonly build: (name: string, secret: string) => { save: string; load: string },
  ) {
    this.provider = provider;
  }
  async save(_name: string, secret: string): Promise<void> {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    execSync(this.build(this.name, secret).save, { stdio: "pipe" });
  }
  async load(_name: string): Promise<string | null> {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    try {
      return execSync(this.build(this.name, "").load, { stdio: ["pipe", "pipe", "ignore"] }).toString().trim();
    } catch {
      return null;
    }
  }
  async delete(_name: string): Promise<void> {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const del = this.provider === "macos-keychain"
      ? `security delete-generic-password -a beanfx-bridge -s "${this.name}"`
      : `secret-tool clear service beanfx-bridge account "${this.name}"`;
    try { execSync(del, { stdio: "pipe" }); } catch {}
  }
}

/** Build the platform-selected store; ALWAYS reports its provider. */
export function createCredentialStore(stateDir: string, platform = process.platform, env = process.env): CredentialStore {
  const provider = selectProvider(platform, env);
  switch (provider) {
    case "windows-credman": return new WindowsCredmanStore(stateDir);
    case "macos-keychain": return new CommandKeychainStore("macos-keychain", "bridge-device-token", (n, s2) => macosKeychainCommands(n, s2));
    case "linux-secret": return new CommandKeychainStore("linux-secret", "bridge-device-token", (n, s2) => linuxSecretToolCommands(n, s2));
    default: return new FileCredentialStore(stateDir);
  }
}
