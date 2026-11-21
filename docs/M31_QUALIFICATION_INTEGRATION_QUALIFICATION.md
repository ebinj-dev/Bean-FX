# M31 INTEGRATION QUALIFICATION — Premiere UXP, Desktop Bridge, providers, email

## A. Premiere Pro UXP (static + automated) — AUTOMATED ✓ / real-host OWNER ACTION
Checks run (20/20 in integration-static-checks.log): panel artifacts + 8-check in-panel harness present; no embedded secrets; host/version capability discovery; unsupported-operation refusal; token-based auth + pairing (panel.js bundle + host-adapter + bridge-protocol); bridge token hashing; OS-native-first credential store; pairing challenge/expiry lifecycle; M21/M22 protocol suites present (test-m21-bridge, test-m21-premiere, test-m22-bridge-deep, test-m22-e2e).
**Real-host execution inside Premiere Pro 24+ = OWNER ACTION** — reproducible steps: `docs/M23_PREMIERE_CHECKLIST.md` + `docs/M22_OWNER_ACTIONS.md` (exact app versions + harness result file `beanfx-m22-harness-results.json`). Never claimed from this Linux sandbox.

## B. Windows Desktop Bridge — AUTOMATED ✓ / Windows OWNER ACTION
Install/uninstall PowerShell: OS-native credential write, lifecycle management, no embedded secrets. Bridge protocol: hashing, pairing challenge/expiry, scoped local IPC (no unrestricted localhost endpoint). Windows host execution (Credential Manager live write/read, reconnect) = OWNER ACTION per M22/M23.

## C. AI providers — CONFIGURATION REQUIRED (honest)
Diagnostics (provider-email-diagnostics.log): no provider credentials in this environment; all six engine internal contracts covered by passing suites; no live call fabricated; timeout/failure paths typed. `/api/admin/health` reports provider CONFIGURED/ABSENT only. No Ollama.

## D. Email — CONFIGURATION REQUIRED (honest fallback VERIFIED)
Mailer honest contract re-verified (`delivered=false, reason=SMTP not configured`); invitation creation returns a copyable URL with `emailSent:false` — the M30-verified fallback remains the production answer. Retry/dedup semantics covered by the worker suite (3 attempts → 1 row).

## E. Desktop Bridge connectivity / package integrity
Package integrity: M29 integrity 8/8 + portability 4/4 re-run green (STORED-only zip gate, manifest gating, path-traversal rejection). Bridge connectivity diagnostics ride `/api/admin/health` (worker/queue/storage) + M22 harness on the host.
