/**
 * E2E seed: create the user row (if register didn't), a fixture VIDEO asset
 * row pointing at the real file, and a timeline row with the clip placed —
 * the same state the editor reaches after a real upload + insert, so the
 * visual/temporal pipelines run against REAL project data.
 * Usage: bun scripts/e2e-seed-visual.ts <email> <projectId> <fixturePath>
 */
import { statSync } from "node:fs";

const [email, projectId, file] = process.argv.slice(2);
if (!email || !projectId || !file) throw new Error("usage: e2e-seed-visual <email> <projectId> <fixturePath>");
process.env.NODE_ENV = "production";

const { db } = await import("../src/lib/db");
const { getTimelineHead, applyTimelineEdits } = await import("../src/lib/editor/persistence");

const user = await db.user.findFirst({ where: { email } });
if (!user) throw new Error(`user ${email} not found`);
const st = statSync(file);

const asset = await db.mediaAsset.create({
  data: {
    userId: user.id,
    projectId,
    originalName: "e2e-scenes.mp4",
    storagePath: file,
    kind: "VIDEO",
    mimeType: "video/mp4",
    sizeBytes: st.size,
    durationSec: 12,
    width: 320,
    height: 240,
    fps: 10,
  },
});

const head = await getTimelineHead(projectId, user.id);
const result = await applyTimelineEdits(projectId, user.id, head.version, [
  { type: "AddTrack", track: { id: "t-video", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false } },
  {
    type: "AddClip",
    clip: {
      id: `e2e${Date.now().toString(36)}`,
      trackId: "t-video",
      sourceAssetId: asset.id,
      sourceInFrame: 0,
      sourceOutFrame: 120,
      sourceFps: { num: 10, den: 1 },
      timelineStartFrame: 0,
      playbackSpeed: 1,
      volume: 1,
      muted: false,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      captionText: null,
      captionStyle: null,
      graphicTemplateId: null,
      graphicStyle: null,
      label: "e2e",
      missingMedia: false,
      effects: [],
      keyframes: [],
    },
  },
], false);
console.log(`seeded asset ${asset.id}, timeline version ${result.version}`);
process.exit(0);
