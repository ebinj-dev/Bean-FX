process.env.NODE_ENV = "production";
const model = await import("/home/z/my-project/src/lib/editor/model");
const { buildTimelineGraph } = await import("/home/z/my-project/src/lib/publish/timeline-render");
const db = await import("/home/z/my-project/src/lib/db");
const project = await (db as unknown as { db: { timelineVersion: { findFirst: (q: unknown) => Promise<{ sequenceJson: string } | null> } } }).db.timelineVersion.findFirst({ where: { projectId: "cmwi3zupm0016qa1u2zmsnffi" }, orderBy: { versionNumber: "desc" } });
if (!project) { console.error("NO_SEQ"); process.exit(1); }
const seq = JSON.parse(project.sequenceJson);
const fps = seq.fps.num / seq.fps.den;
const inputs = new Map([["asset_v", { index: 0, isImage: false, hasAudio: true }]]);
const WINDOW_SEC = 60;
const totalFrames = 600 * 30;
const windows: { start: number; end: number }[] = [];
let s = 0;
while (s < totalFrames) {
  let e = Math.min(totalFrames, s + Math.round(WINDOW_SEC * fps));
  if (e <= s) break;
  for (const t of seq.transitions) {
    if (t.startFrame < e && t.endFrame > s && t.endFrame > e) e = Math.min(totalFrames, t.endFrame + Math.round(fps));
  }
  windows.push({ start: s, end: e });
  s = e;
}
const out: { graph: string; videoLabel: string; start: number; end: number }[] = [];
for (const w of windows) {
  const g = buildTimelineGraph(seq, w.start, w.end, inputs);
  out.push({ graph: g.filterComplex, videoLabel: g.videoLabel, start: w.start, end: w.end });
}
await Bun.write("/tmp/m18-windows.json", JSON.stringify(out));
console.log("WINDOWS", out.length, out.map((w) => `${Math.round(w.start / 30)}-${Math.round(w.end / 30)}s`).join(","));
