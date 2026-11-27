# M47.4 — RELEASE GATE SUMMARY

`docs/M474_RELEASE_GATE.md`

Legend: **IMPLEMENTED** (exists in the repo) → **TESTED** (the test was actually executed on this
branch) → **VERIFIED** (supported by direct evidence captured in this milestone) →
**OWNER APPROVAL REQUIRED** (a decision the coding agent cannot make) → **BLOCKED** (a required
check is unsatisfied).

## Release checklist

| # | Item | State | Evidence |
| - | ------------------------------- | ------------------------------ | -------- |
| 1 | Production rendering integrity (M46.1) | **TESTED** (matrix unchanged; parity re-run) | `scripts/test-m472-render-inputs.test.ts` + `scripts/test-m18-parity.ts` (15/15 effects pixel-verified on the export path) + `scripts/verify-m37-graph.ts` executed on this branch; renderer untouched since `8348454` (diff-empty). |
| 2 | Real end-to-end production journey | **TESTED** on this branch (13 stages SUCCEEDED in M47.3 on the same renderer/runner files; journey suite re-executed in M47.4 verification) | `scripts/test-m472-e2e-journey.test.ts` 4/4; stage transitions + render/download/playback evidence in `download/m473-evidence/` and the M47.4 verification run log. |
| 3 | Authentication and resource ownership | **VERIFIED** | M47.4 security suite 16/16 with DB-state proof (`docs/M474_SECURITY_EVIDENCE.md`); registration acknowledgement enforced server-side (M47.2-C, still passing). |
| 4 | Export authorization | **VERIFIED** | Real victim-owned export: owner byte-identical download; attacker EXACT `{"error":"Export not found."}`; anonymous exact 401; export intact after attempts (A2 tests). |
| 5 | Dependency reproducibility | **VERIFIED** | Plain `npm ci` isolated pass + `bun install --frozen-lockfile` pass (M47.3-C contract re-asserted by the M47.2 audit tests on this branch); lockfile counts 1007/584/423, 0 unresolved licenses. CI job `verify-lockfiles` will enforce per-PR once the workflow lands. |
| 6 | License and distribution review | **OWNER APPROVAL REQUIRED** | `docs/legal/M474_DISTRIBUTION_DECISIONS.md`: FFmpeg (D1), nodebox chain (D2), libvips/sharp (D3) — evidence recorded, decisions reserved to the owner; SBOM/notices preserved. |
| 7 | Voice-language validation | **OWNER APPROVAL REQUIRED / BLOCKED for Tamil+Tanglish** | `docs/M474_VOICE_VALIDATION.md` pack delivered; English tested in prior milestones; Tamil/Tanglish remain UNVERIFIED until native-speaker runs pass (no speakers available in this environment). |
| 8 | Legal policies and terms | **OWNER APPROVAL REQUIRED** | Policies remain DRAFT by design until owner approval (M46/M47 policy state unchanged); no clearance claimed for FFmpeg GPL, nodebox, or Tamil/Tanglish. |
| 9 | GitHub Actions | **BLOCKED (publication)** | Workflow implemented + YAML/paths validated, but the workspace token lacks the `workflow` scope — GitHub rejects creating `.github/workflows/*`; owner publishes (one re-auth + push, see `docs/M474_CI.md`). Until then: no CI runs exist. |
| 10 | Main branch protection | **BLOCKED (owner settings)** | API confirms `main` is NOT protected; exact owner-side steps documented in `docs/M474_CI.md`. Agent cannot (and must not) change repository settings. |
| 11 | Deployment prerequisites | **OWNER APPROVAL REQUIRED** | Documented requirements: operator-installed FFmpeg/ffprobe (GPL build) on PATH, `ZAI_API_KEY` for provider stages (else deterministic-draft mode discloses itself), SMTP_URL optional with graceful mailer absence, SQLite storage path sizing, rate-limit scale policy for production. |

## Item-level notes

- **Rendering**: the M46.1 renderer, production runner, timeline, job system, and approval gates are
  byte-identical to the merged M47.3 state — M47.4 changed only tests, docs, and (locally) CI.
- **Security**: 16/16 suite covers ownership, export authz, idempotency, resume/retry safety, and
  cross-user regression with exact HTTP contracts and database inspection. The suite is also the CI
  `e2e-security-and-build` job once the workflow is published.
- **Journey**: the "final principle" (instruct → approve → render → download → play → reopen the
  same project in the Editor) is demonstrated end-to-end with captured evidence (M47.3) and
  regression-covered by the journey suite in CI.

## What would move states

- #9 BLOCKED → VERIFIED: owner grants `workflow` scope (or publishes the file) and the first PR run
  goes green with the four check names.
- #10 BLOCKED → VERIFIED: owner enables branch protection with the documented required checks.
- #6/#8 → VERIFIED: owner decisions recorded in `docs/legal/M474_DISTRIBUTION_DECISIONS.md` and the
  policies move out of DRAFT.
- #7 → VERIFIED: native-speaker runs recorded per `docs/M474_VOICE_VALIDATION.md`.

## Release decision (as of this milestone)

**CONDITIONALLY READY** — the product's technical core (rendering integrity, real journey,
ownership/export security, dependency reproducibility) is implemented and tested with direct
evidence; the remaining gates are owner decisions and owner-side settings (legal clearances,
language validation, CI publication, branch protection). This is NOT a claim of commercial release
readiness: the unresolved legal (D1–D3), policy (DRAFT), and language (Tamil/Tanglish UNVERIFIED)
items remain open, and CI/branch protection are not yet active on the repository.
