/* Phase 3 — locate the exact recording/job behind the user's report.
   Read-only. Prints media assets, jobs, exports; finds the 123-candidate analysis
   and the 3-cut export on a ~20:19 media. */
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";

const prisma = new PrismaClient();

function cutStats(paramsJson: string | null): { n: number; total: number; sample: string } {
  try {
    const p = JSON.parse(paramsJson ?? "{}");
    const c = p.cuts ?? p.removedRanges ?? p.intervals;
    if (Array.isArray(c)) {
      const total = c.reduce((s: number, x: any) => s + (Number(x.end) - Number(x.start)), 0);
      return { n: c.length, total, sample: JSON.stringify(c.slice(0, 3)) };
    }
    return { n: -1, total: -1, sample: JSON.stringify(p).slice(0, 200) };
  } catch {
    return { n: -2, total: -2, sample: String(paramsJson).slice(0, 120) };
  }
}

async function main() {
  const assets = await prisma.mediaAsset.findMany({
    orderBy: { createdAt: "desc" },
    take: 8,
  });
  console.log("=== MEDIA ASSETS (latest 8) ===");
  for (const a of assets) {
    console.log(
      `${a.createdAt.toISOString()} ${a.id} dur=${a.durationSec} kind=${a.kind} ` +
      `${a.sizeBytes}B ${a.mimeType} name="${a.originalName}" user=${a.userId} path=${a.storagePath}`
    );
  }

  const jobs = await prisma.job.findMany({ orderBy: { createdAt: "desc" }, take: 14 });
  console.log("\n=== JOBS (latest 14) ===");
  for (const j of jobs) {
    const p = j.paramsJson ? JSON.parse(j.paramsJson) : {};
    console.log(
      `${j.createdAt.toISOString()} ${j.id} type=${j.type} status=${j.status} prog=${j.progress} ` +
      `stage=${j.stage ?? "-"} msg=${(j.message ?? "-").slice(0, 90)} params=${JSON.stringify(p).slice(0, 220)}`
    );
  }

  const exportsRows = await prisma.exportFile.findMany({ orderBy: { createdAt: "desc" }, take: 6 });
  console.log("\n=== EXPORTS (latest 6) ===");
  for (const e of exportsRows) {
    const cs = cutStats(e.paramsJson);
    console.log(
      `${e.createdAt.toISOString()} ${e.id} media=${e.mediaId} kind=${e.kind} fmt=${e.format} ` +
      `file="${e.filename}" dur=${e.durationSec} size=${e.sizeBytes} cuts=${cs.n} removed=${cs.total.toFixed(3)}s`
    );
    console.log(`   cuts sample: ${cs.sample.slice(0, 260)}`);
  }

  const dir = "media-store/analysis-results";
  console.log("\n=== ANALYSIS RESULTS SCAN (newest first) ===");
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
  const stat: Array<{ f: string; m: Date; n: number; mediaId?: string; ver?: string }> = [];
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      const n = Array.isArray(j.candidates) ? j.candidates.length : -1;
      stat.push({
        f, m: fs.statSync(path.join(dir, f)).mtime, n,
        mediaId: j.mediaId ?? j.mediaAssetId,
        ver: j.version ?? j.analysisVersion ?? j.engineVersion,
      });
    } catch { stat.push({ f, m: new Date(0), n: -2 }); }
  }
  stat.sort((a, b) => b.m.getTime() - a.m.getTime());
  for (const s of stat.slice(0, 10)) console.log(`${s.m.toISOString()} ${s.f} candidates=${s.n} media=${s.mediaId ?? "?"} ver=${s.ver ?? "?"}`);

  const words = await prisma.wordsToRemove.findMany();
  console.log("\n=== WORDS-TO-REMOVE RULES ===");
  for (const w of words) console.log(`${w.createdAt.toISOString()} user=${w.userId} words="${(w as any).words ?? JSON.stringify(w).slice(0, 120)}"`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
