# BEAN FX — PERMANENT GIT BRANCH SYNCHRONIZATION POLICY

**Status:** ACTIVE — mandatory for every BEAN FX milestone, no exceptions.
**Enforced by:** `scripts/branch-sync-preflight.sh` (read-only guard).
**Adopted:** 2026-11-22 (after `feature/ai-creative-studio` drifted 22 PR-merge
commits behind `main` between milestones).

---

## 1. Primary development branch

All BEAN FX milestone work is implemented, tested, and published on **one**
branch:

```
feature/ai-creative-studio
```

Rules that follow from this:

- Never begin milestone work without first confirming the working branch:
  `git branch --show-current` MUST print `feature/ai-creative-studio`.
- Never switch to a different feature branch silently, and never mix
  unrelated branches. Preserve separate feature branches — for example
  `feature/asr-semantic-sidecars` keeps its own history untouched.
- Never cherry-pick commits from an unrelated feature branch into this one
  without explicit authorization. The only exception allowed implicitly:
  commits that are already part of `main` (they arrive through the
  synchronization merge, not through cherry-picking).
- All pushes go to `feature/ai-creative-studio` only. `main` is updated
  exclusively through GitHub pull requests; nobody pushes to `main` from a
  milestone workspace.

## 2. The mandatory workflow (every milestone, no exceptions)

Every BEAN FX development prompt and execution MUST follow this order:

```
SYNC MAIN → VERIFY TARGET BRANCH → IMPLEMENT → TEST → FETCH MAIN AGAIN
→ SYNC IF ADVANCED → REGRESSION → COMMIT → PUSH → VERIFY REMOTE
```

Branch synchronization is NOT optional housekeeping. It is a milestone
acceptance requirement: a milestone is not complete if the branch it was
built on is missing commits from `main`.

### 2.1 Pre-milestone synchronization (before the first line of new code)

1. Verify the working branch is exactly `feature/ai-creative-studio`.
2. Fetch all remote references: `git fetch origin --prune`.
3. Record the current SHAs:
   ```bash
   git rev-parse origin/main
   git rev-parse origin/feature/ai-creative-studio
   ```
4. Run the preflight guard (it performs steps 1–4 and fails on drift):
   ```bash
   bash scripts/branch-sync-preflight.sh
   ```
5. If the guard exits non-zero, follow its printed corrective instructions
   (section 6) and re-run until it exits 0.
6. Only then start implementing the milestone.

Never knowingly begin a new milestone on an outdated feature branch.

### 2.2 Pre-publication synchronization (before every commit-and-push)

`main` can advance while you work (e.g. GitHub merges a PR from an earlier
milestone). Immediately before committing and pushing:

1. `git fetch origin --prune`
2. `bash scripts/branch-sync-preflight.sh` — must exit 0.
3. If `main` advanced during development, merge the new commits into the
   feature branch (section 6), re-run the affected regression tests, and
   only then commit and push.
4. Do not postpone synchronization to the next milestone. A publication
   behind `main` is a failed publication.

## 3. The preflight guard

```bash
bash scripts/branch-sync-preflight.sh          # full check (fetches)
bash scripts/branch-sync-preflight.sh --no-fetch   # offline inspection only
```

What it verifies (in order): repository + expected remote (`ebinj-dev/Bean-FX`)
→ current branch is `feature/ai-creative-studio` → uncommitted tracked
changes → fetch → local branch vs its upstream → ahead/behind vs `origin/main`
→ lists every missing main commit.

Exit codes:

| Code | Meaning | Action |
|---|---|---|
| 0 | Synchronized — safe to proceed | continue work / publish |
| 1 | Remote or fetch failure | fix network/credentials, re-run |
| 2 | Wrong branch or detached HEAD | `git checkout feature/ai-creative-studio` |
| 3 | Uncommitted tracked changes | resolve deliberately (never auto-stash) |
| 4 | Behind `origin/main` (no local commits) | `git merge --ff-only origin/main` |
| 5 | Diverged from `origin/main` | normal merge commit (section 6) |
| 6 | Local branch behind its own upstream | merge `origin/feature/ai-creative-studio` first |

The guard is strictly read-only: it never merges, rebases, commits, pushes,
stashes, or modifies files. The only repository state it changes is
remote-tracking refs via `git fetch`.

The guard's behavior is regression-tested by
`scripts/test-branch-sync-preflight.sh` (synchronized / behind / divergent /
behind-upstream / wrong-branch / dirty / detached / wrong-remote — all
against a local fixture origin, never against GitHub). Run it after any
change to the guard itself.

## 4. Safe merge rules

- Fast-forward (`git merge --ff-only origin/main`) is preferred when the
  feature branch has no commits of its own.
- When the branch has its own commits and `main` advanced, integrate with a
  **normal merge commit**: `git merge origin/main`. Merge commits from PR
  integration are normal repository history, not pollution.
- **Never** rebase, never `reset --hard`, never force-push, never rewrite
  history. A rejected push is resolved by fetching and merging the new
  remote commits, then pushing again (fast-forward).
- Resolve conflicts **file by file**, after reading both implementations.
  Never resolve wholesale with "ours" or "theirs". Never delete tests or
  weaken assertions to make a merge pass. If a conflict would destroy or
  fundamentally alter existing milestone functionality and cannot be
  resolved confidently, STOP and report the exact blocker instead of
  guessing.
- Every conflict resolution must be recorded (file, both sides' intent,
  chosen resolution, reasoning) in the milestone report.

## 5. Regression requirements after synchronization

After integrating commits from `main`:

1. Inspect the full merge diff (`git diff HEAD@{1} HEAD` / merge parents).
2. Run the applicable suites — at minimum: TypeScript type-check, ESLint,
   production build, Prisma/database checks, and the milestone regression
   suites touched by the merged commits (render lifecycle, project
   integrity/portability, collaboration, Showcase Studio, provider
   readiness/variants/masking, triple-format export, storage-worker /
   installation, deployment/backup/health-check).
3. Record every result as PASS, FAIL, NOT RUN, or INFRASTRUCTURE REQUIRED.
   Do not silently skip tests; do not conceal pre-existing failures; fix
   merge-caused regressions before publishing.
4. When a merge is **content-neutral** (its tree is byte-identical to the
   pre-merge feature tree — prove with `git diff <pre-merge-sha> HEAD`
   producing empty output), the suites exercise identical bytes and may be
   recorded as NOT RUN with that justification. The tree-identity proof must
   then be included in the report.

## 6. Remote SHA verification & recovery

Verify with Git, never by GitHub's behind/ahead counter alone:

```bash
git fetch origin --prune
git rev-parse origin/main origin/feature/ai-creative-studio
git rev-list --left-right --count origin/main...origin/feature/ai-creative-studio
git log --oneline origin/feature/ai-creative-studio..origin/main   # missing commits
git log --oneline origin/main..origin/feature/ai-creative-studio   # feature-only commits
git merge-base --is-ancestor origin/main origin/feature/ai-creative-studio && echo SYNCED
```

### Recovery procedure (another contributor advanced a branch)

1. `git fetch origin --prune` and inspect what advanced
   (`git log --oneline HEAD..origin/<branch>`).
2. If it is the feature branch upstream (exit 6): merge or fast-forward it
   into the local branch first.
3. If it is `main`: integrate per section 4, run regressions per section 5.
4. Re-run the preflight guard; publish only after exit 0 with a normal
   fast-forward push of `feature/ai-creative-studio`.
5. If a push is rejected, do NOT retry blindly and never force: fetch,
   inspect, merge, re-test, push again.
6. After publishing, verify independently: `git ls-remote origin`, compare
   local/remote SHAs, and clone the branch fresh into a separate directory
   to confirm the merged history.

## 7. Prohibited operations (absolute)

```
git push --force            # never
git push --force-with-lease # never
git reset --hard            # never (throwaway test fixtures excluded)
git rebase                  # never (including interactive)
git filter-branch / history rewriting tools   # never
git branch -D <milestone branch>              # never without explicit authorization
git push origin main        # never — main changes only via GitHub PRs
git checkout <other feature branch>  # never silently
blind "ours"/"theirs" conflict resolution     # never
```

Allowed at all times: `git fetch`, fast-forward and normal merges, normal
commits, normal fast-forward pushes of `feature/ai-creative-studio`,
fresh-clone verification.

## 8. Acceptance

A milestone acceptance that skips any step of section 2 is invalid.
Final completion of any milestone REQUIRES: zero commits behind the latest
remote `main`, all existing feature-branch milestone history preserved and
reachable, remote SHAs verified, and the preflight guard exiting 0 at
publication time.
