/**
 * T2 — SRT A (135 cues) and SRT B (198 cues) tested INDEPENDENTLY against the
 * actual 20:19 recording, using the exact functions the analyze route runs
 * (parseSrt → srtCoverage → matchSrtToTranscript) on the server-produced
 * transcript segments. No provider calls.
 */
import { parseSrt, srtCoverage, matchSrtToTranscript } from "../src/lib/srt";
import type { SrtCue } from "../src/lib/srt";

const analysis = JSON.parse(await Bun.file("/tmp/acc/an-main.json").text());
const segments = analysis.transcript.segments as { id: string; start: number; end: number; text: string }[];
const duration: number = analysis.durationSec;
console.log(`media: ${duration.toFixed(2)}s, transcript segments: ${segments.length} (chunks OK: ${analysis.transcript.chunkCount - analysis.transcript.failedChunks.length}/${analysis.transcript.chunkCount})`);
const coveredTo = Math.max(0, ...segments.map((s) => s.end));
console.log(`transcript coverage ends at ~${coveredTo.toFixed(1)}s\n`);

async function report(name: string, path: string) {
  const content = await Bun.file(path).text();
  const { cues, errors } = parseSrt(content);
  const cov = srtCoverage(cues as SrtCue[], duration);
  const m = matchSrtToTranscript(cues as SrtCue[], segments);
  console.log(`===== ${name} =====`);
  console.log(`parsed: ${cues.length} cues, parseErrors: ${errors.length ? errors : "none"}`);
  console.log(`coverage: coveredSec=${cov.coveredSec} ratio=${cov.coverageRatio} span=[${cov.firstStartSec} → ${cov.lastEndSec}]`);
  console.log(`missing ranges (in-file): ${cov.missingRanges.length}, overlapping/duplicate cues: ${cov.duplicates.length}, repeated-text (takes): ${cov.repeatedText.length}`);
  for (const r of cov.repeatedText.slice(0, 5)) console.log(`   take? cues ${r.a}/${r.b} sim=${r.similarity}: ${r.text.slice(0, 70)}`);
  console.log(`matching: ${m.matchedCount} cues matched to transcript; medianOffset=${m.medianOffsetSec} drift=${m.driftSec}`);
  const rows = m.perCue.filter((p) => p.offsetSec !== null);
  for (const p of rows.slice(0, 8)) console.log(`   cue#${p.cue.ordinal} srt@${p.cue.start.toFixed(1)} → seg@${(p.cue.start + p.offsetSec!).toFixed(1)} offset=${p.offsetSec! > 0 ? "+" : ""}${p.offsetSec!.toFixed(2)} sim=${p.similarity}`);
  if (rows.length > 8) {
    console.log("   …");
    for (const p of rows.slice(-3)) console.log(`   cue#${p.cue.ordinal} srt@${p.cue.start.toFixed(1)} → seg@${(p.cue.start + p.offsetSec!).toFixed(1)} offset=${p.offsetSec! > 0 ? "+" : ""}${p.offsetSec!.toFixed(2)} sim=${p.similarity}`);
  }
  // offset consistency: fraction of matched pairs whose |offset| is within the median ±15s
  const near = rows.filter((p) => Math.abs(p.offsetSec! - (m.medianOffsetSec ?? 0)) <= 15).length;
  console.log(`offset consistency: ${near}/${rows.length} matched pairs within median±15s`);
  console.log("");
  return { cov, matched: m.matchedCount, median: m.medianOffsetSec, drift: m.driftSec };
}

await report("SRT A — CLEAN/EDITED NARRATION (upload/edited.txt, 135 cues)", "/home/z/my-project/upload/edited.txt");
await report("SRT B — RAW RECORDING (upload/not edited.txt, 198 cues)", "/home/z/my-project/upload/not edited.txt");
console.log("NOTE: SRT timing is never treated as verified audio timing; offsets above are MEASURED against the actual ASR transcript of this media.");
