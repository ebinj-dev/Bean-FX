# M31 UI REGRESSION REPORT

**Scope note:** M31 changed NO user-facing UI (additive admin-only diagnostics endpoint + test/deps files). The existing UI is the M30-verified surface; its walkthrough evidence remains authoritative for M31.

## Re-verification performed
- tsc 0 / ESLint clean / production build SUCCESS after all M31 changes.
- Public `/api/health` unchanged (db/storage/disk honest checks) — the UI's dependence surface intact.
- Editor/admin surfaces unchanged (no route or component edits in M31).

## Carried-forward browser evidence (M30, still current)
16 screenshots in `download/m30-evidence/screenshots/`: owner→workspace→invitation→acceptance→review session→review link→guest identity gate→frame comment→reply→go-to-frame→approve→notifications→375px (review page, editor, COLLAB drawer — no horizontal overflow at 375×812).

## 375px responsive
M31 introduced no layout changes; the M30 no-overflow results carry forward unchanged (VERIFIED).
