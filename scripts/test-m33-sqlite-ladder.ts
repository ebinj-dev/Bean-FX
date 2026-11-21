/**
 * M33 Track C — controlled SQLite writer-contention reproduction.
 * Ladder: 1 / 2 / 4 / 8 concurrent same-base timeline writers, measuring
 * wins (200), clean conflicts (P2002 → 409 path), and ENGINE failures
 * (socket timeout / SQLITE_BUSY) — first on the CURRENT configuration
 * (journal_mode=delete), then with WAL enabled, then WAL + busy_timeout.
 *
 * This isolates the database layer from HTTP (the real HTTP race is
 * re-verified separately by the suite). Run:
 *   bun scripts/test-m33-sqlite-ladder.ts [phase]
 */
import { execSync } from "node:child_process";
const PHASE = process.argv[2] ?? "current";
const DB = `/tmp/m33-ladder-${PHASE}-${Date.now().toString(36)}.db`;
// connection_limit phases append the pool size to the URL (Prisma-supported
// SQLite configuration); "current" = library defaults.
const CL = PHASE === "cl1" ? 1 : PHASE === "cl2" ? 2 : PHASE === "cl4" ? 4 : null;
process.env.DATABASE_URL = `file:${DB}${CL ? `?connection_limit=${CL}` : ""}`;
execSync("bunx prisma db push --skip-generate --accept-data-loss", { env: { ...process.env }, stdio: ["ignore", "ignore", "ignore"] });

const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient({ log: [] });

const mode = (await db.$queryRawUnsafe("PRAGMA journal_mode"))[0] as { journal_mode: string };
const busy = (await db.$queryRawUnsafe("PRAGMA busy_timeout"))[0] as { timeout: bigint };
if (PHASE.startsWith("wal") || PHASE.startsWith("cl2") || PHASE.startsWith("cl4")) await db.$queryRawUnsafe("PRAGMA journal_mode=WAL");
const mode2 = (await db.$queryRawUnsafe("PRAGMA journal_mode"))[0] as { journal_mode: string };

// Fixture: one user + one project.
const user = await db.user.create({ data: { email: `m33c-${PHASE}@t.local`, name: "C", passwordHash: "x", emailVerified: true } });
const project = await db.project.create({ data: { userId: user.id, name: "ladder" } });
await db.timelineVersion.create({ data: { projectId: project.id, versionNumber: 1, sequenceJson: JSON.stringify({ version: 1, name: "L", fps: { num: 30, den: 1 }, width: 640, height: 360, sampleRate: 48000, tracks: [], clips: [], markers: [] }), isAutosave: false, createdById: user.id } });

async function raceOnce(nWriters: number): Promise<{ wins: number; conflicts: number; engineErrors: number; other: number; maxMs: number }> {
  const base = (await db.timelineVersion.findFirst({ where: { projectId: project.id }, orderBy: { versionNumber: "desc" } }))!;
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: nWriters }, (_, i) =>
    (async () => {
      try {
        const next = base.versionNumber + 1;
        await db.$transaction(async (tx) => {
          // tx-only callback (the M33 audit requirement for any pool config):
          // no default-client queries inside the transaction.
          const created = await tx.timelineVersion.create({ data: { projectId: project.id, versionNumber: next, sequenceJson: base.sequenceJson, isAutosave: false, createdById: user.id } });
          await tx.timelineEdit.create({ data: { versionId: created.id, opIndex: 0, type: "AddMarker", payloadJson: "{}", inverseJson: "[]" } });
        }, { timeout: 15_000, maxWait: 10_000 });
        return "win";
      } catch (err) {
        const code = (err as { code?: string }).code;
        const msg = String(err);
        if (code === "P2002") return "conflict";
        if (/Socket timeout|SQLITE_BUSY|database is locked|Timed out/i.test(msg)) return "engine";
        return "other";
      }
    })()
  ));
  return {
    wins: results.filter((r) => r === "win").length,
    conflicts: results.filter((r) => r === "conflict").length,
    engineErrors: results.filter((r) => r === "engine").length,
    other: results.filter((r) => r === "other").length,
    maxMs: Date.now() - t0,
  };
}

const ROUNDS = 12;
const summary: Record<string, { wins: number; conflicts: number; engineErrors: number; other: number }> = {};
for (const n of [1, 2, 4, 8]) {
  const agg = { wins: 0, conflicts: 0, engineErrors: 0, other: 0, maxMs: 0 };
  for (let r = 0; r < ROUNDS; r++) {
    const res = await raceOnce(n);
    agg.wins += res.wins; agg.conflicts += res.conflicts; agg.engineErrors += res.engineErrors; agg.other += res.other;
    agg.maxMs = Math.max(agg.maxMs, res.maxMs);
  }
  summary[`${n}w`] = agg;
  console.log(`${n} writer(s) × ${ROUNDS} rounds: wins=${agg.wins}/${ROUNDS} conflicts=${agg.conflicts} ENGINE_ERRORS=${agg.engineErrors} other=${agg.other} maxRaceMs=${agg.maxMs}`);
}
console.log(`CONFIG phase=${PHASE} journal=${mode2.journal_mode} busy_timeout=${busy.timeout}`);
// Correctness invariant: every race produced exactly one committed version per
// round beyond the base — no lost writes, no double-commit.
const finalVersions = await db.timelineVersion.count({ where: { projectId: project.id } });
console.log(`final version rows: ${finalVersions} (expected ${1 + ROUNDS * 4} — one win per round × 4 ladders)`);
await db.$disconnect();
