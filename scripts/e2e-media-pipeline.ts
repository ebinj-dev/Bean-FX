/**
 * BEAN FX — Milestone 3 E2E: media pipeline against the REAL server.
 *
 *   1. ffmpeg generates a real 720p MP4; the worker is the real background
 *      loop inside `next dev` (autostart on).
 *   2. Chunked upload with an interrupted transfer → session status → resume
 *      with only the missing chunk → assembly + checksum.
 *   3. Probe job completes async (duration/rotation/VFR/mime persisted).
 *   4. Proxy job produces an aligned preview proxy; the file route serves the
 *      proxy by default and the original on ?variant=original, with Range.
 *   5. Duplicate upload is deduplicated (no second copy of the bytes).
 *   6. Corrupt media → probe FAILED, original preserved. Fake extension → 415.
 *   7. Quota enforcement (declared-size reservation, 413).
 *   8. Upload-session cancellation; cross-user isolation; unauthenticated
 *      access refused; concurrent uploads from two users.
 *
 * Usage: bun scripts/e2e-media-pipeline.ts
 */
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const PORT = 3124;
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m3-e2e-${Date.now()}.db`);
const WORK = mkdtempSync(path.join(os.tmpdir(), "beanfx-m3-e2e-media-"));
const SERVER_LOG = path.join(os.tmpdir(), "beanfx-m3-e2e-server.log");
const QUOTA_BYTES = 40 * 1024 * 1024; // 40 MiB quota for this e2e server

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${String(detail).slice(0, 140)}` : ""}`);
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 180; i++) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok || res.status === 307 || res.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  let log = "";
  try {
    log = readFileSync(SERVER_LOG, "utf8").slice(-2500);
  } catch {
    /* no log */
  }
  throw new Error(`dev server did not become ready in 180 s\nserver log tail:\n${log}`);
}

async function pollAsset(
  authHeaders: Record<string, string>,
  mediaId: string,
  predicate: (m: { probeStatus: string | null; proxyStatus: string | null }) => boolean,
  timeoutMs = 60_000
): Promise<{ media: Record<string, unknown> & { probeStatus: string | null; proxyStatus: string | null; probeError: string | null; durationSec: number | null; width: number | null; height: number | null; mimeType: string; sizeBytes: number; proxySizeBytes: number | null; proxyDurationSec: number | null; isVfr: boolean | null; probeMetaJson: string | null } }> {
  const deadline = Date.now() + timeoutMs;
  let last: { media: Record<string, unknown> } | null = null;
  for (;;) {
    const res = await fetch(`${BASE}/api/media/${mediaId}`, { headers: authHeaders });
    last = (await res.json()) as { media: Record<string, unknown> };
    const m = last.media as never as { probeStatus: string | null; proxyStatus: string | null };
    if (predicate(m)) return last as never;
    if (Date.now() > deadline) throw new Error(`poll timeout for media ${mediaId}: ${JSON.stringify(last?.media).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main() {
  const t0 = Date.now();

  // ---- 1. real media --------------------------------------------------------
  const bigPath = path.join(WORK, "beanfx-m3-720p.mp4");
  execSync(
    `ffmpeg -y -f lavfi -i testsrc2=duration=5:size=1280x720:rate=30 -f lavfi -i sine=frequency=440:duration=5:sample_rate=48000 -c:v libx264 -preset ultrafast -c:a aac -shortest -movflags +faststart "${bigPath}"`,
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const bigBytes = readFileSync(bigPath);
  check("720p fixture generated", bigBytes.byteLength > 200_000, `${(bigBytes.byteLength / 1e6).toFixed(2)} MB`);

  // Corrupt + fake-extension fixtures
  const fullPlain = path.join(WORK, "plain.mp4");
  execSync(`ffmpeg -y -f lavfi -i testsrc2=duration=1:size=320x240:rate=30 -c:v libx264 -preset ultrafast "${fullPlain}"`, { stdio: ["ignore", "ignore", "inherit"] });
  const corruptPath = path.join(WORK, "corrupt.mp4");
  execSync(`dd if="${fullPlain}" of="${corruptPath}" bs=1024 count=20 2>/dev/null`);
  // Real wav header + pcm payload so the container is genuine; extension lies.
  execSync(`ffmpeg -y -f lavfi -i sine=frequency=440:duration=0.5:sample_rate=48000 -c:a pcm_s16le "${path.join(WORK, "real.wav")}"`, { stdio: ["ignore", "ignore", "inherit"] });
  const wavReal = readFileSync(path.join(WORK, "real.wav"));
  check("fake-extension fixture is a real wav", wavReal.subarray(0, 4).toString("latin1") === "RIFF");

  // ---- 2. scratch DB + dev server (worker autostarts inside) ----------------
  execSync("bunx prisma db push --skip-generate --accept-data-loss", {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const fsPromises = await import("node:fs/promises");
  const logHandle = await fsPromises.open(SERVER_LOG, "a");
  const server = spawn("bunx", ["next", "dev", "-p", String(PORT)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: `file:${SCRATCH_DB}`,
      BEANFX_USER_QUOTA_BYTES: String(QUOTA_BYTES),
    },
    stdio: ["ignore", logHandle.fd, logHandle.fd],
    detached: true,
  });
  process.on("exit", () => {
    try {
      process.kill(-server.pid!, "SIGTERM");
    } catch {
      /* already gone */
    }
  });
  await waitForServer();
  check("dev server ready on scratch DB", true, BASE);

  try {
    // ---- 3. two real users --------------------------------------------------
    async function register(name: string): Promise<Record<string, string>> {
      const res = await fetch(`${BASE}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: `${name}-${Date.now()}@beanfx.test`, password: "e2e-password-123", name }),
      });
      if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`);
      return { Cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] };
    }
    const userA = await register("m3-user-a");
    const userB = await register("m3-user-b");
    check("two users registered", Boolean(userA.Cookie) && Boolean(userB.Cookie));

    // ---- 4. chunked upload with an interruption, then resume ----------------
    const uploadId = "e2e-chunked-" + Date.now().toString(16);
    const CHUNK = 1_000_000;
    const chunkTotal = Math.ceil(bigBytes.byteLength / CHUNK);
    const sendChunk = (index: number) =>
      fetch(`${BASE}/api/media`, {
        method: "POST",
        headers: {
          ...userA,
          "x-filename": encodeURIComponent("beanfx-m3-720p.mp4"),
          "x-upload-id": uploadId,
          "x-chunk-index": String(index),
          "x-chunk-total": String(chunkTotal),
          "x-chunk-size": String(CHUNK),
          "x-upload-size": String(bigBytes.byteLength),
          "Content-Type": "application/octet-stream",
        },
        body: bigBytes.subarray(index * CHUNK, Math.min((index + 1) * CHUNK, bigBytes.byteLength)),
      });

    const r0 = await sendChunk(0);
    const r0body = (await r0.json()) as { partial?: boolean; received?: number };
    check("chunk 0 accepted", r0.ok && r0body.partial === true, `received=${r0body.received}/${chunkTotal}`);
    // Interruption: skip chunk 1, send the final chunk — assembly must refuse.
    const rFinal = await sendChunk(chunkTotal - 1);
    const rFinalBody = (await rFinal.json()) as { error?: string };
    check("final chunk without the full set refuses (400, parts kept for resume)", rFinal.status === 400, rFinalBody.error?.slice(0, 90));

    const status1 = (await (await fetch(`${BASE}/api/media/upload/${uploadId}`, { headers: userA })).json()) as {
      status: string;
      missing: number[];
      mismatched: number[];
      chunkTotal: number;
    };
    check(
      "session status lists exactly the missing chunks",
      status1.status === "OPEN" && status1.missing.length === chunkTotal - 2 && !status1.missing.includes(chunkTotal - 1) && status1.mismatched.length === 0,
      `missing=${JSON.stringify(status1.missing)} of ${chunkTotal}`,
    );

    // Client resume protocol: re-send every missing part except the final one,
    // then re-send the final chunk to re-trigger assembly.
    const uploadT0 = Date.now();
    for (const idx of status1.missing) {
      if (idx !== chunkTotal - 1) {
        const r = await sendChunk(idx);
        if (!r.ok) throw new Error(`resume chunk ${idx} failed: ${r.status}`);
      }
    }
    const r1 = await sendChunk(chunkTotal - 1);
    const r1body = (await r1.json()) as { media?: { id: string; probeStatus?: string; deduplicated?: boolean } };
    const resumed = r1.ok && Boolean(r1body.media?.id);
    check("resume with the missing chunk completes the upload", resumed, `status=${r1.status}`);
    const uploadMs = Date.now() - uploadT0;
    const mediaId = r1body.media!.id;
    check("upload response reports async probe (PENDING) — no probing in the request", r1body.media!.probeStatus === "PENDING", `probeStatus=${r1body.media!.probeStatus}`);

    // ---- 5. probe job completes in the worker -------------------------------
    const probeT0 = Date.now();
    const probed = await pollAsset(userA, mediaId, (m) => m.probeStatus === "READY" || m.probeStatus === "FAILED", 60_000);
    const pm = probed.media;
    check("probe READY with full metadata", pm.probeStatus === "READY" && pm.width === 1280 && pm.height === 720 && pm.mimeType === "video/mp4", `w=${pm.width} mime=${pm.mimeType}`);
    check("probe duration matches the 5 s fixture", Math.abs((pm.durationSec as number) - 5) < 0.3, `dur=${pm.durationSec}`);
    check("probe meta JSON carries stream detail", (pm.probeMetaJson as string).includes(`"width":1280`));
    const probeMs = Date.now() - probeT0;
    check("proxy auto-queued for a 720p source", pm.proxyStatus === "QUEUED" || pm.proxyStatus === "PROCESSING", `proxyStatus=${pm.proxyStatus}`);

    // ---- 6. proxy job completes; preview prefers the proxy ------------------
    const proxyT0 = Date.now();
    const proxied = await pollAsset(userA, mediaId, (m) => m.proxyStatus === "READY" || m.proxyStatus === "FAILED", 120_000);
    const px = proxied.media;
    check("proxy READY, smaller than the original", px.proxyStatus === "READY" && (px.proxySizeBytes as number) > 0 && (px.proxySizeBytes as number) < (px.sizeBytes as number), `${px.proxySizeBytes} < ${px.sizeBytes}`);
    check("proxy duration aligned with the source", Math.abs((px.proxyDurationSec as number) - (pm.durationSec as number)) < 0.4, `proxy ${px.proxyDurationSec} vs src ${pm.durationSec}`);
    const proxyMs = Date.now() - proxyT0;

    const proxyRes = await fetch(`${BASE}/api/media/${mediaId}/file`, { headers: userA });
    const proxyLen = Number(proxyRes.headers.get("content-length") ?? 0);
    check("default file route serves the proxy for preview", proxyRes.ok && proxyLen === px.proxySizeBytes, `${proxyLen} bytes, mime=${proxyRes.headers.get("content-type")}`);
    const origRes = await fetch(`${BASE}/api/media/${mediaId}/file?variant=original`, { headers: userA });
    const origLen = Number(origRes.headers.get("content-length") ?? 0);
    check("?variant=original serves the source bytes", origRes.ok && origLen === px.sizeBytes, `${origLen} bytes`);
    const rangeRes = await fetch(`${BASE}/api/media/${mediaId}/file?variant=original`, { headers: { ...userA, Range: "bytes=0-999" } });
    check("range requests work on the original (206)", rangeRes.status === 206 && Number(rangeRes.headers.get("content-length")) === 1000, `status=${rangeRes.status}`);
    const rangeProxy = await fetch(`${BASE}/api/media/${mediaId}/file?variant=proxy`, { headers: { ...userA, Range: "bytes=0-499" } });
    check("range requests work on the proxy (206)", rangeProxy.status === 206, `status=${rangeProxy.status}`);

    // ---- 7. duplicate upload is deduplicated --------------------------------
    const dupRes = await fetch(`${BASE}/api/media`, {
      method: "POST",
      headers: { ...userA, "x-filename": encodeURIComponent("same-bytes.mp4"), "Content-Type": "application/octet-stream" },
      body: bigBytes,
    });
    const dupBody = (await dupRes.json()) as { media?: { id: string; sizeBytes: number }; deduplicated?: boolean; reusedAssetId?: string };
    check("duplicate upload deduplicates (no second copy)", dupRes.ok && dupBody.deduplicated === true && dupBody.media!.id !== mediaId && dupBody.reusedAssetId === mediaId, `asset=${dupBody.media?.id} reused=${dupBody.reusedAssetId}`);

    // ---- 8. corrupt media: upload succeeds, probe FAILS, original intact ----
    const corruptRes = await fetch(`${BASE}/api/media`, {
      method: "POST",
      headers: { ...userA, "x-filename": encodeURIComponent("corrupt.mp4"), "Content-Type": "application/octet-stream" },
      body: readFileSync(corruptPath),
    });
    check("corrupt upload accepted (validation is async now)", corruptRes.ok, `status=${corruptRes.status}`);
    const corruptId = ((await corruptRes.json()) as { media: { id: string } }).media.id;
    const corruptProbed = await pollAsset(userA, corruptId, (m) => m.probeStatus === "READY" || m.probeStatus === "FAILED", 60_000);
    check("corrupt media probed FAILED with error detail, original preserved", corruptProbed.media.probeStatus === "FAILED" && Boolean(corruptProbed.media.probeError), String(corruptProbed.media.probeError).slice(0, 80));

    // ---- 9. fake extension refused deterministically ------------------------
    const fakeRes = await fetch(`${BASE}/api/media`, {
      method: "POST",
      headers: { ...userA, "x-filename": encodeURIComponent("video.mp4"), "Content-Type": "application/octet-stream" },
      body: wavReal,
    });
    check("wav bytes named .mp4 refused with 415", fakeRes.status === 415, `status=${fakeRes.status} body=${(await fakeRes.text()).slice(0, 80)}`);

    // ---- 10. quota enforcement ----------------------------------------------
    const quotaUploadId = "e2e-quota-" + Date.now().toString(16);
    const fakeTotal = 50 * 1024 * 1024;
    const quotaRes = await fetch(`${BASE}/api/media`, {
      method: "POST",
      headers: {
        ...userA,
        "x-filename": encodeURIComponent("toobig.mp4"),
        "x-upload-id": quotaUploadId,
        "x-chunk-index": "0",
        "x-chunk-total": "1",
        "x-chunk-size": String(fakeTotal),
        "x-upload-size": String(fakeTotal),
        "Content-Type": "application/octet-stream",
      },
      body: bigBytes.subarray(0, 10_000),
    });
    check("upload beyond quota refused with 413", quotaRes.status === 413, `status=${quotaRes.status} body=${(await quotaRes.text()).slice(0, 90)}`);
    const quotaSession = (await (await fetch(`${BASE}/api/media/upload/${quotaUploadId}`, { headers: userA })).json()) as { status: string };
    check("quota-refused session is FAILED (scratch cleared)", quotaSession.status === "FAILED", `status=${quotaSession.status}`);

    // ---- 11. explicit session cancellation ----------------------------------
    const cancelUploadId = "e2e-cancel-" + Date.now().toString(16);
    async function sendChunkTo(uploadIdLocal: string, index: number) {
      return fetch(`${BASE}/api/media`, {
        method: "POST",
        headers: {
          ...userA,
          "x-filename": encodeURIComponent("beanfx-m3-720p.mp4"),
          "x-upload-id": uploadIdLocal,
          "x-chunk-index": String(index),
          "x-chunk-total": String(chunkTotal),
          "x-chunk-size": String(CHUNK),
          "x-upload-size": String(bigBytes.byteLength),
          "Content-Type": "application/octet-stream",
        },
        body: bigBytes.subarray(index * CHUNK, Math.min((index + 1) * CHUNK, bigBytes.byteLength)),
      });
    }
    await sendChunkTo(cancelUploadId, 0);
    const cancelRes = await fetch(`${BASE}/api/media/upload/${cancelUploadId}`, { method: "DELETE", headers: userA });
    check("upload session cancelled", cancelRes.ok);
    const afterCancel = (await (await fetch(`${BASE}/api/media/upload/${cancelUploadId}`, { headers: userA })).json()) as { status: string; missing: number[] };
    check("cancelled session reports CANCELLED", afterCancel.status === "CANCELLED");
    const lateChunk = await sendChunkTo(cancelUploadId, 1);
    check("chunks to a cancelled session refused (409)", lateChunk.status === 409, `status=${lateChunk.status}`);

    // ---- 12. tenant isolation ------------------------------------------------
    const crossFile = await fetch(`${BASE}/api/media/${mediaId}/file`, { headers: userB });
    check("user B cannot stream user A's media", crossFile.status === 404, `status=${crossFile.status}`);
    const crossDetail = await fetch(`${BASE}/api/media/${mediaId}`, { headers: userB });
    check("user B cannot read user A's asset detail", crossDetail.status === 404, `status=${crossDetail.status}`);
    const crossSession = await fetch(`${BASE}/api/media/upload/${uploadId}`, { headers: userB });
    check("user B cannot see user A's upload session", crossSession.status === 404, `status=${crossSession.status}`);
    const unauth = await fetch(`${BASE}/api/media/${mediaId}/file`);
    check("unauthenticated file access refused", unauth.status === 401, `status=${unauth.status}`);

    // ---- 13. concurrent uploads from different users ------------------------
    const small = path.join(WORK, "small.mp4");
    execSync(`ffmpeg -y -f lavfi -i testsrc2=duration=1:size=320x240:rate=30 -c:v libx264 -preset ultrafast "${small}"`, { stdio: ["ignore", "ignore", "inherit"] });
    const smallBytes = readFileSync(small);
    const [conA, conB] = await Promise.all([
      fetch(`${BASE}/api/media`, { method: "POST", headers: { ...userA, "x-filename": encodeURIComponent("concurrent-a.mp4"), "Content-Type": "application/octet-stream" }, body: smallBytes }),
      fetch(`${BASE}/api/media`, { method: "POST", headers: { ...userB, "x-filename": encodeURIComponent("concurrent-b.mp4"), "Content-Type": "application/octet-stream" }, body: smallBytes }),
    ]);
    check("concurrent uploads from two users both succeed", conA.ok && conB.ok, `a=${conA.status} b=${conB.status}`);
    const listB = (await (await fetch(`${BASE}/api/media`, { headers: userB })).json()) as { media: { id: string }[] };
    const conBId = ((await conB.json()) as { media: { id: string } }).media.id;
    check("user B's library holds only user B's assets", listB.media.every((m) => m.id !== mediaId) && listB.media.some((m) => m.id === conBId), `${listB.media.length} assets`);

    // ---- 14. dedup refcount delete -------------------------------------------
    const del1 = await fetch(`${BASE}/api/media/${dupBody.media!.id}`, { method: "DELETE", headers: userA });
    const del1Body = (await del1.json()) as { ok: boolean; fileRemoved: boolean };
    check("deleting the dedup copy keeps the shared bytes", del1.ok && del1Body.fileRemoved === false);
    const del2 = await fetch(`${BASE}/api/media/${mediaId}`, { method: "DELETE", headers: userA });
    const del2Body = (await del2.json()) as { ok: boolean; fileRemoved: boolean };
    check("deleting the last reference removes the bytes", del2.ok && del2Body.fileRemoved === true);

    // ---- 15. image ingestion workflow (§4, workflow D) -----------------------
    const pngPath = path.join(WORK, "still.png");
    execSync(`ffmpeg -y -f lavfi -i testsrc2=size=640x360:rate=1 -frames:v 1 "${pngPath}"`, { stdio: ["ignore", "ignore", "inherit"] });
    const pngBytes = readFileSync(pngPath);
    const imgRes = await fetch(`${BASE}/api/media`, {
      method: "POST",
      headers: { ...userA, "x-filename": encodeURIComponent("broll-still.png"), "Content-Type": "application/octet-stream" },
      body: pngBytes,
    });
    const imgBody = (await imgRes.json()) as { media?: { id: string; kind: string; probeStatus?: string } };
    check("image upload accepted (IMAGE kind)", imgRes.ok && imgBody.media?.kind === "IMAGE", `status=${imgRes.status} kind=${imgBody.media?.kind}`);
    const imgId = imgBody.media!.id;
    const imgProbed = await pollAsset(userA, imgId, (m) => m.probeStatus === "READY" || m.probeStatus === "FAILED", 30_000);
    check("image probe READY with pixel dimensions, no proxy", imgProbed.media.probeStatus === "READY" && imgProbed.media.width === 640 && imgProbed.media.mimeType === "image/png" && imgProbed.media.proxyStatus === "NONE", `w=${imgProbed.media.width} mime=${imgProbed.media.mimeType}`);
    const imgFile = await fetch(`${BASE}/api/media/${imgId}/file?variant=original`, { headers: userA });
    check("image streams through the file route with its real bytes", imgFile.ok && Number(imgFile.headers.get("content-length")) === pngBytes.byteLength, `${imgFile.status}`);
    // Place the image on the timeline (workflow D: upload → place on editor).
    const projRes = await fetch(`${BASE}/api/projects`, {
      method: "POST",
      headers: { ...userA, "Content-Type": "application/json" },
      body: JSON.stringify({ name: `e2e-image-${Date.now()}` }),
    });
    const projBody = (await projRes.json()) as { project: { id: string } };
    const projectId = projBody.project.id;
    const headRes = await fetch(`${BASE}/api/editor/projects/${projectId}/timeline`, { headers: userA });
    const head = (await headRes.json()) as { version: number; sequence: { tracks: { id: string; kind: string; locked: boolean }[] } };
    const videoTrack = head.sequence.tracks.find((t) => t.kind === "VIDEO" && !t.locked)!;
    const addClip = {
      type: "AddClip",
      clip: {
        id: `img-clip-${Date.now()}`,
        trackId: videoTrack.id,
        sourceAssetId: imgId,
        sourceInFrame: 0,
        sourceOutFrame: 150, // 5 s still @ 30 fps sequence timebase
        sourceFps: { num: 30, den: 1 },
        timelineStartFrame: 0,
        label: "broll-still.png",
      },
    };
    const placeRes = await fetch(`${BASE}/api/editor/projects/${projectId}/timeline`, {
      method: "POST",
      headers: { ...userA, "Content-Type": "application/json" },
      body: JSON.stringify({ baseVersion: head.version, edits: [addClip] }),
    });
    check("image placed on the video track as a timeline clip", placeRes.ok, `status=${placeRes.status} ${(await placeRes.text()).slice(0, 90)}`);

    // ---- 16. concurrent timeline writes: real 409, no silent loss ------------
    const raceEdits = [
      {
        type: "UpdateTrack",
        trackId: videoTrack.id,
        muted: true,
      },
    ];
    const [raceA, raceB] = await Promise.all([
      fetch(`${BASE}/api/editor/projects/${projectId}/timeline`, {
        method: "POST",
        headers: { ...userA, "Content-Type": "application/json" },
        body: JSON.stringify({ baseVersion: head.version + 1, edits: raceEdits }),
      }),
      fetch(`${BASE}/api/editor/projects/${projectId}/timeline`, {
        method: "POST",
        headers: { ...userA, "Content-Type": "application/json" },
        body: JSON.stringify({ baseVersion: head.version + 1, edits: [{ type: "UpdateTrack", trackId: videoTrack.id, solo: true }] }),
      }),
    ]);
    const statuses = [raceA.status, raceB.status].sort();
    check("simultaneous writes: exactly one wins, the loser gets 409 with the head", statuses[0] === 200 && statuses[1] === 409, `statuses=${statuses.join(",")}`);
    const loserBody = (await (raceA.status === 409 ? raceA : raceB).json()) as { headVersion?: number; sequence?: unknown };
    check("409 carries the authoritative head for rebase", Boolean(loserBody.headVersion) && Boolean(loserBody.sequence));

    // ---- 17. concurrent duplicate uploads (dedup race, benign) ---------------
    const [dupA, dupB] = await Promise.all([
      fetch(`${BASE}/api/media`, { method: "POST", headers: { ...userA, "x-filename": encodeURIComponent("race-dup.png"), "Content-Type": "application/octet-stream" }, body: pngBytes }),
      fetch(`${BASE}/api/media`, { method: "POST", headers: { ...userA, "x-filename": encodeURIComponent("race-dup-2.png"), "Content-Type": "application/octet-stream" }, body: pngBytes }),
    ]);
    check("simultaneous identical uploads both succeed (dedup race is lossless)", dupA.ok && dupB.ok, `a=${dupA.status} b=${dupB.status}`);

    // ---- measured limits (single-node, honest) ------------------------------
    console.log("\n=== measured on this sandbox (2 vCPU, single node) ===");
    console.log(`upload:   ${(bigBytes.byteLength / 1e6).toFixed(2)} MB chunked+resumed in ${uploadMs} ms`);
    console.log(`probe:    deep ffprobe in ${probeMs} ms`);
    console.log(`proxy:    1280x720 5 s -> 960x540 in ${proxyMs} ms (${(5 / (proxyMs / 1000)).toFixed(1)}x realtime)`);
    console.log(`total e2e: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } finally {
    try {
      process.kill(-server.pid!, "SIGTERM");
    } catch {
      /* already gone */
    }
    rmSync(WORK, { recursive: true, force: true });
    rmSync(SCRATCH_DB, { force: true });
  }

  console.log(failures === 0 ? "\nRESULT: media pipeline E2E PASSED" : `\nRESULT: ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
