# M23 P5 — BEAN FX v0.4.0-m23-rc1 packaging & release guide

**Release line:** v0.4.0-m23-rc1 · package.json `0.4.0` · UXP bundle `1.0.0`
(independent plugin lifecycle) · bridge protocol `beanfx-bridge-v1` · MCP
protocol `2025-06-18`. Consistency verified in
`download/m23-evidence/packages/VERSION-CONSISTENCY.json`.
**Nothing is published** — artifacts live in `download/m23-evidence/packages/`
with `SHA256SUMS.txt` per package. No npm/Adobe marketplace distribution
without explicit authorization.

## Compatibility matrix
| Component | Version | Requires | Verified in | Owner action |
|---|---|---|---|---|
| Studio | v0.4.0-m23-rc1 | bun ≥1.1, Node ≥20 (build), SQLite/Prisma, ffmpeg ≥6, python3 (media tools), ffprobe | Linux x64 sandbox — full E2E (P7) | Windows/macOS Studio install |
| Premiere UXP | 1.0.0 | Premiere Pro 24.x–99.x, UDT | manifest/build validation (8/8) | real-host checklist (M23_PREMIERE_CHECKLIST.md) |
| Desktop Bridge | beanfx-bridge-v1 | bun ≥1.1; Windows 10/11 for CredMan | Linux deep suite 12/12 | Windows §B guide (M23_WINDOWS_BRIDGE_GUIDE.md) |
| Core SDK | src/lib/core | TypeScript consumer | M21/M22 suites + P7 | — |
| MCP integration | 8-tool shared registry | any MCP-compatible client | 2 independent clients (SDK + raw) | optional third-party clients |

## 1. BEAN FX Studio
- **Install:** clone the repo at the release SHA → `bun install` → set env per
  `.env.example` → `bun run build` → run `.next/standalone/server.js` with
  `DATABASE_URL=file:./db/custom.db PORT=3117` → start the worker
  (`bun scripts/worker.ts` if present; M20 durable pipeline is in-process).
- **Upgrade:** stop server → back up `db/custom.db` and `media-store/` → pull
  the new SHA → `bun install && bun run build` → `bunx prisma migrate deploy`
  → restart. Media store and DB are forward-compatible within v0.4.x.
- **Uninstall:** stop processes; delete the checkout. Data (db/, media-store/)
  is separate — remove explicitly if desired.
- **Rollback:** restore previous SHA checkout + database backup (below).

## 2. Premiere UXP extension
- **Install:** `packages/premiere-uxp/` (verify SHA256SUMS) → UDT → Add Plugin
  → `manifest.xml` → Load. Real-machine checklist:
  `docs/M23_PREMIERE_CHECKLIST.md`.
- **Upgrade:** re-load in UDT after replacing files (UDT caches — use Reload).
- **Uninstall:** UDT → remove plugin entry.
- **Rollback:** previous panel.js + manifest (git history, checksums differ).

## 3. Desktop Bridge
- **Install (Windows):** `packages/windows-bridge/` →
  `powershell -File bridge-install.ps1` (prereqs + CredMan self-test) →
  `bun desktop-bridge.ts` with `BEANFX_BASE_URL`. Startup JSON must show
  `credentialProvider:"windows-credman"`.
- **Uninstall:** `bridge-uninstall.ps1` (credential + state + task removal).
- **Rollback:** reinstall previous package; state dir is version-agnostic
  (protocol beanfx-bridge-v1 unchanged).

## 4. Core SDK
- **Install:** copy `packages/core-sdk/src/` into the consumer or reference
  the repo path. No runtime dependencies added by the core modules.
- **Upgrade/rollback:** checksummed tarball per release; API is additive
  (beanfx-project-v1 format unchanged).

## 5. MCP integration
- **Install:** same process as Studio (part of the server). stdio client:
  `BEANFX_BASE_URL=… BEANFX_TOKEN=bfx_… bun mcp-stdio-server.ts`.
- **Tokens:** create in Studio UI → Integrations; scopes minimum needed;
  revoke from the same screen (immediate).
- **Rollback:** protocol constant; the eight-tool registry is the single
  source of truth — clients tolerate additive tool changes.

## Security notes (release)
- Session cookies: partitioned, SameSite; login rate-limited; 2FA (M18).
- Integration tokens: sha256-hashed at rest, prefix-only display, immediate
  revocation, per-scope enforcement.
- MCP: one-time hash-bound approvals; server-side enforcement; no client
  bypass; malformed input → structured JSON-RPC errors.
- Bridge: loopback-only, ephemeral port, HMAC challenge, single-use
  challenges, CredMan-backed credentials, no command-exec surface.
- Worker: guarded finishJob (late completions cannot resurrect CANCELLED).
- Dependencies: OSV scan 0 known vulnerabilities (M23 re-run in P6 evidence).
- Privacy/consent: unchanged from M20 (no payment/SMTP/legal changes).

## License & attribution
- Direct deps reviewed (`packages/LICENSE-REVIEW.json`): standard
  MIT/ISC/Apache-2.0BSD family; no non-OSI licenses found.
- Generated AI content: subject to the provider's own terms — declared in
  the JAZMII capability record (`commercialUse`), NOT independently verified.
- ffmpeg/python tooling: follow their upstream licenses in deployment images.

## Backup & restore
- Studio: `db/custom.db` (SQLite) + `media-store/`. Backup = file copy while
  stopped (or sqlite3 .backup while running); restore = copy back before start.
- Bridge state: disposable by design (re-pair after loss; tokens live in
  CredMan and are revocable).
