# M36 — Security & Release-Safety Review (Phase I)

**Scope:** review of the M36 deployment package (scripts, templates, docs, the one `src` change). Reuse of existing controls preferred over new systems. **No penetration test was performed — this is a code/configuration review plus repository scans; nothing here claims otherwise.**

## 1. Repository scans (executed)

| Scan | Tool | Result |
|---|---|---|
| Secret scan — all 24 changed/new files (patterns: provider keys `sk-…`/`AKIA…`/`ghp_…`, PEM private-key blocks, 32+ char literals, password/token assignments) | grep battery (this milestone) | **0 matches** (`SECRET_SCAN_MATCHES=0`). Placeholders (`__SET_ON_HOST__`) are the only credential-shaped strings, by design |
| Dependency vulnerability scan | `scripts/m20-osv-scan.py` (existing repo tooling) | **77 packages scanned: CRITICAL 0 · HIGH 0 · MEDIUM 0 · LOW 0** (evidence `download/m20-osv-dependency-scan.json`) |
| Publication protocol | §14 sequence | diff review + scan re-run before commit; no runtime artifacts (DBs, media, logs, node_modules, .next) staged |

## 2. Findings by mandated review area

| Area | Finding | Severity | Remediation/Status |
|---|---|---|---|
| Secret leakage | No secrets in package; env file stays on host (mode 600 enforced by validator; strict-INVALID otherwise); all M36 tools print presence, never values; rehearsal/qualification logs contain no credentials | — | none needed |
| Unsafe file permissions | `m36-fs-layout.sh` sets data root 0700, backups 0700; validator flags group/world-readable env files and DB files (health check DEGRADED note) | — | covered |
| Unsafe shell execution | New shell scripts: no `eval`; variable expansions quoted; `set -euo pipefail`; the only env sourcing is the owner's own env file (`set -a; . "$ENV_FILE"` — file owned/mode-gated by the operator); no remote script execution | — | covered |
| Path traversal | No new path-accepting attack surface: tools operate on operator-supplied paths; `media-storage.ts` guards unchanged (absolute, dedicated-dir, not-root); archive import guards unchanged (M29-verified) | — | unchanged code |
| Untrusted upload handling | Unchanged: ffprobe-before-accept, type/size validation, authorized media routes (no public static media) | — | unchanged code |
| SSRF exposure | Unchanged: showcase URL fetch keeps `BLOCKED_HOSTS` + DNS private-range rejection + redaction | — | unchanged code |
| Reverse-proxy trust | Templates set `X-Forwarded-For $remote_addr` (socket peer); client-supplied forwarded headers never trusted/passed; app binds loopback in the template env so only the proxy is public | — | templates |
| Insecure defaults | Fail-cold gates (env/ExecStartPre); no default credentials; dev-default DB path explicitly rejected; `RATE_LIMIT_SCALE` forbidden in deployment | — | covered |
| Internal endpoint exposure | Only `/` + `/api/*` behind the proxy; `/api/health` exposes component status (no secrets — existing honest-check design); admin routes unchanged and session-gated | LOW (informational) | consider restricting `/api/health` at the proxy to internal ranges if the owner prefers — documented, not changed |
| Backup disclosure | Backups dir 0700; manifest contains no secret values (paths + hashes only); backup failure logs contain no data content | — | covered |
| Destructive upgrade behavior | `m36-upgrade.sh`: verified backup FIRST, ff-only checkout, non-destructive schema sync, failure halts before restart; no `--accept-data-loss`, no reset anywhere in the package | — | covered |
| Debug-mode exposure | `RATE_LIMIT_SCALE` gate; `NODE_ENV=production` in deployment path (query logging off — `db.ts` logs queries only outside production, unchanged) | — | covered |
| Unnecessary network listeners | App binds `127.0.0.1` per template env; no new listeners added by M36 (rehearsal scratch servers bind loopback by default and are torn down) | — | covered |

## 3. Pre-existing items carried forward (not M36 regressions)

- M22/M23-era ESLint `no-require-imports` debt in `src/lib/core/credential-store.ts` (outside all M35/M36 diffs) — owner action.
- Open registration policy decision (invite vs open) on staging — owner action (M35 security doc §2).
- These remain recorded, unchanged, and outside this milestone's diff.

## 4. Conclusion

The deployment package introduces **no new secret, network, or destructive-ops surface**; all mandated review areas are either covered by new controls (gates, permissions, refusals) or inherited unchanged from the M34/M35-qualified codebase. Scans are clean. Remaining hardening (health-endpoint restriction, registration policy, off-host adapter) is documented as owner decisions.
