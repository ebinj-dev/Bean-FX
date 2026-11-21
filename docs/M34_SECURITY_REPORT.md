# M34 — Security Report (Track E)

**Date:** 2026-11-21 · Scope: the release candidate as of the M34 working tree on `feature/ai-creative-studio`.

## 1. Application security review (E1 — code-inspected, regression-tested)

| Area | Mechanism (actual code) | Verification |
|---|---|---|
| Authentication | session cookie `beanfx_session` — `None+Secure+Partitioned` (CHIPS), scrypt password hashing, duplicate-cookie extraction hardening (`src/lib/auth.ts`) | M22 security 18/18 (restored), M31 security 8/8 |
| Authorization | per-user project ownership on every route; integration tokens scoped (e.g. `mcp:invoke` required for MCP), hash-only storage with ≤12-char prefix | M22 S1/S2 suites (restored) assert 401/403 boundaries, token scoping, cross-project canary invisibility |
| Guest access | M30 review links: high-entropy token stored hash-only, scoped guest session, no workspace membership, no original-media access, revocable/expiring | M30 collab 13/13; M23 release checks |
| Consent & provider gates | approval gates on showcase artifacts (`` markers in workflow templates); whitelisted step library only; paid generation gated per-operation | M31/M32 suites + M33 acceptance (real workflow through gates) |
| SSRF controls | no server-side fetch of user-supplied URLs; provider calls go through the local CLI; showcase product URL is stored, never fetched server-side | code inspection + M31 security SSRF cases (8/8) |
| Upload validation | extension classification + ffprobe validation; invalid media refused or marked unusable (M34 R1); 250 MB/2 GB/5 GB limits enforced | M34 storage-worker suite 6/6 |
| Archive extraction | 800-entry cap, unpacked byte cap, per-entry sha256 vs manifest (assets AND masks), safe path joining | M29 suites (regression batch) |
| Path traversal | symlink-aware `isInsideMediaRoot` on all storage paths | M28/M29 suites + M34 R5 |
| API error disclosure | honest error messages without internals; worker failures record operator-meaningful reasons (verified in M34 R2: honest FAILED message, no stack traces to clients) | M34 R2 + M31 security |
| Rate limits | fixed-window counters on auth/register/write buckets; `RATE_LIMIT_SCALE` test-only | M31 security + unit checks |
| Session/token handling | expiry-backed sessions; tokens returned once, revocable | M22 S2 (restored) |

## 2. Secrets and credentials (E2 — scanned + verified)

- `.env` is **not tracked** (verified via `git ls-files`); `.env.example` documents non-secret variables with "NEVER commit a real .env" guidance.
- Secret-pattern scan of all tracked files: matches are benign — a redaction-function test using deliberately fake inputs (`test-showcase-core.test.ts`) and local throwaway test passwords (`e2e-…`, `m23-qual-…`) in scripts that create disposable local accounts. No live credentials in the tree.
- Provider readiness probes return pre-redacted details (contract in `src/lib/providers/readiness.ts`); preflight reports secret **presence only**; the M30/M22 suites verify raw tokens are never stored (hash + prefix only).
- Signed media references: stored media lives under the storage root served through authenticated routes; exports are served per-user with ownership checks.

## 3. Dependency & build security (E3 — measured)

| Check | Tool (existing infrastructure) | Result |
|---|---|---|
| Vulnerability scan | `scripts/m20-osv-scan.py` (OSV database, 77 direct packages) | **0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW / 0 UNRATED** (evidence: `download/m20-osv-dependency-scan.json`) |
| SBOM | generated from the lockfile into CycloneDX-style JSON (985 components), no new dependencies, no external service | `download/m34-sbom.json` |
| Native scanner | `bun pm scan` | requires a configured scanner package — **not added** (avoiding an unreviewed dependency); documented as owner option |
| Build reproducibility | clean-checkout qualification (install → generate → push → build → run → real render/export workflow 6/6) | VERIFIED (`scripts/qualify-clean-checkout.sh`, log `m34-clean-qual.log`) |
| Generated-artifact hygiene | rsync exclude list + `git status` review before publication; test scratch DBs live in OS tmp; `download/` artifacts are not committed | verified at publication |
| License metadata | available via lockfile; no license scanner added (no flagged license types encountered in the dependency set) | owner option for a formal audit |

**Honest limitation:** a zero-finding scan is NOT a security proof. The claim supported by this milestone is narrower: no known CVEs in the dependency set, the specified regression suites pass, and the secrets discipline holds in the audited tree.

## 4. Security regression tests (E4 — run)

| Suite | Result |
|---|---|
| `test-m31-security` (HTTP boundaries) | **8/8** |
| `test-m19-security` (21 HTTP boundary cases, restored) | **21/21** |
| `test-m22-security` (auth/token/revocation/canary, restored) | **18/18** |
| `test-m23-security-release` (release checks incl. OSV invocation, restored) | **8/8** |
| `test-m30-collab` (guest scoping, restored) | **13/13** |
| Archive path/entry safety (M29 suites) | in regression batch |
| Unauthorized/cross-project/guest-escalation/SSRF/malformed-media/consent cases | covered by the suites above; malformed media additionally by M34 R1 |

## 5. Findings

**No new vulnerabilities discovered in M34.** Observations recorded for the owner (no code change required now):

1. Legacy hardcoded dev-DB URLs in test suites (fixed in M34 via `scripts/legacy-fixture.ts` — the suites can no longer touch the development database by construction).
2. `bun pm scan` needs a scanner package if the owner wants a second automated scanner — an add-on decision, not a gap in the current qualification.
3. Production deployments should keep `RATE_LIMIT_SCALE` at 1 (default) and run `NODE_ENV=production` (silences Prisma query logging) — documented in the environment matrix and operations manual.
