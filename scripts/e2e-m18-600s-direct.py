#!/usr/bin/env python3
"""M18 Phase C final deliverable: render the 600s multitrack sequence via the
REAL windowed path (buildTimelineGraph per window + concat), measure memory,
and validate with FFprobe + beginning/middle/end decode. This runs the exact
same ffmpeg invocations the durable job path runs — outside the job queue to
isolate the sandbox memory contention documented in the report.
"""
import json
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, "/home/z/my-project")
import os
os.environ["NODE_ENV"] = "production"

BASE = Path("/home/z/my-project")
OUT_DIR = BASE / "download" / "m18-render-logs"
OUT_DIR.mkdir(parents=True, exist_ok=True)
LOG = OUT_DIR / "windowed-direct.log"

def log(msg):
    with open(LOG, "a") as f:
        f.write(msg + "\n")
    print(msg, flush=True)

# Build each window's graph via the REAL TS graph builder.
build_script = BASE / "scripts" / "m18-build-window-graphs.ts"
build_script.write_text('''process.env.NODE_ENV = "production";
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
''')

r = subprocess.run(["bun", "run", str(build_script)], capture_output=True, text=True, timeout=300)
log(r.stdout.strip() or r.stderr.strip()[-300:])
if "WINDOWS" not in r.stdout:
    log("FATAL: window graph build failed")
    sys.exit(1)

windows = json.load(open("/tmp/m18-windows.json"))
segments = []
for i, w in enumerate(windows):
    seg = f"/tmp/m18-w{i:02d}.mp4"
    args = ["ffmpeg", "-y", "-loglevel", "error", "-i", "/tmp/m18-clip.mp4",
            "-filter_complex", w["graph"], "-map", w["videoLabel"], "-map", "[mixout]",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-t", str((w["end"] - w["start"]) / 30), seg]
    peak = {"rss": 0}
    def watch(pid):
        while True:
            try:
                with open(f"/proc/{pid}/status") as f:
                    for line in f:
                        if line.startswith("VmRSS:"):
                            peak["rss"] = max(peak["rss"], int(line.split()[1]))
            except FileNotFoundError:
                return
            time.sleep(0.3)
    t0 = time.time()
    p = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    th = threading.Thread(target=watch, args=(p.pid,), daemon=True)
    th.start()
    try:
        p.wait(timeout=600)
    except subprocess.TimeoutExpired:
        p.kill()
        log(f"window {i}: TIMEOUT")
        sys.exit(1)
    dur = time.time() - t0
    log(f"window {i} ({w['start']/30:.0f}-{w['end']/30:.0f}s): rc={p.returncode} {dur:.1f}s peakRSS={peak['rss']/1024:.0f}MB size={os.path.getsize(seg) if os.path.exists(seg) else 0}")
    if p.returncode != 0:
        log(f"FATAL: window {i} failed")
        sys.exit(1)
    segments.append(seg)

list_path = "/tmp/m18-concat.txt"
with open(list_path, "w") as f:
    for s in segments:
        f.write(f"file '{s}'\n")
final = str(BASE / "download" / "m18-600s-multitrack.mp4")
t0 = time.time()
r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list_path,
                    "-c", "copy", "-movflags", "+faststart", final], capture_output=True, text=True, timeout=600)
log(f"concat: rc={r.returncode} {time.time() - t0:.1f}s {r.stderr[-200:] if r.returncode else ''}")

# FFprobe validation.
probe = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", final],
                       capture_output=True, text=True, timeout=120)
d = json.loads(probe.stdout)
v = [s for s in d["streams"] if s["codec_type"] == "video"]
a = [s for s in d["streams"] if s["codec_type"] == "audio"]
summary = {
    "video_streams": len(v), "audio_streams": len(a),
    "video_codec": v[0]["codec_name"] if v else None, "audio_codec": a[0]["codec_name"] if a else None,
    "resolution": f"{v[0].get('width')}x{v[0].get('height')}" if v else None,
    "fps": v[0].get("r_frame_rate") if v else None,
    "container_duration": float(d["format"]["duration"]),
    "size_mb": round(int(d["format"]["size"]) / 1048576, 2),
}
log("FFPROBE: " + json.dumps(summary))
json.dump(summary, open(OUT_DIR / "ffprobe-600s.json", "w"), indent=1)

# Beginning / middle / end decode + audio presence.
for label, t in [("beginning", 5), ("middle", 300), ("end", 595)]:
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(t), "-i", final, "-frames:v", "24",
                        f"/tmp/m18-dec-{label}.png"], capture_output=True, text=True, timeout=120)
    frames = len(list(Path("/tmp").glob(f"m18-dec-{label}*.png")))
    rms = subprocess.run(["ffmpeg", "-ss", str(t), "-t", "1", "-i", final, "-map", "0:a",
                          "-af", "astats=metadata=1", "-f", "null", "-"], capture_output=True, text=True, timeout=120)
    rms_line = next((l.split(":")[1].strip() for l in rms.stderr.splitlines() if "RMS level dB" in l), "n/a")
    log(f"decode {label}@{t}s: {frames} frames, audio RMS {rms_line} dB")

log("M18_600S_DIRECT_COMPLETE")
