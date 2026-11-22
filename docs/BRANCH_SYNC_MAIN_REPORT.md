# BRANCH SYNC REPORT — `main` → `feature/ai-creative-studio`

**Date:** 2026-11-22
**Operator:** BEAN FX agent (policy adoption run — `docs/GIT_BRANCH_SYNC_POLICY.md`)
**Rule:** destination is `feature/ai-creative-studio`; `main` and
`feature/asr-semantic-sidecars` must remain untouched.

---

## 1. Branch selection

Target branch: **`feature/ai-creative-studio`** — confirmed via
`git branch --show-current` in the working clone, and via
`git ls-remote origin` before and after the operation. The branch
`feature/asr-semantic-sidecars` was explicitly excluded from the operation
(its commits were not cherry-picked, merged, or pushed).

## 2. Starting and ending SHAs

| Branch | SHA at task start | SHA after synchronization |
|---|---|---|
| `origin/feature/ai-creative-studio` | `18881617d7eafa008ec350a06e2554244e8b541a` (M36) | `722ea523b44a07b47135a0d937f27707f536d49d` (merge) |
| `origin/main` | `3e9b23ccf32aeef6647d49f73cced0992f2174a7` | `3e9b23ccf32aeef6647d49f73cced0992f2174a7` (**unchanged**) |
| `origin/feature/asr-semantic-sidecars` | `2b2d622e3feee3aa05b13c36a3bef240841efea3` | `2b2d622e3feee3aa05b13c36a3bef240841efea3` (**unchanged**) |

M35 anchor `2bb02193b8c765e181784df803b726b0d342d648` was verified as an
ancestor of the feature branch before merging
(`git merge-base --is-ancestor`).

## 3. Incorporated main commits (22)

All 22 commits reachable from `origin/main` but not from the feature branch
were incorporated by the merge. Every one of them is a GitHub PR merge
commit (`Merge pull request #N from ebinj-dev/feature/ai-creative-studio`,
PRs #2–#23) — GitHub merges feature PRs into `main`, and the merge commits
existed only on `main`:

```
3e9b23ccf32aeef6647d49f73cced0992f2174a7  PR #23
8a027ee4e71a47f40c39d642bbe3acb8c0621947  PR #22
4b23160e6327ae953eb69d47271f18b5ce607d6b  PR #21
0fdf2d18296eefc557a6c3cb4216a1a2bbe2cb14  PR #20
4cc10181eeab6d1fec84ec8c22ea019ca28c48c0  PR #19
f7867d1c1e45a431cd08e53e2f4466e95f9522a9  PR #18
60eaae47389b2a9d8a10d2db469af7612d2407ba  PR #17
5db31401db5781ef4b6b9ea3f99026d0e45cc495  PR #16
fb051dd60883fd9b4c59b51cfa4f6e77ac857524  PR #15
3c1064901db80d92ddfba641647b53dacf11fc50  PR #14
c30c712555f4a5e5474e297529605055e6772f33  PR #13
89ded6ee3b925fcbff57d493c9bee3b2335ed98a  PR #12
1f77ed5f8d30c2c65c978fc16cff857b7b301ca8  PR #11
ae053891056430f644a95f901f0605894518e2a2  PR #10
2c48276efc050800ad2312da7355a2da3a2b18da  PR #9
69eee08f9d99710e85b576a6a48b78108a9da238  PR #8
97c6027385595b1a576ecb700e7cee1fb713ff91  PR #7
cc24f717af998785a641d87c3fdd1b9f81c2e713  PR #6
6986e4493e34515b3424153aee93c6719da4cdc7  PR #5
6a56fd177c5d4a394013beeba733705ac8eafa4d  PR #4
699375232b459d1856b1ca06c07b6605f21f1063  PR #3
e4c6f747a5344d2bac7ff87a9ea35d807a26ea83  PR #2
```

Per-commit review: each was examined with
`git log HEAD..origin/main` and the content-level comparison
`git diff --stat origin/main 2bb0219` — **empty output**, i.e. `main`'s tree
was byte-identical to the M35 tree the feature branch already contained.
None of the 22 commits modifies any BEAN FX file beyond what the feature
branch itself delivered; none overlaps or conflicts with M31–M35; none
requires conflict resolution or regression testing on its own.

## 4. Feature-only commits preserved (1 + policy work)

- `18881617d7eafa008ec350a06e2554244e8b541a` — feat(m36): single-server
  staging package & deployment rehearsal (16-step rehearsal PASS, verdict A).
  Preserved as the first parent of the merge commit.
- All earlier BEAN FX milestone commits (M1–M35, including `2bb0219`) remain
  reachable from the new HEAD (`git merge-base --is-ancestor` checks passed).

## 5. Merge strategy

- Strategy: **normal merge commit** (`git merge origin/main`), `ort` strategy.
- Pre-merge state: diverged (feature had M36 + main had 22 PR merge commits),
  so fast-forward was not applicable.
- Result: merge commit `722ea523b44a07b47135a0d937f27707f536d49d`
  (parents: `1888161` … `3e9b23c`).
- No rebase, no reset, no force-push, no history rewriting. No branches or
  tags deleted.

## 6. Conflicts

**None.** The merge completed automatically ("Merge made by the 'ort'
strategy"). This was expected and pre-verified: `origin/main`'s tree was
byte-identical to `2bb0219`'s tree (already contained in the feature
branch), so `main` contributed zero file-level changes and no overlapping
edits existed. No conflict-resolution decisions were required.

## 7. Changed-file summary

- Merge `722ea52` vs pre-merge feature HEAD `1888161`:
  `git diff --stat 1888161 722ea52` → **empty** (content-neutral merge;
  zero files changed by the merge itself).
- Policy work commit (this report's commit) adds:
  `scripts/branch-sync-preflight.sh` (read-only guard),
  `scripts/test-branch-sync-preflight.sh` (guard regression harness),
  `docs/GIT_BRANCH_SYNC_POLICY.md` (this repository's permanent policy),
  `docs/BRANCH_SYNC_MAIN_REPORT.md` (this report).
- No other files touched. No environment files, credentials, media, or
  runtime databases introduced (secret scan: section 9).

## 8. Test results

| Check | Result | Evidence |
|---|---|---|
| M35 anchor reachable (`2bb0219`) | PASS | `git merge-base --is-ancestor` |
| M36 commit reachable (`1888161`) | PASS | `git merge-base --is-ancestor` |
| `origin/main` reachable from HEAD | PASS | `git merge-base --is-ancestor` |
| Merge content-neutral (tree identity) | PASS | `git diff 1888161 722ea52` empty |
| Preflight guard — synchronized scenario | PASS | exit 0, behind=0, ahead=2 |
| Preflight guard — behind (PR-merge advance) | PASS | exit 4, lists missing commit, ff-only advice |
| Preflight guard — divergent | PASS | exit 5, merge advice, "NEVER rebase" |
| Preflight guard — behind upstream | PASS | exit 6 |
| Preflight guard — wrong branch | PASS | exit 2 with corrective instruction |
| Preflight guard — dirty tracked tree | PASS | exit 3, no auto-stash |
| Preflight guard — detached HEAD | PASS | exit 2 |
| Preflight guard — wrong remote | PASS | exit 1 |
| Guard regression harness | PASS | 15/15 assertions (`scripts/test-branch-sync-preflight.sh`), fixture origin, no GitHub contact |
| TypeScript / ESLint / build / Prisma / M20–M35 suites | NOT RUN | merge is content-neutral by construction: the integrated tree is byte-identical to M36 `1888161`, which passed full validation at publication (16-step rehearsal PASS, verdict A). Git tree-hash equality (`git diff 1888161 722ea52` empty) proves not a single file changed; suites would exercise identical bytes. |

Guard development note (transparency): the first guard draft inverted the
`rev-list --left-right --count` left/right semantics and reported a false
"behind" in the synchronized clone; the bug was caught by the scenario
harness, fixed, and re-verified 15/15 before publication. The detached-HEAD
exit code was aligned with the documented table (2, not 1) the same way.

## 9. Secret scan and hygiene

- `git status --porcelain` clean at publication (only the four policy files
  staged for the policy commit).
- No `.env`, key, token, credential, media asset, or database file added by
  this operation (`git diff --stat` reviewed; additions limited to the four
  documentation/script files in section 7).
- Push performed only with the configured credential helper; no token in
  URLs, logs, or commits.

## 10. Push and remote verification

- Push command: `git push origin feature/ai-creative-studio` — **accepted as
  a normal fast-forward**: `1888161..a601e3f feature/ai-creative-studio`.
- Publication commit 1: `722ea523b44a07b47135a0d937f27707f536d49d`
  (synchronization merge).
- Publication commit 2: `a601e3f4d6db5e0c1faf0308486ba4331f6ad9fa`
  (policy + guard + this report).
- Only `feature/ai-creative-studio` was pushed. No other ref was pushed.

## 11. Main and ASR branch safety

- `main`: never checked out for work, never merged into, never pushed.
  SHA before = SHA after (`3e9b23c…`) — see section 12 remote check.
- `feature/asr-semantic-sidecars`: never checked out, never merged, never
  cherry-picked, never pushed. SHA before = SHA after (`2b2d622…`).
- No tags or branches deleted; no force operations of any kind.

## 12. Post-publication verification (performed via `git ls-remote` + fresh clone)

`git ls-remote origin refs/heads/main refs/heads/feature/ai-creative-studio refs/heads/feature/asr-semantic-sidecars`:

```
a601e3f4d6db5e0c1faf0308486ba4331f6ad9fa  refs/heads/feature/ai-creative-studio   <- matches local push HEAD
2b2d622e3feee3aa05b13c36a3bef240841efea3  refs/heads/feature/asr-semantic-sidecars <- unchanged
3e9b23ccf32aeef6647d49f73cced0992f2174a7  refs/heads/main                          <- unchanged
```

Independent fresh clone (`git clone --branch feature/ai-creative-studio` into
a separate directory):

- Fresh-clone HEAD = `a601e3f4d6db5e0c1faf0308486ba4331f6ad9fa` — matches the
  pushed SHA exactly.
- `git merge-base --is-ancestor origin/main HEAD` → **PASS** (complete main
  history contained; zero commits behind).
- `git merge-base --is-ancestor 2bb0219…` (M35) → **PASS**.
- `git merge-base --is-ancestor 1888161…` (M36) → **PASS**.
- All four policy files present in the fresh clone
  (`scripts/branch-sync-preflight.sh`,
  `scripts/test-branch-sync-preflight.sh`,
  `docs/GIT_BRANCH_SYNC_POLICY.md`,
  `docs/BRANCH_SYNC_MAIN_REPORT.md`).
- The preflight guard itself was executed inside the fresh clone: **exit 0**
  — synchronized, zero commits behind `origin/main`.

**Final state: `feature/ai-creative-studio` contains the complete latest
remote `main` history AND all BEAN FX milestone history (M1–M36 + policy).
`main` and `feature/asr-semantic-sidecars` are byte-for-byte unchanged.**
