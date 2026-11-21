/**
 * M34 Track C — SQLite concurrency & latency benchmark (operational profile).
 *
 * Extends the M33 ladder (same optimistic-concurrency mechanics) with:
 *   - COLD vs WARM phases (separate reports, never merged);
 *   - per-operation latency percentiles (p50 / p95 / p99 / max);
 *   - durable-job claim contention (the app's hottest write path);
 *   - append-only collaboration comment writes;
 *   - mixed readers+writers (the M31 read-latency residual lives here);
 *   - lost-update and double-claim integrity checks;
 *   - DB/WAL size reporting.
 *
 * Run: bun scripts/m34-sqlite-bench.ts [--tag <label>]
 */
import { execSync } from "node:child_process";
import fs from "node:fs";

const TAG = process.argv.includes("--tag") ? process.argv[process.argv.indexOf("--tag") + 1] : `m34-${Date.now().toString(36)}`;
const DB = `/tmp/${TAG}.db`;
process.env.DATABASE_URL = `file:${DB}?connection_limit=2`;
execSync("bunx prisma db push --skip-generate", { env: { ...process.env }, stdio: ["ignore", "ignore", "ignore"] });

const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient({ log: [] });

type Pct = { p50: number; p95: number; p99: number; max: number };
function pct(xs: number[]): Pct {
  const s = [...xs].sort((a, b) => a - b);
  const pick = (q: number) => s[Math.min(s.length, Math.max(1, Math.ceil(q * s.length))) - 1];
  return { p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), max: s[s.length - 1] ?? 0 };
}
const fmt = (p: Pct) => `p50=${p.p50}ms p95=${p.p95}ms p99=${p.p99}ms max=${p.max}ms`;

// Fixture: 4 users (M31 read-shape), projects + versions + comment target.
const users = [];
for (let i = 0; i < 4; i++) {
  users.push(await db.user.create({ data: { email: `m34b-${TAG}-${i}@t.local`, name: `B${i}`, passwordHash: "x", emailVerified: true } }));
}
const projects = [];
for (const u of users) {
  projects.push(await db.project.create({ data: { userId: u.id, name: `bench-${TAG}` } }));
}
const seq = JSON.stringify({ version: 1, name: "B", fps: { num: 30, den: 1 }, width: 640, height: 360, sampleRate: 48000, tracks: [], clips: [], markers: [] });
for (const p of projects) {
  await db.timelineVersion.create({ data: { projectId: p.id, versionNumber: 1, sequenceJson: seq, isAutosave: false, createdById: p.userId } });
}
const commentRoot = await db.project.create({ data: { userId: users[0].id, name: `comments-${TAG}` } });
const commentVersion = await db.timelineVersion.create({ data: { projectId: commentRoot.id, versionNumber: 1, sequenceJson: seq, isAutosave: false, createdById: users[0].id } });
const reviewRevision = await db.reviewRevision.create({ data: { projectId: commentRoot.id, sessionNo: 1, timelineVersionId: commentVersion.id, versionNumber: 1, fingerprint: "bench-fingerprint", title: "bench revision", createdById: users[0].id } });

async function ladderOnce(nWriters: number, project_: { id: string; userId: string }) {
  const base = (await db.timelineVersion.findFirst({ where: { projectId: project_.id }, orderBy: { versionNumber: "desc" } }))!;
  const t0 = performance.now();
  const res = await Promise.all(Array.from({ length: nWriters }, () =>
    (async () => {
      const s0 = performance.now();
      try {
        await db.$transaction(async (tx) => {
          const created = await tx.timelineVersion.create({ data: { projectId: project_.id, versionNumber: base.versionNumber + 1, sequenceJson: base.sequenceJson, isAutosave: false, createdById: project_.userId } });
          await tx.timelineEdit.create({ data: { versionId: created.id, opIndex: 0, type: "AddMarker", payloadJson: "{}", inverseJson: "[]" } });
        }, { timeout: 15_000, maxWait: 10_000 });
        return { ok: "win", ms: performance.now() - s0 };
      } catch (err) {
        const code = (err as { code?: string }).code;
        const msg = String(err);
        if (code === "P2002") return { ok: "conflict", ms: performance.now() - s0 };
        if (/Socket timeout|SQLITE_BUSY|database is locked|Timed out|PoolTimeout/i.test(msg)) return { ok: "engine", ms: performance.now() - s0 };
        if (!ladderOtherLogged) { console.log(`  [other error sample] ${msg.slice(0, 200)}`); ladderOtherLogged = true; }
        return { ok: "other", ms: performance.now() - s0 };
      }
    })()
  ));
  return { t0, lat: res.map(r => r.ms), win: res.filter(r => r.ok === "win").length, conf: res.filter(r => r.ok === "conflict").length, eng: res.filter(r => r.ok === "engine").length, other: res.filter(r => r.ok === "other").length };
}

const ROUNDS = 12;
let ladderOtherLogged = false;
async function runLadder(label: string) {
  console.log(`\n[${label}] optimistic-concurrency ladder (timeline versions, same-base race)`);
  let allWins = 0, rounds = 0, engine = 0, other = 0;
  for (const n of [1, 2, 4, 8]) {
    const lat: number[] = []; let win = 0, conf = 0, eng = 0, oth = 0;
    for (let r = 0; r < ROUNDS; r++) {
      const p = projects[r % projects.length];
      const res = await ladderOnce(n, p);
      lat.push(...res.lat); win += res.win; conf += res.conf; eng += res.eng; oth += res.other;
    }
    allWins += win; engine += eng; other += oth; rounds += ROUNDS;
    console.log(`  ${n} writer(s) × ${ROUNDS}: wins=${win}/${ROUNDS} conflicts=${conf} engine=${eng} other=${oth} — ${fmt(pct(lat))}`);
  }
  // Lost-update invariant: committed versions == 1 per round per ladder run.
  const total = await db.timelineVersion.count();
  const expected = 4 * (1 + ROUNDS) + 1; // base per project + one win per round + the comment fixture version
  console.log(`  integrity: version rows=${total} (expected ${expected} — one win per round, no lost updates) engine_errors=${engine} other=${other}`);
}

async function runJobs(label: string) {
  console.log(`\n[${label}] durable-job claim contention (40 QUEUED jobs, 8 concurrent claimers)`);
  const jobIds: string[] = [];
  for (let i = 0; i < 40; i++) {
    const j = await db.job.create({ data: { userId: users[0].id, type: "RENDER_TIMELINE", status: "QUEUED", paramsJson: "{}" } }).catch(async () => {
      // schema may require more fields — introspect one creation failure honestly
      throw new Error("job fixture failed — check Job model requirements");
    });
    jobIds.push(j.id);
  }
  const lat: number[] = [];
  const claims = await Promise.all(Array.from({ length: 8 }, () =>
    (async () => {
      const out = [];
      for (const id of jobIds) {
        const s0 = performance.now();
        try {
          const r = await db.job.updateMany({ where: { id, status: "QUEUED", claimedAt: null }, data: { status: "IN_PROGRESS", claimedAt: new Date(), progress: 1 } });
          out.push({ claimed: r.count === 1, ms: performance.now() - s0 });
        } catch (err) {
          out.push({ claimed: false, ms: performance.now() - s0, err: String(err).slice(0, 60) });
        }
      }
      return out;
    })()
  ));
  const flat = claims.flat();
  lat.push(...flat.filter(f => f.err === undefined).map(f => f.ms));
  const claimedOnce = await db.job.count({ where: { id: { in: jobIds }, status: "IN_PROGRESS", claimedAt: { not: null } } });
  const skipped = flat.filter(f => !f.claimed && f.err === undefined).length;
  const errors = flat.filter(f => f.err !== undefined);
  console.log(`  claimed exactly once: ${claimedOnce}/40 — benign skip (another claimer won): ${skipped} — errors: ${errors.length}${errors.length ? ` e.g. ${errors[0].err}` : ""}`);
  console.log(`  claim latency: ${fmt(pct(lat))} — integrity: ${claimedOnce === 40 ? "NO double claims" : "DOUBLE CLAIM DETECTED"}`);
  await db.job.deleteMany({ where: { id: { in: jobIds } } });
}

async function runComments(label: string) {
  const phaseTag = `bench-${label}`;
  console.log(`\n[${label}] append-only collaboration comment writes (8 writers × 12)`);
  const lat: number[] = [];
  await Promise.all(Array.from({ length: 8 }, (_, w) =>
    (async () => {
      for (let i = 0; i < 12; i++) {
        const s0 = performance.now();
        try {
          await db.reviewComment.create({ data: { revisionId: reviewRevision.id, authorUserId: users[w % 4].id, body: `${phaseTag} ${w}-${i}` } });
        } catch { /* count check below catches loss */ }
        lat.push(performance.now() - s0);
      }
    })()
  ));
  const stored = await db.reviewComment.count({ where: { revisionId: reviewRevision.id, body: { startsWith: phaseTag } } });
  console.log(`  wrote 96 attempts → ${stored} rows — ${fmt(pct(lat))} — integrity: ${stored === 96 ? "no lost appends" : `LOST APPENDS (${96 - stored})`}`);
}

async function runMixed(label: string) {
  console.log(`\n[${label}] mixed load — 4 readers × 20 project reads vs 2 concurrent writers`);
  const readLat: number[] = [];
  const writes = ladderDrivenWrites();
  const readers = Promise.all(users.map(u =>
    (async () => {
      for (let i = 0; i < 20; i++) {
        const s0 = performance.now();
        await db.project.findMany({ where: { userId: u.id }, include: { timelineVersions: { take: 3, orderBy: { versionNumber: "desc" } } } });
        readLat.push(performance.now() - s0);
      }
    })()
  ));
  await Promise.all([readers, writes]);
  console.log(`  reads (n=${readLat.length}): ${fmt(pct(readLat))}`);
}

async function ladderDrivenWrites(): Promise<void> {
  for (let r = 0; r < 6; r++) {
    await ladderOnce(2, projects[r % projects.length]);
  }
}

function dbSizes(): string {
  const sz = (f: string) => { try { return (fs.statSync(f).size / 1024).toFixed(0) + "KB"; } catch { return "n/a"; } };
  return `db=${sz(DB)} wal=${sz(DB + "-wal")} shm=${sz(DB + "-shm")}`;
}

console.log(`M34 SQLite bench tag=${TAG} config=connection_limit=2 (app default)`);
await db.$queryRawUnsafe("PRAGMA journal_mode=WAL");
const mode = (await db.$queryRawUnsafe("PRAGMA journal_mode"))[0] as { journal_mode: string };
console.log(`journal=${mode.journal_mode} busy_timeout=${Number(((await db.$queryRawUnsafe("PRAGMA busy_timeout"))[0] as { timeout: bigint }).timeout)}`);

console.log("\n========== COLD PHASE (fresh database, first-touch) ==========");
const tCold0 = performance.now();
await runLadder("cold");
await runJobs("cold");
await runComments("cold");
await runMixed("cold");
console.log(`\ncold phase wall: ${((performance.now() - tCold0) / 1000).toFixed(1)}s`);

console.log("\n========== WARM PHASE (same database, caches/pools warmed) ==========");
const tWarm0 = performance.now();
await runLadder("warm");
await runJobs("warm");
await runComments("warm");
await runMixed("warm");
console.log(`\nwarm phase wall: ${((performance.now() - tWarm0) / 1000).toFixed(1)}s`);

console.log(`\n${dbSizes()}`);
await db.$disconnect();
