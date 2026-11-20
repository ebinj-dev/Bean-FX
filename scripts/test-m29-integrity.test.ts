/**
 * M29 — package integrity rejections + bulk relinking (real files, real
 * worker). Every rejection case must fail LOUDLY and leave nothing changed.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const BASE = process.env.M29_BASE ?? "http://localhost:3117";
const STAMP = Date.now().toString(36);
let cookieA = "";
let cookieB = "";
let projectIdA = "";
let assetV = "";
let packageZip: Buffer | null = null;
let fullZip: Buffer | null = null;

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

function register(email: string, into: (c: string) => void): Promise<void> {
  return (async () => {
    const r = await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: `m29-${STAMP}-pass-1`, name: "M29" }) });
    expect(r.status).toBe(200);
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const [k, v] = c.split(";")[0].split("=");
      if (k === "beanfx_session") into(`${k}=${v}`);
    }
  })();
}

async function pollImport(archiveId: string, cookie: string, timeoutSec = 600): Promise<any> {
  const t0 = Date.now();
  for (;;) {
    const r = await api("GET", `/api/projects/import/status/${archiveId}`, undefined, cookie).catch(() => null);
    if (r?.json?.archive && ["COMPLETED", "FAILED"].includes(r.json.archive.status)) return r.json.archive;
    if ((Date.now() - t0) / 1000 > timeoutSec) return { status: "TIMEOUT" };
    await new Promise((res) => setTimeout(res, 1500));
  }
}

describe("M29 — package integrity & bulk relink", () => {
  beforeAll(async () => { /* archiving needs > 5s */
    await register(`m29c-${STAMP}@test.local`, (c) => (cookieA = c));
    await register(`m29d-${STAMP}@test.local`, (c) => (cookieB = c));
    const proj = await api("POST", "/api/projects", { name: "M29 Integrity" }, cookieA);
    projectIdA = proj.json.project.id;
    execSync(`ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=3" -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=3" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac /tmp/m29-int-v.mp4`);
    const up = await api("POST", "/api/media", undefined, cookieA, fs.readFileSync("/tmp/m29-int-v.mp4"), { "x-filename": "m29-int-v.mp4", "x-role": "BROLL", "Content-Type": "application/octet-stream" });
    expect(up.status).toBe(200);
    assetV = up.json.media.id;
    const clip = {
      id: "c1", trackId: "v1", sourceAssetId: assetV, sourceInFrame: 0, sourceOutFrame: 90,
      sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 90,
      playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
      keyframes: [], missingMedia: false, pan: 0, groupId: null, effects: [],
    };
    const tl = await api("POST", `/api/editor/projects/${projectIdA}/timeline`, { baseVersion: 1, edits: [{ type: "AddTrack", track: { id: "v1", name: "V1", kind: "VIDEO", visible: true, muted: false, solo: false, locked: false, volume: 1 } }, { type: "AddClip", clip }] }, cookieA);
    expect(tl.status).toBe(200);
    // A real package from the pre-suite chain run (regenerate one to be safe).
    const start = await api("POST", `/api/projects/${projectIdA}/archive`, { mode: "METADATA" }, cookieA);
    expect(start.status).toBe(202);
    const t0 = Date.now();
    for (;;) {
      const r = await api("GET", `/api/projects/${projectIdA}/archive`, undefined, cookieA).catch(() => null);
      if (r?.json?.archive?.status === "COMPLETED") break;
      if (r?.json?.archive?.status === "FAILED") throw new Error(`archive failed: ${r.json.archive.error}`);
      if ((Date.now() - t0) / 1000 > 300) throw new Error("archive timeout");
      await new Promise((res) => setTimeout(res, 1500));
    }
    // Fetch the archive id from the listing response.
    const list = await api("GET", `/api/projects/${projectIdA}/archive`, undefined, cookieA);
    const dl2 = await api("GET", `/api/project-archives/${list.json.archive.id}/download`, undefined, cookieA);
    expect(dl2.status).toBe(200);
    packageZip = dl2.buf!;

    // A FULL package (contains the real media payload) for the tamper test.
    const startFull = await api("POST", `/api/projects/${projectIdA}/archive`, { mode: "FULL" }, cookieA);
    expect(startFull.status).toBe(202);
    const t1 = Date.now();
    for (;;) {
      const r = await api("GET", `/api/projects/${projectIdA}/archive`, undefined, cookieA).catch(() => null);
      if (r?.json?.archive?.status === "COMPLETED") break;
      if (r?.json?.archive?.status === "FAILED") throw new Error(`FULL archive failed: ${r.json.archive.error}`);
      if ((Date.now() - t1) / 1000 > 300) throw new Error("FULL archive timeout");
      await new Promise((res) => setTimeout(res, 1500));
    }
    const listFull = await api("GET", `/api/projects/${projectIdA}/archive`, undefined, cookieA);
    const dlFull = await api("GET", `/api/project-archives/${listFull.json.archive.id}/download`, undefined, cookieA);
    expect(dlFull.status).toBe(200);
    fullZip = dlFull.buf!;
  }, 600_000);

  test("valid package imports cleanly", async () => {
    const imp = await api("POST", "/api/projects/import", undefined, cookieB, packageZip!, { "Content-Type": "application/zip" });
    expect(imp.status).toBe(202);
    const arch = await pollImport(imp.json.archiveId, cookieB);
    expect(arch.status).toBe("COMPLETED");
    const projects = await api("GET", "/api/projects", undefined, cookieB);
    (globalThis as any).__m29cProjectCount = projects.json.projects.length;
  }, 600_000);

  test("tampered media payload is rejected with checksum mismatch (nothing imported)", async () => {
    // Locate a REAL media payload byte via the ZIP central directory — no
    // hard-coded offsets — flip it, and require the importer to reach the
    // integrity stage and refuse the whole import with the exact failure class.
    fs.writeFileSync("/tmp/m29c-full.zip", fullZip!);
    execSync(`python3 -c "
import zipfile, json
z = zipfile.ZipFile('/tmp/m29c-full.zip')
m = json.loads(z.read('manifest.json'))
media = [a for a in m['assets'] if a['role'] == 'ORIGINAL' and a['path']]
assert media, 'FULL package must contain media'
info = z.getinfo(media[0]['path'])
off = info.header_offset + 30 + len(media[0]['path'].encode()) + 10
open('/tmp/m29c-flip.txt', 'w').write(str(off))
print('flip at', off)
"`);
    const flipOffset = Number(fs.readFileSync("/tmp/m29c-flip.txt", "utf8"));
    const corrupted = Buffer.from(fullZip!);
    corrupted[flipOffset] ^= 0xff;
    const imp = await api("POST", "/api/projects/import", undefined, cookieB, corrupted, { "Content-Type": "application/zip" });
    expect(imp.status).toBe(202); // staged; the WORKER must reject it
    const arch = await pollImport(imp.json.archiveId, cookieB);
    expect(arch.status).toBe("FAILED");
    expect(arch.error).toMatch(/checksum|mismatch|corrupted/i);
    // Nothing was imported: no new project for user B from this attempt.
    const projects = await api("GET", "/api/projects", undefined, cookieB);
    const countBefore = (globalThis as any).__m29cProjectCount ?? 0;
    if (countBefore) expect(projects.json.projects.length).toBe(countBefore);
  }, 600_000);

  test("non-zip uploads are rejected by signature sniffing", async () => {
    const imp = await api("POST", "/api/projects/import", undefined, cookieB, Buffer.from("definitely not a zip"), { "Content-Type": "application/zip" });
    expect(imp.status).toBe(400);
    expect(imp.json.error).toContain("zip");
  }, 600_000);

  test("METADATA import restores the timeline with honest missing references", async () => {
    const imp = await api("POST", "/api/projects/import", undefined, cookieB, packageZip!, { "Content-Type": "application/zip" });
    expect(imp.status).toBe(202);
    const arch = await pollImport(imp.json.archiveId, cookieB);
    expect(arch.status).toBe("COMPLETED");
    const pid = arch.projectId;
    const relink = await api("GET", `/api/projects/${pid}/relink`, undefined, cookieB);
    expect(relink.status).toBe(200);
    expect(relink.json.missing.length).toBe(1); // the video referenced, library empty
    expect(relink.json.missing[0].affectedClips.length).toBe(1);
    // Status API reports MISSING honestly.
    const status = await api("GET", `/api/projects/${pid}/assets/status`, undefined, cookieB);
    expect(status.json.referenced.some((r: any) => r.status === "MISSING")).toBe(true);
  }, 600_000);

  test("bulk relink: suggestion, compatible-metadata warning, atomic apply, undo", async () => {
    // User B uploads a REAL compatible replacement (same duration/fps/kind,
    // different bytes → COMPATIBLE, never EXACT).
    execSync(`ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=3" -f lavfi -i "sine=frequency=880:sample_rate=48000:duration=3" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac /tmp/m29-repl.mp4`);
    const up = await api("POST", "/api/media", undefined, cookieB, fs.readFileSync("/tmp/m29-repl.mp4"), { "x-filename": "m29-repl.mp4", "x-role": "BROLL", "Content-Type": "application/octet-stream" });
    expect(up.status).toBe(200);
    const replacementId = up.json.media.id;
    // Wait for its probe so metadata is honest.
    const t0 = Date.now();
    for (;;) {
      const m = await api("GET", `/api/media/${replacementId}`, undefined, cookieB);
      if (m.json?.media?.probeStatus === "READY") break;
      if ((Date.now() - t0) / 1000 > 120) throw new Error("replacement probe timeout");
      await new Promise((res) => setTimeout(res, 1500));
    }

    // Find the newest imported project (the one with the missing ref).
    const projects = await api("GET", "/api/projects", undefined, cookieB);
    const imported = projects.json.projects.find((p: any) => p.name.includes("M29 Integrity"));
    expect(imported).toBeTruthy();
    const relink = await api("GET", `/api/projects/${imported.id}/relink`, undefined, cookieB);
    const missingRef = relink.json.missing[0];
    expect(missingRef).toBeTruthy();
    // The suggestion must flag it compatible-with-warnings, never silently exact.
    const sug = missingRef.suggestions.find((s: any) => s.candidateAssetId === replacementId);
    expect(sug).toBeTruthy();
    expect(sug.quality).toBe("COMPATIBLE");

    // Apply through the canonical timeline endpoint (one atomic history entry).
    const base = relink.json.baseVersion as number;
    const apply = await api("POST", `/api/editor/projects/${imported.id}/timeline`, { baseVersion: base, edits: [{ type: "RelinkAssets", mappings: [{ deadAssetId: missingRef.deadAssetId, newAssetId: replacementId }] }] }, cookieB);
    expect(apply.status).toBe(200);
    expect(apply.json.sequence.clips[0].sourceAssetId).toBe(replacementId);
    // The relink API now reports no missing refs.
    const relink2 = await api("GET", `/api/projects/${imported.id}/relink`, undefined, cookieB);
    expect(relink2.json.missing.length).toBe(0);
    // Undo via the versions restore path is covered by M25 suites; here verify
    // the edit landed as a new version row.
    const versions = await api("GET", `/api/editor/projects/${imported.id}/timeline/versions`, undefined, cookieB);
    expect(versions.json.versions.length).toBeGreaterThanOrEqual(2);
  }, 600_000);

  test("path traversal entry names are rejected by the zip reader", async () => {
    // Build a hostile zip locally with python (STORED, traversal name).
    execSync(`python3 -c "
import zipfile, json
with zipfile.ZipFile('/tmp/m29-evil.zip', 'w', zipfile.ZIP_STORED) as z:
    z.writestr('../evil.txt', 'owned')
    z.writestr('manifest.json', json.dumps({'formatVersion': 'beanfx-project/1'}))
"`);
    const imp = await api("POST", "/api/projects/import", undefined, cookieB, fs.readFileSync("/tmp/m29-evil.zip"), { "Content-Type": "application/zip" });
    // The worker must fail the import loudly with the traversal reason.
    if (imp.status === 202) {
      const arch = await pollImport(imp.json.archiveId, cookieB);
      expect(arch.status).toBe("FAILED");
      expect(arch.error).toMatch(/unsafe|traversal|path/i);
    } else {
      expect(imp.json.error ?? "").toBeTruthy();
    }
  }, 600_000);

  test("unsupported future package versions are rejected clearly", async () => {
    execSync(`python3 -c "
import zipfile, json
with zipfile.ZipFile('/tmp/m29-future.zip', 'w', zipfile.ZIP_STORED) as z:
    z.writestr('manifest.json', json.dumps({'formatVersion': 'beanfx-project/99', 'assets': []}))
"`);
    const imp = await api("POST", "/api/projects/import", undefined, cookieB, fs.readFileSync("/tmp/m29-future.zip"), { "Content-Type": "application/zip" });
    expect(imp.status).toBe(202); // accepted for staging; the WORKER rejects it
    const arch = await pollImport(imp.json.archiveId, cookieB);
    expect(arch.status).toBe("FAILED");
    expect(arch.error).toContain("Unsupported package format");
  }, 600_000);

  test("malformed manifest JSON is rejected", async () => {
    execSync(`python3 -c "
import zipfile
with zipfile.ZipFile('/tmp/m29-badmanifest.zip', 'w', zipfile.ZIP_STORED) as z:
    z.writestr('manifest.json', '{not json')
"`);
    const imp = await api("POST", "/api/projects/import", undefined, cookieB, fs.readFileSync("/tmp/m29-badmanifest.zip"), { "Content-Type": "application/zip" });
    expect(imp.status).toBe(202);
    const arch = await pollImport(imp.json.archiveId, cookieB);
    expect(arch.status).toBe("FAILED");
  }, 600_000);
});

