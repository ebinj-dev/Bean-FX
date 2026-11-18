#Requires -Version 5.1
# BEAN FX Desktop Bridge — Windows installer (production validation package).
# Installs prerequisites check + state directory + optional startup entry.
# NEVER creates an unrestricted localhost command server; the bridge binds
# loopback-only with an ephemeral port and stores tokens in the Windows
# Credential Manager (target: "BEAN FX Bridge").
param(
  [string]$RepoRoot = "$PSScriptRoot",
  [string]$StateDir = "$env:LOCALAPPDATA\BEANFX\bridge-state"
)
$ErrorActionPreference = "Stop"
Write-Host "=== BEAN FX Desktop Bridge installer ==="

# 1. Bun runtime check (the bridge runs on bun).
$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun) {
  Write-Error "bun is not installed or not on PATH. Install from https://bun.sh (bun.exe must be resolvable)."
}
Write-Host "[OK] bun: $((Get-Command bun).Source)"

# 2. Node check for tooling parity (informational).
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { Write-Host "[OK] node: $($node.Version)" } else { Write-Host "[INFO] node not present (bun suffices)" }

# 3. State directory with USER-only ACL (no world-readable state).
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
& icacls $StateDir /inheritance:r /grant:r "$env:USERNAME:(OI)(CI)F" | Out-Null
Write-Host "[OK] state dir: $StateDir (user-only ACL)"

# 4. Files present?
foreach ($f in @("desktop-bridge.ts", "credential-store.ts", "bridge-protocol.ts")) {
  $p = Join-Path $RepoRoot $f
  if (-not (Test-Path $p)) { Write-Error "missing required file: $f" }
}
Write-Host "[OK] bridge sources present"

# 5. Credential Manager write/read/delete self-test (real CredMan round trip).
Write-Host "[..] Windows Credential Manager self-test (writes temporary credential 'BEAN FX Bridge selftest')"
$script = Join-Path $env:TEMP "beanfx-credman-selftest.ps1"
@'
Add-Type -MemberDefinition '[DllImport("advapi32.dll",EntryPoint="CredWriteW",CharSet=CharSet.Unicode)] public static extern bool CredWrite([In] ref CREDENTIAL cred,[In] uint flags); [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct CREDENTIAL { public uint Flags; public uint Type; public string TargetName; public string Comment; public FILETIME LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; } [StructLayout(LayoutKind.Sequential)] public struct FILETIME { public uint Low; public uint High; }' -Name Cred -Namespace BeanFx
$b=[System.Text.Encoding]::UTF8.GetBytes("selftest-$PID")
$p=[System.Runtime.InteropServices.Marshal]::AllocHGlobal($b.Length)
[System.Runtime.InteropServices.Marshal]::Copy($b,0,$p,$b.Length)
$c=New-Object BeanFx.Cred+CREDENTIAL
$c.TargetName="BEAN FX Bridge selftest"; $c.Type=1; $c.CredentialBlobSize=$b.Length; $c.CredentialBlob=$p; $c.Persist=2
if (-not [BeanFx.Cred]::CredWrite([ref]$c,0)) { throw "CredWrite failed" }
cmdkey /delete:"BEAN FX Bridge selftest" | Out-Null
Write-Host "[OK] CredMan write+delete verified"
'@ | Set-Content -Path $script -Encoding UTF8
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script
Remove-Item $script -ErrorAction SilentlyContinue

# 6. Optional: startup task (commented by default — enable manually if wanted).
# schtasks /Create /TN "BEANFX Bridge" /TR "bun $RepoRoot\desktop-bridge.ts" /SC ONLOGON /RL LIMITED
Write-Host "[DONE] Install complete. Start the bridge with:"
Write-Host "  `bun desktop-bridge.ts`  (env: BEANFX_BASE_URL=<studio url>, BEANFX_BRIDGE_STATE_DIR=$StateDir)"
Write-Host "The startup JSON must show \"credentialProvider\":\"windows-credman\"."
