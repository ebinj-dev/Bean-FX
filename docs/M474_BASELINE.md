# M47.4 BASELINE — recorded before any change

- Fetched `origin/main` on 2026-11-27.
- **Verified baseline: `fcf65df79d257b0196e5db312aa5e1a758ba8a30`** — exactly the expected SHA
  (Merge pull request #44 from ebinj-dev/feat/m472-release-integrity, merged 2026-11-27T12:55:46Z).
- PR #44 (M47.2 + M47.3: release integrity, real production journey, dependency reproducibility)
  is MERGED into main; no subsequent commits beyond the merge.
- Branch `feat/m474-release-gate-security-proof` created from `fcf65df` in this worktree.
- Pre-existing uncommitted changes: the main workspace checkout carries one stale workspace-local
  deletion (`src/app/api/media/upload/[uploadId]/route.ts`, workspace-local only, never committed);
  it predates M47.1 and is preserved untouched. No other uncommitted work exists.

## Preflight inventory

- **GitHub Actions**: none. `.github/workflows/` does not exist — there is no CI to extend; the
  canonical M47.4 workflow will be the repository's first (documented in `docs/M474_CI.md`).
- **Branch protection**: `main` is NOT protected (GitHub API: "Branch not protected", 404).
  No repository-level settings will be changed from this workspace; owner steps are documented.
- **Package scripts** (package.json): `dev`, `build` (`next build --webpack`), `start`, `lint`
  (`eslint .`), `db:push`/`db:generate`/`db:migrate`/`db:reset`. No `test` script — the test
  suites run via `bun test scripts/*.test.ts` and regression scripts via `bun run scripts/*.ts`.
- **Lockfiles**: `package-lock.json` (npm, regenerated + override in M47.3-C, plain `npm ci` verified)
  and `bun.lock` (bun, `--frozen-lockfile` verified) coexist; CI must respect both.
- **Security test infrastructure**: `scripts/test-m473-security.test.ts` (10 tests, all executed
  against a live server) — strengthened in WORKSTREAM A to close evidence gaps.
- **Rendering/regression suites**: `scripts/test-m472-render-inputs.test.ts` (M46.1 mapping +
  real-media matrix), `scripts/test-m472-e2e-journey.test.ts` (full journey), `scripts/test-m18-parity.ts`
  (15/15 pixel parity), `scripts/verify-m37-graph.ts` (golden graphs), `scripts/test-m16-core.test.ts`,
  `scripts/test-m472-dependency-audit.test.ts`, `scripts/test-m472-registration.test.ts`.
- **Audit/legal artifacts**: `docs/legal/generated/dependency-audit.json`,
  `docs/legal/generated/sbom.cdx.json`, `THIRD_PARTY_NOTICES.md`, `docs/legal/generated/open-source-inventory.md`
  (regenerated in M47.3 on the corrected lockfile — not modified again unless dependency data changes).
