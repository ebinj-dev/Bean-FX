#!/usr/bin/env bash
# One-command M8 push (persistent credential; plain fast-forward push, never force).
# Fresh clone at the remote tip → overlay M8 set → secret scan → commit →
# push ONLY feature/ai-creative-studio → verify remote SHA + main untouched.
set -euo pipefail
SRC=/home/z/my-project
AUTH="$SRC/scripts/git-cred-helper.sh"
BRANCH=feature/ai-creative-studio
CLONE=/tmp/beanfx-push-m8

bash "$SRC/scripts/gh-auth-restore.sh" || { echo "FATAL: GitHub authentication not ready"; exit 1; }
test -x "$AUTH" || { echo "FATAL: credential helper $AUTH missing"; exit 1; }

rm -rf "$CLONE"
git clone -q -c credential.helper="!$AUTH" "https://github.com/ebinj-dev/Bean-FX.git" "$CLONE"
cd "$CLONE"
echo "=== tips before push ==="
git ls-remote origin refs/heads/"$BRANCH" refs/heads/main | cat
git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
BASE=$(git rev-parse HEAD)
echo "branch tip before push: $BASE"

bash "$SRC/scripts/overlay-m8.sh" "$CLONE"

if git status --porcelain | grep -q .; then
  echo "=== secret scan (M8 set) ==="
  if git diff --name-only "$BASE" | while read -r f; do
        case "$f" in *.ttf) continue;; esac
        grep -lE "gho_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9]{20,}|BEGIN (RSA|OPENSSH) PRIVATE KEY" "$f" 2>/dev/null
      done | grep -q .; then
    echo "SECRET SCAN FAILED — aborting push"; exit 1
  fi
  echo "(clean)"
  git add -A
  git -c user.name="Z User" -c user.email="z@container" commit -m "M8 (MY AI): orchestration + intelligent editing automation — LLM gateway, planner, approvals, executor, MCP server, automation API

- LLM gateway: provider-independent interface; real zai adapter (glm-4-plus,
  verified live with usage reporting); typed error normalization
  (NOT_CONFIGURED/AUTH_FAILED/RATE_LIMITED/TIMEOUT/CANCELLED/INVALID_RESPONSE),
  bounded transient retries, per-call timeouts, AbortSignal cancellation,
  secret redaction on every error path, per-call usage accounting
  (token counts as reported — no invented cost rates); no Ollama; no silent
  provider switching
- project context: bounded, text-only resolver (tracks/clips/gaps/overlaps,
  media provenance, engine results, versions, storage); context version
  powers stale-plan rejection; full media never leaves the deployment
- planner: AIPlanSchema v1 (9 typed step operations, dependency integrity
  + cycle detection, risk labels, TTL, idempotency keys); deterministic
  representation normalization before strict validation; one repair attempt
  with the ACTUAL zod violations; clearly-labeled deterministic fallback
  when no provider is configured ('NOT model reasoning'); plans persist as
  AWAITING_APPROVAL — the planner never executes anything
- approvals + executor: full lifecycle (DRAFT→…→COMPLETED/PARTIALLY_COMPLETED/
  FAILED/CANCELLED/EXPIRED); approval display with per-step risk; status
  re-check before every step; per-step bounded retries with conflict re-read;
  truthful partial-failure reporting; audit rows per step; guided steps are
  ROUTED honestly, never fake-completed; execution through REAL engine entry
  points only (M1 commands + M2 versioned persistence, M5/M6/M7 durable jobs)
- automation: hashed per-client tokens (read-only default, editing profile,
  tool allowlists); MCP-compatible JSON-RPC 2.0 server (initialize/ping/
  tools/list/tools/call; rate limits; per-call timeouts; audit for every
  attempt) verified against the OFFICIAL @modelcontextprotocol/sdk client;
  JSON-RPC automation API sharing the same 39-tool catalog (projects,
  timeline reads, media probe/metadata, validated edits with real command
  shapes, effects/keyframes/templates, engine jobs, AI plan tools, preview
  frame, export lifecycle)
- effect/template discovery generated from actual registries with honest
  per-effect preview/export support notes; unsupported list documented
- preview-frame inspection: real ffmpeg single-source frames (effect filters
  mapped), content-key cache, explicit privacy note — never uploaded anywhere
- MY AI panel: conversation with explicit mode labels (LLM vs rules),
  plan preview/approve/execute/cancel, execution results, provider health +
  token usage, automation-token manager (secret shown once)
- Prisma: additive models Conversation/ConversationMessage/AIPlan/
  AutomationToken/AutomationAudit/AIUsage (+User/Project relations, indexes)
- tests: 18 suites / 0 failures via scripts/run-all-tests.sh — myai-gateway
  7/7 (REAL provider run recorded), myai-planner 15/15, automation-mcp 10/10
  (real MCP client), automation-api 11/11; live LLM planner evidence in
  docs/M8_MY_AI_ORCHESTRATION.md; M1-M7 regressions all green
- Concat-inspired capabilities implemented independently (AGPL boundary
  documented in docs/M8_MY_AI_ORCHESTRATION.md — no code/algorithms/assets
  copied; no compatibility claim with Concat's engine)
- gates: tsc clean, eslint --max-warnings=0, prisma validate, production build"
  SHA=$(git rev-parse HEAD)
else
  SHA=$(git rev-parse HEAD)
  echo "no diff after overlay — nothing to commit"
fi

git push origin "$BRANCH"
echo "=== pushed local SHA: $SHA ==="
sleep 2
REMOTE_TIP=$(git ls-remote origin refs/heads/"$BRANCH" | awk '{print $1}')
REMOTE_MAIN=$(git ls-remote origin refs/heads/main | awk '{print $1}')
echo "remote $BRANCH tip: $REMOTE_TIP"
echo "remote main tip:   $REMOTE_MAIN"
[ "$REMOTE_TIP" = "$SHA" ] && echo "VERIFIED: remote branch tip == pushed commit" || { echo "MISMATCH between pushed and remote tip"; exit 1; }
echo "=== pushed files ==="
git diff --name-only "$BASE" HEAD
echo "PUSH_COMPLETE"
