/**
 * M29-C Phase 7 — security & data-safety supplements beyond the integrity
 * suite: cross-user access boundaries, unsupported compression methods,
 * excessive entry counts, duplicate-processing behavior.
 */
import { describe, test, expect } from "bun:test";
import { execSync } from "node:child_process";
import fs from "node:fs";

const BASE = process.env.M29_BASE ?? "http://localhost:3117";
const STAMP = Date.now().toString(36);
let cookieA = "";
let cookieB = "";
let archiveIdA = "";

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
    const r = await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: `sec-${STAMP}-pass-1`, name: "SEC" }) });
    expect(r.status).toBe(200);
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const [k, v] = c.split(";")[0].split("=");
      if (k === "beanfx_session") into(`${k}=${v}`);
    }
  })();
}

describe("M29-C security & data-safety supplements", () => {
  test("setup: user A builds a minimal project and packages it", async () => {
    await register(`sec1-${STAMP}@test.local`, (c) => (cookieA = c));
    const proj = await api("POST", "/api/projects", { name: "Sec Project" }, cookieA);
    expect(proj.status).toBe(200);
    const pid = proj.json.project.id;
    execSync(`ffmpeg -y -loglevel error -f lavfi -i "color=c=gray:size=320x240" -frames:v 1 /tmp/sec-i.png`);
    const up = await api("POST", "/api/media", undefined, cookieA, fs.readFileSync("/tmp/sec-i.png"), { "x-filename": "sec-i.png", "Content-Type": "application/octet-stream" });
    expect(up.status).toBe(200);
    const tl = await api("POST", `/api/editor/projects/${pid}/timeline`, { baseVersion: 1, edits: [
      { type: "AddTrack", track: { id: "v1", name: "V1", kind: "VIDEO", visible: true, muted: false, solo: false, locked: false, volume: 1 } },
      { type: "AddClip", clip: { id: "c1", trackId: "v1", sourceAssetId: up.json.media.id, sourceInFrame: 0, sourceOutFrame: 30, sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 30, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, keyframes: [], missingMedia: false, pan: 0, groupId: null, effects: [] } },
    ] }, cookieA);
    expect(tl.status).toBe(200);
    const start = await api("POST", `/api/projects/${pid}/archive`, { mode: "FULL" }, cookieA);
    expect(start.status).toBe(202);
    const t0 = Date.now();
    for (;;) {
      const r = await api("GET", `/api/projects/${pid}/archive`, undefined, cookieA);
      if (r.json?.archive?.status === "COMPLETED") { archiveIdA = r.json.archive.id; break; }
      if (r.json?.archive?.status === "FAILED") throw new Error(r.json.archive.error);
      if ((Date.now() - t0) / 1000 > 180) throw new Error("setup archive timeout");
      await new Promise((res) => setTimeout(res, 1200));
    }
  }, 600_000);

  test("cross-user archive access is denied (download + status)", async () => {
    await register(`sec2-${STAMP}@test.local`, (c) => (cookieB = c));
    const dl = await api("GET", `/api/project-archives/${archiveIdA}/download`, undefined, cookieB);
    expect(dl.status).toBe(404);
    const anon = await api("GET", `/api/project-archives/${archiveIdA}/download`);
    expect(anon.status).toBe(401);
    const status = await api("GET", `/api/projects/import/status/${archiveIdA}`, undefined, cookieB);
    expect(status.status).toBe(404);
  }, 600_000);

  test("DEFLATE zip entries are rejected (STORED-only contract)", async () => {
    execSync(`python3 -c "
import zipfile, json
with zipfile.ZipFile('/tmp/sec-deflate.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    m = {'formatVersion': 'beanfx-project/1', 'assets': []}
    z.writestr('manifest.json', json.dumps(m))
"`);
    const imp = await api("POST", "/api/projects/import", undefined, cookieB, fs.readFileSync("/tmp/sec-deflate.zip"), { "Content-Type": "application/zip" });
    expect(imp.status).toBe(202);
    const t0 = Date.now();
    for (;;) {
      const r = await api("GET", `/api/projects/import/status/${imp.json.archiveId}`, undefined, cookieB);
      if (["COMPLETED", "FAILED"].includes(r.json?.archive?.status ?? "")) {
        expect(r.json.archive.status).toBe("FAILED");
        expect(r.json.archive.error).toMatch(/STORED|compression/i);
        break;
      }
      if ((Date.now() - t0) / 1000 > 120) throw new Error("deflate rejection timeout");
      await new Promise((res) => setTimeout(res, 1200));
    }
  }, 600_000);

  test("excessive archive entries are rejected (entry cap)", async () => {
    execSync(`python3 -c "
import zipfile, json
with zipfile.ZipFile('/tmp/sec-many.zip', 'w', zipfile.ZIP_STORED) as z:
    z.writestr('manifest.json', json.dumps({'formatVersion': 'beanfx-project/1', 'assets': []}))
    for i in range(900):
        z.writestr(f'pad/{i}.txt', 'x')
"`);
    const imp = await api("POST", "/api/projects/import", undefined, cookieB, fs.readFileSync("/tmp/sec-many.zip"), { "Content-Type": "application/zip" });
    expect(imp.status).toBe(202);
    const t0 = Date.now();
    for (;;) {
      const r = await api("GET", `/api/projects/import/status/${imp.json.archiveId}`, undefined, cookieB);
      if (["COMPLETED", "FAILED"].includes(r.json?.archive?.status ?? "")) {
        expect(r.json.archive.status).toBe("FAILED");
        expect(r.json.archive.error).toMatch(/entry/i);
        break;
      }
      if ((Date.now() - t0) / 1000 > 120) throw new Error("entry-cap timeout");
      await new Promise((res) => setTimeout(res, 1200));
    }
  }, 600_000);

  test("duplicate processing: importing the same package twice creates TWO distinct new projects (no overwrite)", async () => {
    const dl = await api("GET", `/api/project-archives/${archiveIdA}/download`, undefined, cookieA);
    expect(dl.status).toBe(200);
    const before = await api("GET", "/api/projects", undefined, cookieB);
    const n0 = before.json.projects.length;
    for (const run of [1, 2]) {
      const imp = await api("POST", "/api/projects/import", undefined, cookieB, dl.buf!, { "Content-Type": "application/zip" });
      expect(imp.status).toBe(202);
      const t0 = Date.now();
      for (;;) {
        const r = await api("GET", `/api/projects/import/status/${imp.json.archiveId}`, undefined, cookieB);
        if (["COMPLETED", "FAILED"].includes(r.json?.archive?.status ?? "")) {
          expect(r.json.archive.status).toBe("COMPLETED");
          break;
        }
        if ((Date.now() - t0) / 1000 > 180) throw new Error("dup import timeout");
        await new Promise((res) => setTimeout(res, 1200));
      }
    }
    const after = await api("GET", "/api/projects", undefined, cookieB);
    expect(after.json.projects.length).toBe(n0 + 2);
    const names = after.json.projects.map((p: any) => p.name).filter((n: string) => n.includes("Sec Project"));
    expect(new Set(names).size).toBe(names.length); // collision-safe names are distinct
  }, 600_000);
});
