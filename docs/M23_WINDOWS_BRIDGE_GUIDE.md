# M23 P2 — BEAN FX Desktop Bridge: Windows production validation guide

**Applies to:** Windows 10/11, bun ≥ 1.1. Linux CI cannot certify Windows
behavior — every §B item is OWNER ACTION REQUIRED until evidence returns.
Package: `download/m23-evidence/packages/windows-bridge/` (verify with
`Get-FileHash` against `SHA256SUMS.txt`).

## A. What ships (and the security model)
- `desktop-bridge.ts` — loopback-only HTTP bridge, EPHEMERAL port (`port: 0`),
  challenge/response HMAC proof-of-possession, single-use challenges,
  fail-closed proxy to Studio API v1, LRU asset cache reaper, NO exec surface.
- `credential-store.ts` — provider matrix:
  - Windows: **Windows Credential Manager** via real `CredWrite` P/Invoke
    (advapi32.dll), target **"BEAN FX Bridge"**; delete via `cmdkey /delete`.
    An operational 0600-equivalent copy also lives in the state dir so the
    bridge can use the token without a CredentialManager PS module — BOTH
    copies are user-ACL-protected and the active provider is reported in
    `/health` (`credentialProvider`) and the startup JSON. **Never silent
    plaintext.**
  - macOS/Linux: `security` / `secret-tool`; explicit `file-0600` fallback
    ONLY, always surfaced by name.
- `bridge-install.ps1` — prerequisites, user-only ACL state dir, REAL CredMan
  write+delete self-test. `bridge-uninstall.ps1` — credential + state + task
  removal.

## B. Validation checklist (record PASS/FAIL + screenshot for each)
- [ ] B1 `bridge-install.ps1` completes; CredMan self-test prints [OK].
- [ ] B2 Start bridge → startup JSON: loopback host, ephemeral port,
      `credentialProvider: "windows-credman"`.
- [ ] B3 `netstat -ano | findstr <pid>` → LISTENING on 127.0.0.1 ONLY.
- [ ] B4 Credential Manager shows **BEAN FX Bridge** (Control Panel →
      Credential Manager → Windows Credentials).
- [ ] B5 Pair with a Studio integration token → health `paired:true`.
- [ ] B6 Proxy call succeeds; the state file contains NO `bfx_` token.
- [ ] B7 Restart the bridge → recovers paired state WITHOUT re-entering the token.
- [ ] B8 Revoke the token in Studio → next proxied call fails 401 (fail closed).
- [ ] B9 Kill bridge → `icacls <state-dir>` shows user-only ACL preserved.
- [ ] B10 5 concurrent challenge+proxy flows all succeed (no clobbering).
- [ ] B11 Wrong proof / no challenge → 401; `/exec`, `/cmd` → 404.
- [ ] B12 Cache reaper endpoint works; no files outside the cache dir.
- [ ] B13 `bridge-uninstall.ps1` removes credential, state, task; Studio
      data untouched.

## C. Explicit limitations (documented fallback policy)
- The operational token copy in the state dir is ACL-protected (user-only)
  but is NOT DPAPI-encrypted; CredMan remains the authoritative store.
  This is an explicitly documented limitation, not a silent downgrade.
- Ephemeral port changes each start by design — pairing clients must use
  the printed URL. No fixed port is opened.
- No privileged command execution exists in the bridge; do not add one.
