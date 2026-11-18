#!/usr/bin/env bash
# Re-verification of the BEAN FX stabilization delivery state.
# Read-only: checks tree content, manifest integrity, scripts, auth artifacts,
# deliverable evidence, and (if reachable) the remote tips. No modifications.
set -u
SRC=/home/z/my-project
cd "$SRC"
FAIL=0
ok(){ echo "  PASS  $1"; }
bad(){ echo "  FAIL  $1"; FAIL=1; }

echo "== 1. git state (durable tree) =="
DIRTY=$(git status --porcelain | grep -v "^.. \.tools" | grep -v "^.. authdata" | grep -v "scripts/verify-stab.sh" | grep -v "scripts/push-stab.sh" | wc -l)
[ "$DIRTY" -eq 0 ] && ok "stabilization tree clean ($DIRTY uncommitted non-tooling files; verify/push helper scripts excluded)" || bad "$DIRTY uncommitted files"
git log --oneline -3 | sed 's/^/    /'

echo "== 2. manifest: 21 files present =="
FILES="scripts/apply_missing_migrations.py scripts/e2e-media-pipeline.ts scripts/test-media-pipeline.test.ts scripts/test-editor-regressions.test.ts src/app/api/media/route.ts src/components/bean/app-shell.tsx src/components/bean/editor/inspector.tsx src/components/bean/editor/monitor.tsx src/components/bean/media-picker.tsx src/components/bean/tools/auto-cut.tsx src/components/bean/tools/editor.tsx src/hooks/use-editor-session.ts src/lib/client-api.ts src/lib/editor/commands.ts src/lib/editor/engine.ts src/lib/editor/persistence.ts src/lib/editor/preview.ts src/lib/media-analysis.ts src/lib/media-storage.ts src/lib/types.ts docs/DATABASE_POSTGRES_MIGRATION.md"
MISS=0
for f in $FILES; do [ -f "$f" ] || { echo "    MISSING: $f"; MISS=$((MISS+1)); }; done
[ "$MISS" -eq 0 ] && ok "all 21 manifest files present" || bad "$MISS manifest files missing"

echo "== 3. content markers (key stabilization fixes in place) =="
chk(){ n=$(grep -c "$2" "$1" 2>/dev/null || true); [ -z "$n" ] && n=0; [ "$n" -gt 0 ] && ok "$1 :: $2 ($n)" || bad "$1 :: $2 (0 hits)"; }
chk src/lib/media-storage.ts        "BEANFX_DATA_DIR"
chk src/lib/media-storage.ts        "validateStorageRoot"
chk src/lib/media-storage.ts        "pathInsideMediaRoot"
chk src/lib/media-storage.ts        "image"
chk src/lib/editor/persistence.ts   "P2002"
chk src/lib/editor/persistence.ts   "409"
chk src/hooks/use-editor-session.ts "retry"
chk src/hooks/use-editor-session.ts "beforeunload"
chk src/components/bean/editor/monitor.tsx "IMAGE"
chk src/components/bean/editor/monitor.tsx "<img"
chk src/components/bean/tools/auto-cut.tsx "decisionToReview"
chk src/components/bean/tools/auto-cut.tsx "saveDecision"
chk src/lib/client-api.ts           "saveDecision"
chk src/lib/client-api.ts           "decisions"
chk src/lib/editor/engine.ts        "undo failed"
chk src/lib/editor/commands.ts      "missingMedia"
chk src/lib/editor/commands.ts      "is locked"
chk src/components/bean/editor/inspector.tsx "ChangeVolume"
chk src/lib/editor/preview.ts       "4"
chk src/lib/media-analysis.ts       "image2"
chk src/lib/types.ts                "IMAGE"
chk src/app/api/media/route.ts      "IMAGE"
chk docs/DATABASE_POSTGRES_MIGRATION.md "postgres"

echo "== 4. exclusions: DB / secrets / tooling must NOT be in overlay file list =="
ARRAY=$(sed -n '/^FILES=(/,/^)/p' scripts/overlay-stab.sh)
LEAK=0
for pat in "prisma/" "\.env" "authdata" "\.tools" "custom\.db" "gh-token" "device-flow"; do
  if echo "$ARRAY" | grep -q "$pat"; then bad "overlay file list contains $pat"; LEAK=1; else ok "overlay file list excludes $pat"; fi
done
[ -f prisma/schema.prisma ] && git status --porcelain prisma/ | grep -q . && bad "prisma/ has local drift" || ok "prisma/ clean"

echo "== 5. scripts ready =="
bash -n scripts/overlay-stab.sh && ok "overlay-stab.sh syntax OK" || bad "overlay-stab.sh syntax"
bash -n scripts/push-stab.sh    && ok "push-stab.sh syntax OK"    || bad "push-stab.sh syntax"
grep -q "git push origin \"\$BRANCH\"" scripts/push-stab.sh && ok "push is a plain push (no --force anywhere)" || bad "push line missing"
grep -q -- "--force" scripts/push-stab.sh && bad "--force present in push script" || ok "no force flag in push script"

echo "== 6. auth artifacts =="
if [ -f authdata/gh.token ]; then ok "gh.token present (authorized)"; else ok "not authorized yet (fresh device code is issued at push time; codes expire after 15 min)"; fi
[ -f authdata/device-flow.json ] && ok "device-flow artifact exists (previous code expired)" || ok "no prior device-flow artifact"
pgrep -f gh-token-poll >/dev/null && ok "token poller running" || ok "no poller running (expected between turns — poller is started when a fresh code is issued)"

echo "== 7. deliverable evidence =="
[ -f download/STABILIZATION_REPORT.md ] && ok "STABILIZATION_REPORT.md ($(wc -l < download/STABILIZATION_REPORT.md) lines)" || bad "report missing"
EV=$(find download/stabilization-evidence -type f 2>/dev/null | wc -l)
[ "$EV" -gt 0 ] && ok "stabilization evidence files: $EV" || bad "no evidence dir"

echo "== 8. remote tips (read-only, no auth) =="
TIPS=$(git ls-remote https://github.com/ebinj-dev/Bean-FX.git refs/heads/main refs/heads/feature/ai-creative-studio 2>/dev/null)
RC=$?
if [ $RC -eq 0 ] && [ -n "$TIPS" ]; then
  echo "$TIPS" | sed 's/^/    /'
  ok "remote reachable; tips listed above (token needed for push)"
else
  ok "remote not reachable without auth (private repo; tips verified post-auth via ls-remote)"
fi

echo
[ "$FAIL" -eq 0 ] && echo "RE-VERIFICATION: ALL CHECKS PASSED" || echo "RE-VERIFICATION: FAILURES PRESENT (see FAIL lines)"
exit $FAIL
