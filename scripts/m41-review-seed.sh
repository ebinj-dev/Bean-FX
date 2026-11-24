#!/usr/bin/env bash
# BEAN FX — M41 Phase D.2: seed review revisions + guest link on the :3123 QA
# server (isolated scratch). Creates:
#   revision 1 — current render params (ranged preview badge expected)
#   revision 2 — render params downgraded to LEGACY shape (no startFrame/
#                endFrame) on the scratch DB, so the badge must stay unknown
#   a guest link for each
# Prints M41_REV1 / M41_REV2 / M41_TOKEN1 / M41_TOKEN2 / M41_GUEST_URLs.
set -uo pipefail
cd "$(dirname "$0")/.."

source /tmp/m41-qa-server.env 2>/dev/null || true
BASE="${BASE:-http://127.0.0.1:3123}"
PROJECT_ID="${PROJECT_ID:?run scripts/run-m40-visual-qa-server.sh first}"
CJ=/tmp/m40-qa-admin.cookies
QADB="$(ls /tmp/beanfx-m40-qa-*.db 2>/dev/null | head -1)"
[ -n "$QADB" ] || { echo "FATAL: scratch DB not found"; exit 3; }

echo "[d2] creating revision 1 (current render params)…"
R1=$(curl -fsS -b "$CJ" -H 'Content-Type: application/json' -d '{"title":"M41 guest badge QA — session 1","approvalPolicy":"ANY"}' "$BASE/api/projects/$PROJECT_ID/reviews")
REV1=$(printf '%s' "$R1" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('revision', d).get('id', ''))")
[ -n "$REV1" ] || { echo "FATAL: revision1 create failed: $(printf '%s' "$R1" | head -c 200)"; exit 3; }
echo "[d2] revision1: $REV1 — waiting for its preview render…"

for i in $(seq 1 40); do
  ST=$(curl -fsS -b "$CJ" "$BASE/api/reviews/$REV1" | python3 -c "import json,sys; d=json.load(sys.stdin); r=d.get('revision', d); print(r.get('status'))" 2>/dev/null)
  [ "$ST" = "READY_FOR_REVIEW" ] || [ "$ST" = "IN_REVIEW" ] && break
  sleep 3
done
echo "[d2] revision1 status: $ST"

echo "[d2] creating guest link for revision 1…"
L1=$(curl -fsS -b "$CJ" -H 'Content-Type: application/json' -d '{"permission":"COMMENT","ttlHours":168}' "$BASE/api/reviews/$REV1/links")
TOKEN1=$(printf '%s' "$L1" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('token') or d.get('link',{}).get('token',''))")
echo "[d2] token1: ${TOKEN1:0:8}…"

echo "[d2] creating revision 2 (session 2; supersedes session 1 open state)…"
R2=$(curl -fsS -b "$CJ" -H 'Content-Type: application/json' -d '{"title":"M41 guest badge QA — session 2 (legacy params)","approvalPolicy":"ANY"}' "$BASE/api/projects/$PROJECT_ID/reviews")
REV2=$(printf '%s' "$R2" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('revision', d).get('id', ''))")
[ -n "$REV2" ] || { echo "FATAL: revision2 create failed: $(printf '%s' "$R2" | head -c 200)"; exit 3; }
for i in $(seq 1 40); do
  ST2=$(curl -fsS -b "$CJ" "$BASE/api/reviews/$REV2" | python3 -c "import json,sys; d=json.load(sys.stdin); r=d.get('revision', d); print(r.get('status'))" 2>/dev/null)
  [ "$ST2" = "READY_FOR_REVIEW" ] || [ "$ST2" = "IN_REVIEW" ] && break
  sleep 3
done
echo "[d2] revision2 status: $ST2"

echo "[d2] downgrading revision2's render params to LEGACY shape (scratch DB, isolated)…"
RENDER2=$(curl -fsS -b "$CJ" "$BASE/api/reviews/$REV2" | python3 -c "import json,sys; d=json.load(sys.stdin); r=d.get('revision', d); print(r.get('renderId') or r.get('renderJobId') or '')")
node - "$QADB" "$REV2" "$RENDER2" <<'EOF'
const { PrismaClient } = require("@prisma/client");
// `node - a b c` → argv.slice(2) = [a, b, c]
const [dbPath, revId, renderId] = process.argv.slice(2);
const db = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
(async () => {
  // Find the revision's preview render row and strip range fields to the
  // pre-M39 shape (no startFrame/endFrame keys) — legacy rows must yield
  // previewRange=null, never a guessed range.
  const rev = await db.reviewRevision.findUnique({ where: { id: revId } });
  if (!rev) { console.error("revision not found"); process.exit(1); }
  const jobs = renderId
    ? await db.mediaJob.findMany({ where: { id: renderId } })
    : await db.mediaJob.findMany({ where: { projectId: rev.projectId, type: "RENDER_TIMELINE" }, orderBy: { createdAt: "desc" }, take: 3 });
  let patched = 0;
  for (const j of jobs) {
    if (!j.paramsJson) continue;
    const p = JSON.parse(j.paramsJson);
    if (!("startFrame" in p) && !("range" in p)) continue;
    const legacy = { ...p };
    delete legacy.startFrame; delete legacy.endFrame; delete legacy.range;
    await db.mediaJob.update({ where: { id: j.id }, data: { paramsJson: JSON.stringify(legacy) } });
    patched++;
  }
  console.log(`legacy-downgrade: patched ${patched} render row(s)`);
  await db.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
EOF

echo "[d2] creating guest link for revision 2…"
L2=$(curl -fsS -b "$CJ" -H 'Content-Type: application/json' -d '{"permission":"COMMENT","ttlHours":168}' "$BASE/api/reviews/$REV2/links")
TOKEN2=$(printf '%s' "$L2" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('token') or d.get('link',{}).get('token',''))")

{
  echo "M41_REV1=$REV1"
  echo "M41_REV2=$REV2"
  echo "M41_TOKEN1=$TOKEN1"
  echo "M41_TOKEN2=$TOKEN2"
  echo "M41_GUEST_URL1=$BASE/#/review/$TOKEN1"
  echo "M41_GUEST_URL2=$BASE/#/review/$TOKEN2"
} | tee /tmp/m41-review-seed.env
echo "[d2] DONE — guest URLs above. Now walk them in the browser WITHOUT cookies."
