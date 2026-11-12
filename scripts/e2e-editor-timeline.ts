/**
 * BEAN FX — Milestone 2 E2E: real media, real server, real persistence.
 *
 * Proves the editor integration end to end against the REAL Next.js server:
 *   1. ffmpeg generates actual media files (video + audio, not mocks).
 *   2. The dev server boots against a throwaway SQLite DB.
 *   3. A real user registers through the auth API; media uploads through the
 *      real upload path (ffprobe-inspected server-side).
 *   4. Edits flow through the timeline API exactly as the UI sends them
 *      (validated command batches, versioned snapshots).
 *   5. "Reopening the project" = fresh GETs that must contain every edit.
 *   6. Stale-version writes are refused with 409 (conflict protection).
 *   7. Media streams through the authed file route (what the monitor plays).
 *
 * Usage: bun scripts/e2e-editor-timeline.ts
 */
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-e2e-${Date.now()}.db`);
const WORK = mkdtempSync(path.join(os.tmpdir(), "beanfx-e2e-media-"));
const SERVER_LOG = path.join(os.tmpdir(), "beanfx-e2e-server.log");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${String(detail).slice(0, 120)}` : ""}`);
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
    log = readFileSync(SERVER_LOG, "utf8").slice(-2000);
  } catch {
    /* no log */
  }
  throw new Error(`dev server did not become ready in 180 s\nserver log tail:\n${log}`);
}

async function main() {
  // ---- 1. real media via ffmpeg ------------------------------------------
  const videoPath = path.join(WORK, "beanfx-e2e-clip.mp4");
  const audioPath = path.join(WORK, "beanfx-e2e-tone.wav");
  execSync(
    `ffmpeg -y -f lavfi -i testsrc2=duration=3:size=320x240:rate=30 -c:v libx264 -pix_fmt yuv420p -movflags +faststart "${videoPath}"`,
    { stdio: "pipe" },
  );
  execSync(`ffmpeg -y -f lavfi -i sine=frequency=440:duration=2:sample_rate=48000 -c:a pcm_s16le "${audioPath}"`, { stdio: "pipe" });
  check("real media generated (video 3 s + audio 2 s)", readFileSync(videoPath).byteLength > 10000 && readFileSync(audioPath).byteLength > 100000);

  // ---- 2. scratch DB + dev server -----------------------------------------
  execSync("bunx prisma db push --skip-generate --accept-data-loss", {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` },
    stdio: "pipe",
  });
  const server = spawn("bunx", ["next", "dev", "-p", String(PORT)], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` },
    stdio: ["ignore", await (await import("node:fs")).promises.open(SERVER_LOG, "a").then((h) => h.fd), await (await import("node:fs")).promises.open(SERVER_LOG, "a").then((h) => h.fd)],
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
    // ---- 3. real user + project + media ----------------------------------
    const email = `e2e-editor-${Date.now()}@beanfx.test`;
    const password = "e2e-password-123";
    const regRes = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name: "e2e" }),
    });
    check("user registered via auth API", regRes.ok);
    const cookie = (regRes.headers.get("set-cookie") ?? "").split(";")[0];
    const authHeaders = { Cookie: cookie };

    const projRes = await fetch(`${BASE}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ name: "E2E Persistence Project" }),
    });
    const proj = (await projRes.json()) as { project: { id: string } };
    check("project created", projRes.ok && Boolean(proj.project?.id), proj.project?.id);

    async function upload(name: string, file: string): Promise<{ media: { id: string; durationSec: number | null; fps: number | null } }> {
      const res = await fetch(`${BASE}/api/media`, {
        method: "POST",
        headers: { ...authHeaders, "x-filename": encodeURIComponent(name), "Content-Type": "application/octet-stream" },
        body: readFileSync(file),
      });
      if (!res.ok) throw new Error(`upload failed ${res.status}: ${await res.text()}`);
      return (await res.json()) as { media: { id: string; durationSec: number | null; fps: number | null } };
    }
    // M3: deep ffprobe runs in the background worker after the upload request
    // returns, so metadata polls to READY here (the UI does the same via
    // api.waitForProbe before placing a clip).
    async function waitForProbeReady(mediaId: string): Promise<{ durationSec: number | null; fps: number | null; probeStatus: string | null }> {
      for (let i = 0; i < 60; i++) {
        const detail = (await (await fetch(`${BASE}/api/media/${mediaId}`, { headers: authHeaders })).json()) as {
          media: { durationSec: number | null; fps: number | null; probeStatus: string | null };
        };
        if (detail.media.probeStatus === "READY" || detail.media.probeStatus === "FAILED") return detail.media;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error("probe did not finish in 30 s");
    }
    const videoAsset = await upload("beanfx-e2e-clip.mp4", videoPath);
    const audioAsset = await upload("beanfx-e2e-tone.wav", audioPath);
    const videoProbe = await waitForProbeReady(videoAsset.media.id);
    const audioProbe = await waitForProbeReady(audioAsset.media.id);
    check(
      "real video uploaded and ffprobe-inspected by the worker (duration 3 s, fps 30)",
      videoProbe.durationSec !== null && Math.abs(videoProbe.durationSec - 3) < 0.2 && videoProbe.fps !== null && Math.abs(videoProbe.fps - 30) < 0.5 && videoProbe.probeStatus === "READY",
      `dur=${videoProbe.durationSec} fps=${videoProbe.fps} status=${videoProbe.probeStatus}`,
    );
    check("real audio uploaded (duration 2 s)", audioProbe.durationSec !== null && Math.abs(audioProbe.durationSec - 2) < 0.2 && audioProbe.probeStatus === "READY", `dur=${audioProbe.durationSec}`);

    // ---- 4. editing session through the real timeline API -----------------
    const head1 = (await (await fetch(`${BASE}/api/editor/projects/${proj.project.id}/timeline`, { headers: authHeaders })).json()) as {
      version: number;
      sequence: { id: string; fps: { num: number; den: number }; tracks: { id: string; kind: string; name: string }[] };
    };
    check("first GET creates version 1 with default tracks", head1.version === 1 && head1.sequence.tracks.length === 6, `v${head1.version}`);
    const vTrack = head1.sequence.tracks.find((t) => t.kind === "VIDEO")!.id;
    const aTrack = head1.sequence.tracks.find((t) => t.kind === "AUDIO")!.id;
    const cTrack = head1.sequence.tracks.find((t) => t.kind === "CAPTION")!.id;
    const fps = head1.sequence.fps;

    const postEdits = async (baseVersion: number, edits: unknown[], expectConflict = false) => {
      const res = await fetch(`${BASE}/api/editor/projects/${proj.project.id}/timeline`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ baseVersion, edits, isAutosave: true }),
      });
      const data = (await res.json()) as { version?: number; sequence?: { clips: { id: string; sourceInFrame: number; sourceOutFrame: number; timelineStartFrame: number; timelineDurationFrames: number; captionText: string | null; sourceAssetId: string }[]; tracks: { id: string; visible: boolean; muted: boolean }[] }; headVersion?: number; error?: string };
      if (expectConflict) return { status: res.status, data };
      if (!res.ok) throw new Error(`edits rejected (${res.status}): ${data.error ?? ""}`);
      return { status: res.status, data };
    };

    // Place: video at 0 (full 3 s = 90 frames), audio after it, caption on the caption track.
    const placeBatch = [
      {
        type: "AddClip",
        clip: { id: "vid-1", trackId: vTrack, sourceAssetId: videoAsset.media.id, sourceInFrame: 0, sourceOutFrame: 90, sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, label: "E2E clip" },
      },
      {
        type: "AddClip",
        clip: { id: "aud-1", trackId: aTrack, sourceAssetId: audioAsset.media.id, sourceInFrame: 0, sourceOutFrame: 60, sourceFps: { num: 48, den: 1 }, timelineStartFrame: 0, label: "E2E tone" },
      },
      {
        type: "AddCaption",
        clip: { id: "cap-1", trackId: cTrack, sourceAssetId: "", sourceInFrame: 0, sourceOutFrame: 30, sourceFps: fps, timelineStartFrame: 30, missingMedia: true, captionText: "hello timeline" },
      },
    ];
    const r1 = await postEdits(head1.version, placeBatch);
    check("place batch persisted as version 2 (3 clips)", r1.data.version === 2 && r1.data.sequence!.clips.length === 3, `v${r1.data.version}`);

    // Split the video at frame 45.
    const r2 = await postEdits(r1.data.version!, [
      { type: "SplitClip", clipId: "vid-1", atTimelineFrame: 45, newLeftId: "vid-1", newRightId: "vid-2" },
    ]);
    check("split persisted (4 clips after split)", r2.data.version === 3 && r2.data.sequence!.clips.length === 4, `v${r2.data.version}`);

    // Trim the left half's head, hide the caption track, mute the audio clip's track.
    const r3 = await postEdits(r2.data.version!, [
      { type: "TrimClip", clipId: "vid-1", newSourceInFrame: 10 },
      { type: "UpdateTrack", trackId: cTrack, visible: false },
      { type: "ChangeVolume", clipId: "aud-1", volume: 0.4 },
    ]);
    check("trim + track state + volume batch persisted (v4)", r3.data.version === 4, `v${r3.data.version}`);

    // ---- 5. REOPEN: fresh reads must contain every edit --------------------
    const reopen = (await (await fetch(`${BASE}/api/editor/projects/${proj.project.id}/timeline`, { headers: authHeaders })).json()) as {
      version: number;
      sequence: {
        fps: { num: number; den: number };
        clips: { id: string; sourceInFrame: number; sourceOutFrame: number; timelineStartFrame: number; timelineDurationFrames: number; captionText: string | null; sourceAssetId: string; volume: number; label: string | null }[];
        tracks: { id: string; kind: string; visible: boolean; muted: boolean; name: string }[];
      };
    };
    check("reopen: head is version 4", reopen.version === 4, `v${reopen.version}`);
    const clips = reopen.sequence.clips;
    const vidLeft = clips.find((c) => c.id === "vid-1");
    const vidRight = clips.find((c) => c.id === "vid-2");
    const audio = clips.find((c) => c.id === "aud-1");
    const caption = clips.find((c) => c.id === "cap-1");
    check("reopen: split halves have exact source/timeline geometry", Boolean(
      vidLeft && vidLeft.sourceInFrame === 10 && vidLeft.sourceOutFrame === 45 && vidLeft.timelineStartFrame === 10 && vidLeft.timelineDurationFrames === 35 &&
      vidRight && vidRight.sourceInFrame === 45 && vidRight.sourceOutFrame === 90 && vidRight.timelineStartFrame === 45 && vidRight.timelineDurationFrames === 45,
    ), JSON.stringify({ left: vidLeft, right: vidRight }));
    check("reopen: audio clip volume 0.4 and label persisted", audio?.volume === 0.4 && audio?.label === "E2E tone", `vol=${audio?.volume}`);
    check("reopen: caption text persisted on the caption track", caption?.captionText === "hello timeline", caption?.captionText ?? "missing");
    check("reopen: caption track hidden via UpdateTrack", reopen.sequence.tracks.find((t) => t.id === cTrack)?.visible === false);
    check("reopen: source asset ids are the REAL uploaded assets", vidLeft?.sourceAssetId === videoAsset.media.id && audio?.sourceAssetId === audioAsset.media.id);

    // ---- 6. undo persistence: revert the trim via the inverse commands ----
    const undoBatch = [
      { type: "ChangeVolume", clipId: "aud-1", volume: 1 },
      { type: "UpdateTrack", trackId: cTrack, visible: true },
      { type: "ReplaceClip", clipId: "vid-1", newSourceAssetId: videoAsset.media.id, newSourceInFrame: 0, newSourceOutFrame: 45 },
    ];
    const r4 = await postEdits(reopen.version, undoBatch);
    const afterUndo = (await (await fetch(`${BASE}/api/editor/projects/${proj.project.id}/timeline`, { headers: authHeaders })).json()) as {
      version: number;
      sequence: { clips: { id: string; sourceInFrame: number; volume: number }[]; tracks: { id: string; visible: boolean }[] };
    };
    const vidAfter = afterUndo.sequence.clips.find((c) => c.id === "vid-1");
    const audAfter = afterUndo.sequence.clips.find((c) => c.id === "aud-1");
    const capAfter = afterUndo.sequence.tracks.find((t) => t.id === cTrack);
    check("undo: version advanced to 5", r4.data.version === 5, `v${r4.data.version}`);
    check("undo: vid-1 source in restored to 0", vidAfter?.sourceInFrame === 0, JSON.stringify(vidAfter));
    check("undo: audio volume restored to 1", audAfter?.volume === 1, JSON.stringify(audAfter));
    check("undo: caption track visible again", capAfter?.visible === true, JSON.stringify(capAfter));

    // ---- 7. conflict protection: stale base version must 409 ---------------
    const stale = await postEdits(2, [{ type: "ChangeVolume", clipId: "aud-1", volume: 0.9 }], true);
    check("stale baseVersion refused with 409", stale.status === 409, `status=${stale.status}`);
    const headAfterConflict = (await (await fetch(`${BASE}/api/editor/projects/${proj.project.id}/timeline`, { headers: authHeaders })).json()) as { version: number };
    check("conflict wrote nothing (head unchanged)", headAfterConflict.version === 5, `v${headAfterConflict.version}`);

    // ---- 8. real media streams through the authed file route ---------------
    const fileRes = await fetch(`${BASE}/api/media/${videoAsset.media.id}/file`, { headers: authHeaders });
    const bytes = fileRes.ok ? (await fileRes.arrayBuffer()).byteLength : 0;
    check("monitor's media route streams real bytes (200, >10 KB)", fileRes.ok && bytes > 10_000, `${bytes} bytes`);
    const unauthRes = await fetch(`${BASE}/api/media/${videoAsset.media.id}/file`);
    check("media route refuses unauthenticated access", unauthRes.status === 401, `status=${unauthRes.status}`);

    // ---- 9. cleanup: remove uploaded media (files deleted from store) ------
    for (const asset of [videoAsset, audioAsset]) {
      const del = await fetch(`${BASE}/api/media/${asset.media.id}`, { method: "DELETE", headers: authHeaders });
      check(`cleanup: media ${asset.media.id} deleted`, del.ok);
    }
  } finally {
    try {
      process.kill(-server.pid!, "SIGTERM");
    } catch {
      /* already gone */
    }
    rmSync(WORK, { recursive: true, force: true });
    rmSync(SCRATCH_DB, { force: true });
  }

  console.log(failures === 0 ? "\nRESULT: editor E2E PASSED (persistence after reopen verified)" : `\nRESULT: ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
