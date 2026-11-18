# M23 P1 — BEAN FX Premiere Pro UXP: real-machine validation checklist

**Environment required:** Windows 10/11 or macOS 13+, Premiere Pro 24.x+,
Adobe UXP Developer Tool (UDT, from Creative Cloud). Linux/CI CANNOT run
these steps — every item below is OWNER ACTION REQUIRED until the owner
returns the evidence. Package: `download/m23-evidence/packages/premiere-uxp/`
(verify first: `sha256sum -c SHA256SUMS.txt`).

For EVERY item record: PASS/FAIL + screenshot or console output + Premiere
version + OS. Return results as `premiere-host-results.json` produced by
`window.beanfxHarness.runAll()` where marked [HARNESS].

## 1. Install & load
- [ ] 1.1 UDT shows the plugin without import errors (Add Plugin → manifest.xml).
- [ ] 1.2 Load → Premiere launches; panel appears under Window > Extensions > BEAN FX.
- [ ] 1.3 No console errors on first open (UDT > Debug console).

## 2. Startup / shutdown / reinitialization
- [ ] 2.1 Startup: panel initializes; adapter logs `runtimeAvailable=true` [HARNESS item `runtime`].
- [ ] 2.2 Shutdown: close panel → unload; no orphaned handles (Premiere quits cleanly).
- [ ] 2.3 Reinitialization: reopen panel → capabilities re-discovered, no stale cache [HARNESS `capabilities`].
- [ ] 2.4 Restart Premiere → panel auto-loads if enabled; state consistent.

## 3. Capability & sequence discovery
- [ ] 3.1 Capability discovery lists only REAL host features [HARNESS `capabilities`].
- [ ] 3.2 Active sequence metadata read (name/fps/size) [HARNESS `sequence-discovery`].
- [ ] 3.3 With NO sequence open → explicit, honest failure (no fake data).

## 4. Project & sequence operations
- [ ] 4.1 Import: canonical `beanfx-project-v1` → Premiere metadata enriched [HARNESS `import`].
- [ ] 4.2 Export: sequence → canonical, format marker intact [HARNESS `export`].
- [ ] 4.3 Round-trip: export → import → export is stable (ids/presets preserved).

## 5. Timeline operation boundaries
- [ ] 5.1 MOVE_CLIP / TRIM_CLIP / INSERT_CLIP / REMOVE_CLIP / ADD_TRACK succeed on real tracks [HARNESS `op`].
- [ ] 5.2 Op targeting a missing clip fails CLEANLY with `hostStateUnchanged` [HARNESS `op-clean-failure`].
- [ ] 5.3 SET_TRANSITION (unsupported) → explicit `unsupportedOp` refusal [HARNESS `unsupported-op`].
- [ ] 5.4 Undo (Cmd/Ctrl+Z) after each op returns the sequence to its prior state.

## 6. Error handling & rollback
- [ ] 6.1 Kill the panel mid-operation → Premiere project unaffected on reopen.
- [ ] 6.2 Invalid canonical JSON → typed error, no partial import.
- [ ] 6.3 Bridge/Studio offline during Send → explicit failure in panel, no silent retry.

## 7. Core SDK compatibility
- [ ] 7.1 panel.js bundle contains `beanfx-project-v1` + timebase conversions (verified at package time).
- [ ] 7.2 Exported sequence JSON validates against the M11 schema via Studio (paste into Studio import).

## 8. Evidence to return
- [ ] 8.1 `beanfx-m22-harness-results.json` (or newer) from the plugin data folder.
- [ ] 8.2 Screenshots: panel loaded, harness output, one successful import/export.
- [ ] 8.3 Premiere + UDT versions, OS version.
