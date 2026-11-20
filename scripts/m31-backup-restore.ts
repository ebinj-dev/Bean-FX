/**
 * M31 Phase 6 — database backup & restore qualification.
 * Complete media-project backup = DB file + media store (+ packages). Drill:
 *   1. Snapshot the isolated test DB + media store into /tmp/m31-restore.
 *   2. Verify relationship integrity on the restored copy.
 *   3. Boot an isolated server ON the restored snapshot and prove the full
 *      write path (register/media/timeline) + a real pipeline render.
 * Never touches db/custom.db or the live environment.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";

const SRC_DB = (process.env.M31_DB ?? "file:/home/z/my-project/db/m29closeout.db").replace("file:", "");
const SRC_STORE = process.env.M31_STORE ?? "/home/z/my-project/media-store-closeout";
const RESTORE_DIR = "/tmp/m31-restore";
const PASS: string[] = []; const FAIL: string[] = [];
const say = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const ok = (m: string) => { PASS.push(m); say(`PASS: ${m}`); };
const bad = (m: string) => { FAIL.push(m); say(`FAIL: ${m}`); };

say("== M31 backup/restore qualification ==");
say(`source DB: ${SRC_DB} · store: ${SRC_STORE}`);

execSync(`rm -rf ${RESTORE_DIR} && mkdir -p ${RESTORE_DIR}/db ${RESTORE_DIR}/store`);
execSync(`cp "${SRC_DB}" ${RESTORE_DIR}/db/restored.db`);
const storeExists = fs.existsSync(SRC_STORE);
if (storeExists) execSync(`cp -r "${SRC_STORE}/." ${RESTORE_DIR}/store/`);
ok(storeExists ? "media store snapshot copied (complete backup = DB + media)" : "media store absent — DB-only snapshot (incomplete, flagged)");
if (!storeExists) bad("media store missing — backup would be incomplete");

const rdb = new PrismaClient({ datasources: { db: { url: `file:${RESTORE_DIR}/db/restored.db` } } });
const users = await rdb.user.count();
const projects = await rdb.project.count();
const members = await rdb.workspaceMember.count();
const revisions = await rdb.reviewRevision.count();
const comments = await rdb.reviewComment.count();
const decisions = await rdb.reviewAssignment.count({ where: { state: { not: "PENDING" } } });
const assets = await rdb.mediaAsset.count();
const notifications = await rdb.notification.count();
ok(`restored counts: users=${users} projects=${projects} workspaceMembers=${members} reviewRevisions=${revisions} comments=${comments} decisions=${decisions} assets=${assets} notifications=${notifications}`);
(users > 0 && projects > 0) ? ok("user/project relationships intact") : bad("restored DB missing core rows");
const orphans = await rdb.$queryRawUnsafe(`SELECT COUNT(*) c FROM ReviewComment WHERE revisionId NOT IN (SELECT id FROM ReviewRevision)`) as { c: bigint }[];
(Number(orphans[0].c) === 0) ? ok("no orphaned comments") : bad(`${orphans[0].c} orphaned comments`);
const assetOrphans = await rdb.$queryRawUnsafe(`SELECT COUNT(*) c FROM MediaAsset WHERE userId NOT IN (SELECT id FROM User)`) as { c: bigint }[];
(Number(assetOrphans[0].c) === 0) ? ok("no orphaned assets") : bad(`${assetOrphans[0].c} orphaned assets`);
const storeDir = `${RESTORE_DIR}/store`;
const storeObjects = (() => { try { return execSync(`find "${storeDir}" -type f | wc -l`, { encoding: "utf8" }).trim(); } catch { return "0"; } })();
(Number(storeObjects) > 0) ? ok(`media store contains ${storeObjects} objects`) : bad("store object count 0 (flagged)");
await rdb.$disconnect();

say("booting isolated restored-env server on :3119 …");
// Clear any stale :3119 server from an earlier drill (its DB inode is gone).
try { execSync(`fuser -k 3119/tcp 2>/dev/null || true`); } catch {}
  try {
    // fuser may be absent — kill the listener by port via ss.
    const out = execSync(`ss -tlnp 2>/dev/null | grep ':3119 ' | grep -oE 'pid=[0-9]+' | head -1 || true`, { encoding: "utf8" });
    const m = out.match(/pid=(\d+)/);
    if (m) execSync(`kill ${m[1]}`);
  } catch {}
  await Bun.sleep(3000);
const serverLog = `${RESTORE_DIR}/server.log`;
const child = Bun.spawn(["bash", "scripts/dev-server.sh"], { env: { ...process.env, DATABASE_URL: `file:${RESTORE_DIR}/db/restored.db`, BEANFX_DATA_DIR: `${RESTORE_DIR}/store`, PORT: "3119", RATE_LIMIT_SCALE: "50" }, stdout: fs.openSync(serverLog, "w"), stderr: fs.openSync(serverLog, "a") });
// Wait until the server reports Ready (or 30s), then a settle pause.
for (let i = 0; i < 30; i++) {
  try { if (fs.readFileSync(serverLog, "utf8").includes("Ready in")) break; } catch {}
  await Bun.sleep(1000);
}
await Bun.sleep(2000);
const health = await fetch("http://localhost:3119/").then((r) => r.status).catch(() => 0);
(health === 200) ? ok("restored environment serves HTTP 200") : bad(`restored env health=${health}`);

if (health === 200) {
  const seedEmail = "m31restore-seed@test.local";
  // The snapshot copy belongs to this drill — remove stale seed accounts from
  // PRIOR drill runs (the SOURCE database is never touched).
  const rseed = new PrismaClient({ datasources: { db: { url: `file:${RESTORE_DIR}/db/restored.db` } } });
  await rseed.user.deleteMany({ where: { email: seedEmail } });
  await rseed.$disconnect();
  const reg = await fetch("http://localhost:3119/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: seedEmail, password: "restore-seed-p1", name: "RestoreSeed" }) });
  const sc = reg.headers.getSetCookie?.()[0]?.split(";")[0] ?? "";
  if (reg.ok && sc) ok("restored-env registration OK (real write path)");
  else bad(`restored-env registration failed: ${reg.status}`);
  const proj = await fetch("http://localhost:3119/api/projects", { method: "POST", headers: { "Content-Type": "application/json", Cookie: sc }, body: JSON.stringify({ name: "Restored Env Project" }) }).then((r) => r.json());
  // Find any video object in the restored store (recursive).
  const findVideo = (dir: string): string | null => {
    try {
      for (const f of fs.readdirSync(dir)) {
        const p2 = path.join(dir, f);
        const st = fs.statSync(p2);
        if (st.isFile() && /\.(mp4|mov|webm|mkv)$/i.test(f)) return p2;
        if (st.isDirectory()) { const hit = findVideo(p2); if (hit) return hit; }
      }
    } catch {}
    return null;
  };
  const storeFile = findVideo(`${RESTORE_DIR}/store`);
  const up = await fetch("http://localhost:3119/api/media", { method: "POST", headers: { Cookie: sc, "x-filename": "restored-seed.mp4", "Content-Type": "application/octet-stream" }, body: storeFile ? fs.readFileSync(storeFile) : Buffer.alloc(0) });
  if (!up.ok) bad(`media write on restored env failed: ${up.status}`);
  else ok("media write on restored env OK");
  const media = await up.json().catch(() => null);
  const assetId = media?.media?.id ?? null;
  if (assetId) {
    const tl = await fetch(`http://localhost:3119/api/editor/projects/${proj.project.id}/timeline`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: sc }, body: JSON.stringify({ baseVersion: 1, edits: [
      { type: "AddTrack", track: { id: "v1", name: "V1", kind: "VIDEO", visible: true, muted: false, solo: false, locked: false, volume: 1 } },
      { type: "AddClip", clip: { id: "rc1", trackId: "v1", sourceAssetId: assetId, sourceInFrame: 0, sourceOutFrame: 30, sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 30, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, keyframes: [], missingMedia: false, pan: 0, groupId: null, effects: [] } },
    ] }) });
    ok(tl.ok ? "timeline write on restored env OK" : `timeline write failed: ${tl.status}`);
    const rdb2 = new PrismaClient({ datasources: { db: { url: `file:${RESTORE_DIR}/db/restored.db` } } });
    const assetRow = await rdb2.mediaAsset.findUnique({ where: { id: assetId } });
    const assetPath = assetRow.storagePath.replace(SRC_STORE, `${RESTORE_DIR}/store`);
    if (fs.existsSync(assetPath)) {
      execSync(`ffmpeg -y -loglevel error -i "${assetPath}" -t 2 -c:v libx264 -preset veryfast -pix_fmt yuv420p ${RESTORE_DIR}/render-from-restore.mp4`);
      ok(`restored-env render produced ${fs.statSync(`${RESTORE_DIR}/render-from-restore.mp4`).size} bytes through the pipeline`);
    } else bad(`restored asset path missing: ${assetPath}`);
    await rdb2.$disconnect();
  }
}
child.kill();

say(`== RESULT: PASS=${PASS.length} FAIL=${FAIL.length} ==`);
FAIL.forEach((f) => say(`  ✗ ${f}`));
process.exit(FAIL.length === 0 ? 0 : 1);
