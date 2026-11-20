/**
 * M29 — real-media portability chain: package (FULL) → verify contents →
 * import as user B → verify restored project → RENDER the restored project.
 * Uses real FFmpeg fixtures, real worker jobs, real checksums.
 */
import { describe, test, expect } from "bun:test";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.M29_BASE ?? "http://localhost:3117";
const STAMP = Date.now().toString(36);
const EMAIL_A = `m29a-${STAMP}@test.local`;
const EMAIL_B = `m29b-${STAMP}@test.local`;
let cookieA = "";
let cookieB = "";

async function api(method: string, p: string, body?: unknown, cookie?: string, raw?: Buffer, headers: Record<string, string> = {}): Promise<{ status: number; json: any; buf?: Buffer }> {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}), ...(raw ? headers : {}), ...{ Cookie: cookie ?? "" } },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("json")) return { status: res.status, json: await res.json().catch(() => null) };
  return { status: res.status, json: null, buf: Buffer.from(await res.arrayBuffer()) };
}

function register(email: string, cookieRef: (c: string) => void): Promise<void> {
  return (async () => {
    const r = await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: `m29-${STAMP}-pass-1`, name: "M29" }) });
    expect(r.status).toBe(200);
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const [k, v] = c.split(";")[0].split("=");
      if (k === "beanfx_session") cookieRef(`${k}=${v}`);
    }
  })();
}

function makeFixture(tag: string, kind: "video" | "image", sec = 4): string {
  const p = `/tmp/m29-fixture-${tag}.${kind === "video" ? "mp4" : "png"}`;
  if (kind === "video") {
    execSync(`ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=${sec}" -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=${sec}" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac "${p}"`);
  } else {
    execSync(`ffmpeg -y -loglevel error -f lavfi -i "color=c=gray:size=640x360" -frames:v 1 "${p}"`);
  }
  return p;
}

async function pollArchive(projectId: string, cookie: string, timeoutSec = 600): Promise<any> {
  const t0 = Date.now();
  for (;;) {
    const r = await api("GET", `/api/projects/${projectId}/archive`, undefined, cookie).catch(() => null);
    if (r?.json?.archive && ["COMPLETED", "FAILED", "CANCELLED"].includes(r.json.archive.status)) return r.json.archive;
    if ((Date.now() - t0) / 1000 > timeoutSec) return { status: "TIMEOUT" };
    await new Promise((res) => setTimeout(res, 1500));
  }
}

async function pollImport(archiveId: string, cookie: string, timeoutSec = 600): Promise<any> {
  const t0 = Date.now();
  for (;;) {
    const r = await api("GET", `/api/projects/import/status/${archiveId}`, undefined, cookie).catch(() => null);
    if (r?.json?.archive && ["COMPLETED", "FAILED"].includes(r.json.archive.status)) return r.json.archive;
    if (r?.status !== 200 && r?.status !== 404) { console.error("IMPORT-STATUS:", r?.status, JSON.stringify(r?.json)); }
    if ((Date.now() - t0) / 1000 > timeoutSec) return { status: "TIMEOUT" };
    await new Promise((res) => setTimeout(res, 1500));
  }
}

describe("M29 — full portability chain (real media)", () => {
  let projectIdA = "";
  let assetIds: string[] = [];
  let zipBytes: Buffer | null = null;
  let archiveId = "";

  test("user A builds a rich project (2 tracks, image, effect, keyframe, crossfade, marker)", async () => {
    await register(EMAIL_A, (c) => (cookieA = c));
    const proj = await api("POST", "/api/projects", { name: "M29 Original" }, cookieA);
    expect(proj.status).toBe(200);
    projectIdA = proj.json.project.id;
    const up = async (p: string, role = "BROLL") => {
      const r = await api("POST", "/api/media", undefined, cookieA, fs.readFileSync(p), { "x-filename": path.basename(p), "x-role": role, "Content-Type": "application/octet-stream" });
      expect(r.status).toBe(200);
      return r.json.media.id as string;
    };
    const video = await up(makeFixture("v", "video", 4));
    const video2 = await up(makeFixture("w", "video", 4));
    const image = await up(makeFixture("i", "image"));
    assetIds = [video, video2, image];
    const clip = (id: string, track: string, asset: string, dur: number, start: number) => ({
      id, trackId: track, sourceAssetId: asset, sourceInFrame: 0, sourceOutFrame: dur,
      sourceFps: { num: 30, den: 1 }, timelineStartFrame: start, timelineDurationFrames: dur,
      playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
      keyframes: [],
      missingMedia: false, pan: 0, groupId: "grp1", effects: id === "c1" ? [{ id: "e1", type: "brightness", params: { amount: 0.2 }, keyframes: [{ id: "k1", param: "amount", frame: 30, value: 0.5, interpolation: "LINEAR" }], animatedParams: ["amount"] }] : [],
    });
    const edits = [
      { type: "AddTrack", track: { id: "v1", name: "V1", kind: "VIDEO", visible: true, muted: false, solo: false, locked: false, volume: 1 } },
      { type: "AddTrack", track: { id: "v2", name: "V2", kind: "VIDEO", visible: true, muted: false, solo: false, locked: false, volume: 1 } },
      { type: "AddClip", clip: clip("c1", "v1", video, 90, 0) },
      { type: "AddClip", clip: clip("c2", "v2", image, 60, 0) },
      { type: "AddClip", clip: clip("c3", "v1", video2, 60, 90) },
      { type: "AddMarker", marker: { id: "m1", frame: 30, label: "M29 marker" } },
    ];
    const tl = await api("POST", `/api/editor/projects/${projectIdA}/timeline`, { baseVersion: 1, edits }, cookieA);
    if (tl.status !== 200) console.error("TL-ERROR:", JSON.stringify(tl.json).slice(0, 400));
    expect(tl.status).toBe(200);
    const seq = tl.json.sequence as { clips: unknown[]; markers: unknown[] };
    expect(seq.clips.length).toBe(3);
    expect(seq.markers.length).toBe(1);
  }, 600_000);

  test("FULL package: manifest + verified checksums + dedup + proxies", async () => {
    // Wait for BOTH video probes AND the first video's proxy to settle — the
    // worker caps (global 2, per-user 1) make this take several seconds under
    // load, and the archive honestly includes whatever is READY at build time.
    const t0 = Date.now();
    for (;;) {
      const m1 = await api("GET", `/api/media/${assetIds[0]}`, undefined, cookieA);
      const m2 = await api("GET", `/api/media/${assetIds[1]}`, undefined, cookieA);
      const p1 = m1.json?.media?.proxyStatus;
      const probesReady = m1.json?.media?.probeStatus === "READY" && m2.json?.media?.probeStatus === "READY";
      if (probesReady && p1 === "READY") break;
      if ((Date.now() - t0) / 1000 > 300) throw new Error(`proxy/pipeline settle timeout: v1=${p1} probe1=${m1.json?.media?.probeStatus} probe2=${m2.json?.media?.probeStatus}`);
      await new Promise((res) => setTimeout(res, 1500));
    }
    const start = await api("POST", `/api/projects/${projectIdA}/archive`, { mode: "FULL" }, cookieA);
    if (start.status !== 202) console.error("ARCH-POST:", start.status, JSON.stringify(start.json).slice(0, 300));
    expect(start.status).toBe(202);
    archiveId = start.json.archiveId;
    // Wait for the probe→proxy pipeline to settle before polling the package.
    const arch = await pollArchive(projectIdA, cookieA);
    if (arch.status !== "COMPLETED") console.error("ARCH-FAIL:", JSON.stringify(arch).slice(0, 400));
    expect(arch.status).toBe("COMPLETED");
    expect(arch.assetCount).toBeGreaterThanOrEqual(4); // 3 originals + proxy
    expect(arch.sizeBytes).toBeGreaterThan(10_000);

    const dl = await api("GET", `/api/project-archives/${archiveId}/download`, undefined, cookieA);
    expect(dl.status).toBe(200);
    expect(dl.buf!.length).toBe(arch.sizeBytes);
    zipBytes = dl.buf!;
    fs.writeFileSync("/tmp/m29-package.zip", zipBytes);

    // Verify the package contents independently: manifest + entry checksums.
    const work = "/tmp/m29-verify";
    execSync(`rm -rf ${work} && mkdir -p ${work}`);
    // Python's zipfile reads STORED zips fine — an independent third-party decoder.
    const manifest = JSON.parse(execSync(`python3 -c "
import zipfile, json, sys, hashlib
z = zipfile.ZipFile('/tmp/m29-package.zip')
names = z.namelist()
assert 'manifest.json' in names, names
m = json.loads(z.read('manifest.json'))
assert m['formatVersion'] == 'beanfx-project/1', m['formatVersion']
assert m['mode'] == 'FULL'
bad = []
for a in m['assets']:
    data = z.read(a['path'])
    h = hashlib.sha256(data).hexdigest()
    if h != a['sha256'] or len(data) != a['sizeBytes']:
        bad.append(a['path'])
assert not bad, bad
assert len(m['timeline']['history']) >= 1
print(json.dumps({'entries': len(names), 'assets': len(m['assets']), 'orig': sum(1 for a in m['assets'] if a['role']=='ORIGINAL'), 'proxies': sum(1 for a in m['assets'] if a['role']=='PROXY')}))
"`).toString());
    // Dedup: the two 4s testsrc2 fixtures are byte-identical → one entry.
    expect(manifest.entries).toBe(4);
    expect(manifest.orig).toBe(3);
    expect(manifest.proxies).toBeGreaterThanOrEqual(1);
  }, 600_000);

  test("user B imports the package → NEW project identity, relationships intact", async () => {
    await register(EMAIL_B, (c) => (cookieB = c));
    console.error("ZIP-LEN:", zipBytes?.length, "cookieB:", cookieB ? "set" : "EMPTY");
    const imp = await api("POST", "/api/projects/import", undefined, cookieB, zipBytes!, { "Content-Type": "application/zip" });
    if (imp.status !== 202) console.error("IMPORT-ERROR:", imp.status, JSON.stringify(imp.json).slice(0, 300));
    expect(imp.status).toBe(202);
    const arch = await pollImport(imp.json.archiveId, cookieB);
    expect(arch.status).toBe("COMPLETED");
    expect(arch.stage).toContain("Imported as");
    const importedProjectId = arch.projectId as string;
    expect(importedProjectId).toBeTruthy();
    expect(importedProjectId).not.toBe(projectIdA);

    // Reopen + verify the timeline structure and asset references.
    const detail = await api("GET", `/api/editor/projects/${importedProjectId}/timeline`, undefined, cookieB);
    expect(detail.status).toBe(200);
    const seq = detail.json.sequence ?? detail.json.timeline?.sequence;
    expect(seq).toBeTruthy();
    expect(seq.clips.length).toBe(3);
    expect(seq.markers.length).toBe(1);
    expect(seq.fps.num / seq.fps.den).toBe(30);
    // Every restored clip reference resolves to user B's library.
    for (const c of seq.clips) {
      const m = await api("GET", `/api/media/${c.sourceAssetId}`, undefined, cookieB);
      expect(m.status).toBe(200);
    }
    // Integrity: the first video's restored bytes hash to the ORIGINAL
    // fixture's sha256 (byte-identical restoration, no silent substitution).
    const restored = await fetch(`${BASE}/api/media/${seq.clips[0].sourceAssetId}/file?variant=original`, { headers: { Cookie: cookieB } });
    expect(restored.status).toBe(200);
    const restoredSha = createHash("sha256").update(Buffer.from(await restored.arrayBuffer())).digest("hex");
    const sourceSha = createHash("sha256").update(fs.readFileSync("/tmp/m29-fixture-v.mp4")).digest("hex");
    expect(restoredSha).toBe(sourceSha);
    // The image asset kept its identity (kind + dims).
    const img = seq.clips.find((c: any) => c.id === "c2");
    const imgMeta = await api("GET", `/api/media/${img.sourceAssetId}`, undefined, cookieB);
    expect(imgMeta.json.media.width).toBe(640);
    expect(imgMeta.json.media.height).toBe(360);
    globalThis.__m29Imported = importedProjectId;
  }, 600_000);

  test("restored project RENDERS (real FFmpeg, conformance-gated)", async () => {
    const importedProjectId = (globalThis as any).__m29Imported as string;
    const render = await api("POST", `/api/editor/projects/${importedProjectId}/render`, {}, cookieB);
    if (render.status !== 202) console.error("RENDER-ERROR:", render.status, JSON.stringify(render.json).slice(0, 300));
    expect(render.status).toBe(202);
    const t0 = Date.now();
    for (;;) {
      const j = await api("GET", `/api/jobs/${render.json.jobId}`, undefined, cookieB);
      if (["COMPLETED", "FAILED"].includes(j.json?.job?.status ?? "")) {
        expect(j.json.job.status).toBe("COMPLETED");
        break;
      }
      if ((Date.now() - t0) / 1000 > 300) throw new Error(`render timeout: ${JSON.stringify(j.json)}`);
      await new Promise((res) => setTimeout(res, 2000));
    }
    // Fetch the render output via the export listing and probe it.
    const exportsList = await api("GET", "/api/exports", undefined, cookieB).catch(() => null);
    const rows = exportsList?.json?.exports ?? exportsList?.json?.files ?? [];
    expect(rows.length).toBeGreaterThan(0);
    const latest = rows[rows.length - 1];
    const dl = await api("GET", `/api/exports/${latest.id}/file`, undefined, cookieB).catch(() => null);
    expect(dl?.status).toBe(200);
    fs.writeFileSync("/tmp/m29-restored-render.mp4", dl!.buf!);
    const probe = JSON.parse(execSync(`ffprobe -v error -print_format json -show_streams -show_format /tmp/m29-restored-render.mp4`).toString());
    const v = probe.streams.find((s: any) => s.codec_type === "video");
    expect(v.codec_name).toBe("h264");
    expect(Number(probe.format.duration)).toBeGreaterThan(4.5); // 5s timeline (150 frames @30fps)
    expect(Number(probe.format.duration)).toBeLessThan(6);
  }, 600_000);
});
