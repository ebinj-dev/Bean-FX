#Requires -Version 5.1
# BEAN FX Desktop Bridge — Windows uninstaller.
# Removes: stored credentials (CredMan target "BEAN FX Bridge"), state
# directory contents, optional scheduled task. Leaves Studio data untouched.
param(
  [string]$StateDir = "$env:LOCALAPPDATA\BEANFX\bridge-state"
)
$ErrorActionPreference = "Continue"
Write-Host "=== BEAN FX Desktop Bridge uninstaller ==="

# 1. Remove stored credential.
cmdkey /delete:"BEAN FX Bridge" | Out-Null
Write-Host "[OK] Credential Manager entry removed (if present)"

# 2. Remove state + cache (contains no device token by design, but clean fully).
if (Test-Path $StateDir) {
  Remove-Item -Recurse -Force $StateDir
  Write-Host "[OK] state dir removed: $StateDir"
}

# 3. Remove optional startup task if it was enabled.
schtasks /Delete /TN "BEANFX Bridge" /F 2>$null | Out-Null
Write-Host "[OK] startup task removed (if present)"
Write-Host "[DONE] Uninstall complete. Bridge sources under your repo checkout can be deleted manually."
