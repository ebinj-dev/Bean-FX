/**
 * Phase G — second-recording end-to-end through the REAL HTTP API.
 *
 * Recording: media-store/originals/mvxyl41yi4etgn.wav (240.000 s, 44.1 kHz
 * stereo PCM) — different content, duration and format from the 20:19/48 kHz
 * mono MP3 reference. Steps: session → upload → analyze (background job) →
 * result → explicit approval of the proposed REMOVE ranges → export →
 * verification data (ffprobe/full decode run separately by the caller).
 */
const BASE = "http://localhost:3000";
const MEDIA = process.argv[2] ?? "media-store/originals/mvxyl41yi4etgn.wav";
const TAG = process.argv[3] ?? "phaseG";
const log: string[] = [];
function out(line: string) {
  console.log(line);
  log.push(line);
}

async function main() {
  // 1. Session
  const mint = Bun.spawnSync(["bun", "scripts/mint-session.ts"], { cwd: process.cwd() });
  const token = mint.stdout.toString().match(/SESSION_TOKEN=(\w+)/)?.[1];
  if (!token) throw new Error("session mint failed: " + mint.stderr.toString().slice(0, 200));
  const cookie = `beanfx_session=${token}`;
  const auth = { cookie };

  // 2. Upload (real API, raw body + x-filename header like the client does)
  const bytes = readMediaSize();
  const t0 = performance.now();
  const up = await fetch(`${BASE}/api/media`, {
    method: "POST",
    headers: { cookie, "x-filename": `${TAG}-second-recording.wav`, "content-type": "application/octet-stream" },
    body: Bun.file(MEDIA),
  });
  const upBody = await up.json().catch(() => null);
  out(`upload: status=${up.status} in ${Math.round(performance.now() - t0)}ms bytes=${bytes} -> ${JSON.stringify(upBody).slice(0, 220)}`);
  const mediaId = upBody?.media?.id ?? upBody?.id ?? upBody?.mediaId;
  if (!mediaId) throw new Error("no mediaId in upload response: " + JSON.stringify(upBody).slice(0, 300));

  // 3. Analyze (background job)
  const an = await fetch(`${BASE}/api/autocut/analyze`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ mediaId }),
  });
  const anBody = await an.json().catch(() => null);
  out(`analyze: status=${an.status} -> ${JSON.stringify(anBody).slice(0, 200)}`);
  const jobId = anBody?.jobId;
  if (!jobId) throw new Error("no jobId");

  // 4. Poll to completion (max 12 min)
  const t1 = performance.now();
  let final: Record<string, unknown> | null = null;
  while (performance.now() - t1 < 12 * 60_000) {
    await new Promise((r) => setTimeout(r, 15_000));
    const st = await fetch(`${BASE}/api/jobs/${jobId}`, { headers: { cookie } }).then((r) => r.json()).catch(() => null);
    const job = st?.job ?? st;
    const status = job?.status;
    const stage = job?.progress?.stageKey ?? job?.progress?.stage ?? "";
    out(`poll: status=${status} stage=${stage} elapsed=${Math.round((performance.now() - t1) / 1000)}s`);
    if (status === "COMPLETED" || status === "FAILED" || status === "completed" || status === "failed") {
      final = job;
      break;
    }
  }
  if (!final) throw new Error("analysis did not finish in 12 min");
  const ok = String(final.status).toUpperCase() === "COMPLETED" || String(final.status).toLowerCase() === "completed";
  out(`analysis finished: status=${final.status} in ${Math.round((performance.now() - t1) / 1000)}s`);
  if (!ok) {
    out(`failure detail: ${JSON.stringify(final).slice(0, 400)}`);
    writeLog();
    process.exit(1);
  }

  // 5. Result payload
  const res = await fetch(`${BASE}/api/autocut/analyze/result/${jobId}`, { headers: { cookie } }).then((r) => r.json()).catch(() => null);
  const payload = res?.payload ?? res;
  const candidates = (payload?.candidates ?? []) as { id: string; start: number; end: number; review: string; confidence: number; reason: string }[];
  const counts = { REMOVE: 0, KEEP: 0, REVIEW: 0 } as Record<string, number>;
  for (const c of candidates) counts[c.review] = (counts[c.review] ?? 0) + 1;
  out(`result: durationSec=${payload?.durationSec} candidates=${candidates.length} REMOVE=${counts.REMOVE} KEEP=${counts.KEEP} REVIEW=${counts.REVIEW}`);
  out(`plan: ${JSON.stringify(payload?.plan)}`);
  out(`inference: ${JSON.stringify(payload?.inference?.model ?? payload?.inferenceNote ?? "").slice(0, 160)}`);
  for (const c of candidates.filter((x) => x.review === "REMOVE")) out(`REMOVE ${c.id}: ${c.start.toFixed(2)}-${c.end.toFixed(2)}s conf=${c.confidence} — ${c.reason.slice(0, 110)}`);

  // 6. Explicit human approval step: approve EXACTLY the proposed REMOVE ranges.
  const removals = candidates.filter((x) => x.review === "REMOVE").map((x) => ({ start: x.start, end: x.end }));
  out(`approving ${removals.length} range(s): ${JSON.stringify(removals)}`);

  // 7. Export (WAV)
  const ex = await fetch(`${BASE}/api/process/autocut`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ mediaId, cuts: removals, outputFormat: "wav" }),
  });
  const exBody = await ex.json().catch(() => null);
  out(`export: status=${ex.status} -> ${JSON.stringify(exBody).slice(0, 300)}`);
  writeLog();
}

function readMediaSize(): number {
  try {
    const st = Bun.spawnSync(["stat", "-c", "%s", MEDIA]).stdout.toString().trim();
    return Number(st);
  } catch {
    return -1;
  }
}
function writeLog() {
  try {
    const { appendFileSync } = require("fs") as typeof import("fs");
    appendFileSync(`media-store/${TAG}-e2e.log`, log.join("\n") + "\n");
  } catch { /* best effort */ }
  process.exit(0);
}

main().catch((e) => {
  out("E2E crashed: " + (e instanceof Error ? e.message : String(e)));
  writeLog();
  process.exit(2);
});
