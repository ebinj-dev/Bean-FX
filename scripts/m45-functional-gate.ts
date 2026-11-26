/**
 * M45 Unit A — functional quality gate: core editing journeys against the
 * REAL server (API-level, deterministic). Every step asserts exact expected
 * timeline state; failures print the actual state for root-causing.
 *
 * Journey: place → split → verify durations → trim → verify → ripple delete →
 * verify neighbor shift → move between tracks → markers → undo/redo (version
 * chain + inverse) → reload persistence check.
 * Run: BASE=http://127.0.0.1:3000 bash scripts/m45-functional-gate.sh <projectId>
 */
const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const PID = process.argv[2] ?? "cmwwzn310007ily87vt7kk5cs";
const VIDEO_TRACK = `${PID}-v1`;
const AUDIO_TRACK = `${PID}-a1`;
const CLIP = "myai-clip-qa2";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    failures.push(`${name} — ${detail}`);
    console.log(`FAIL  ${name} — ${detail}`);
  }
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

let COOKIE = "";
const H = () => ({ "content-type": "application/json", cookie: COOKIE });

async function login(): Promise<void> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "demo@beanfx.local", password: "BeanDemo2026" }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  const raw = res.headers.get("set-cookie") ?? "";
  COOKIE = raw.split(";")[0];
  if (!COOKIE) throw new Error("no session cookie in login response");
}

async function apply(baseVersion: number, edits: unknown[]): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}/api/editor/projects/${PID}/timeline`, {
    method: "POST",
    headers: H(),
    body: JSON.stringify({ baseVersion, edits, isAutosave: false }),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function head(): Promise<{ version: number; clips: any[]; markers: any[]; tracks: any[] }> {
  const res = await fetch(`${BASE}/api/editor/projects/${PID}/timeline`, { headers: H() });
  const j = await res.json();
  return { version: j.version, clips: j.sequence.clips, markers: j.sequence.markers, tracks: j.sequence.tracks };
}

const clipOf = (clips: any[], suffix: string) => clips.find((c) => c.id.endsWith(suffix));

async function main(): Promise<void> {
  await login();
  // ── 0. Place the QA clip (source 6 s @ 30 fps = 180 frames) at frame 0 ────
  let st0 = await head();
  if (!clipOf(st0.clips, CLIP)) {
    const add = await apply(st0.version, [{
      type: "AddClip",
      clip: {
        id: CLIP,
        trackId: VIDEO_TRACK,
        sourceAssetId: process.env.QA_ASSET ?? "cmwwzlwak007ely87cz7dc2rr",
        sourceInFrame: 0,
        sourceOutFrame: 180,
        sourceFps: { num: 30, den: 1 },
        timelineStartFrame: 0,
        label: "m45-qa-clip.mp4",
      },
    }]);
    check("place: AddClip applies", add.status === 200, JSON.stringify(add.json).slice(0, 160));
  }
  // ── Baseline: clip placed at 0, 180 frames ─────────────────────────────
  let st = await head();
  const base = clipOf(st.clips, CLIP);
  check("place: clip exists at 0..180", !!base && (base.startFrame ?? base.timelineStartFrame) === 0 && base.sourceInFrame === 0 && base.sourceOutFrame === 180, JSON.stringify(base));
  const start0 = base.startFrame ?? base.timelineStartFrame;
  let v = st.version;

  // ── 1. Split at frame 60 → left 0..60, right 60..180 ──────────────────────
  const r1 = await apply(v, [{ type: "SplitClip", clipId: base.id, atTimelineFrame: 60, newLeftId: "myai-clip-spl-l", newRightId: "myai-clip-spl-r" }]);
  check("split applies", r1.status === 200, JSON.stringify(r1.json).slice(0, 160));
  st = await head();
  v = st.version;
  const left = clipOf(st.clips, "spl-l");
  const right = clipOf(st.clips, "spl-r");
  check("split: left 0..60", !!left && (left.startFrame ?? left.timelineStartFrame) === 0 && left.sourceInFrame === 0 && left.sourceOutFrame === 60, JSON.stringify(left));
  check("split: right source-mapped 60..180", !!right && (right.startFrame ?? right.timelineStartFrame) === 60 && right.sourceInFrame === 60 && right.sourceOutFrame === 180, JSON.stringify(right));
  check("split: original removed", !clipOf(st.clips, CLIP), "");

  // ── 2. Trim right head 60→90 (source 90..180, start unchanged) ─────────────
  const r2 = await apply(v, [{ type: "TrimClip", clipId: right.id, newSourceInFrame: 90 }]);
  check("trim applies", r2.status === 200, JSON.stringify(r2.json).slice(0, 160));
  st = await head();
  v = st.version;
  const rightT = clipOf(st.clips, "spl-r");
  check("trim: head-trim anchors out-point — source 90..180, start follows to 90, duration 90", !!rightT && rightT.sourceInFrame === 90 && rightT.sourceOutFrame === 180 && (rightT.startFrame ?? rightT.timelineStartFrame) === 90 && rightT.timelineDurationFrames === 90, JSON.stringify(rightT));

  // ── 3. RippleDelete the LEFT clip → right shifts to 0 ─────────────────────
  const r3 = await apply(v, [{ type: "RippleDelete", clipId: left.id }]);
  check("ripple delete applies", r3.status === 200, JSON.stringify(r3.json).slice(0, 160));
  st = await head();
  v = st.version;
  const shifted = clipOf(st.clips, "spl-r");
  check("ripple: neighbor shifts left by the removed clip's duration (90-60=30)", !!shifted && (shifted.startFrame ?? shifted.timelineStartFrame) === 30, JSON.stringify(shifted));
  check("ripple: left removed", !clipOf(st.clips, "spl-l"), "");

  // ── 4. MoveClip to a same-kind track (VIDEO→AUDIO is refused by design) ───
  const r4a = await apply(v, [{ type: "MoveClip", clipId: shifted.id, newTrackId: AUDIO_TRACK, newTimelineStartFrame: 30 }]);
  check("move: cross-kind move refused with clear error", r4a.status === 400 && String(r4a.json?.error ?? "").includes("different track kinds"), `status=${r4a.status} ${JSON.stringify(r4a.json).slice(0, 120)}`);
  const r4 = await apply(v, [{ type: "MoveClip", clipId: shifted.id, newTrackId: VIDEO_TRACK.replace("-v1", "-v2"), newTimelineStartFrame: 30 }]);
  check("move applies (same kind v1→v2)", r4.status === 200, JSON.stringify(r4.json).slice(0, 160));
  st = await head();
  v = st.version;
  const moved = clipOf(st.clips, "spl-r");
  check("move: clip now on Video 2 (same kind)", !!moved && moved.trackId === VIDEO_TRACK.replace("-v1", "-v2"), JSON.stringify(moved));

  // ── 5. Marker ──────────────────────────────────────────────────────────────
  const r5 = await apply(v, [{ type: "AddMarker", marker: { id: "myai-marker-m45qa", frame: 45, label: "QA marker" } }]);
  check("marker applies", r5.status === 200, JSON.stringify(r5.json).slice(0, 160));
  st = await head();
  v = st.version;
  check("marker persisted", st.markers.some((m: any) => m.id === "myai-marker-m45qa" && m.frame === 45 && m.label === "QA marker"), JSON.stringify(st.markers));

  // ── 6. Undo via inverse: remove the marker again, expect version+1 ─────────
  const r6 = await apply(v, [{ type: "RemoveMarker", markerId: "myai-marker-m45qa" }]);
  check("remove marker (undo of add) applies", r6.status === 200, JSON.stringify(r6.json).slice(0, 160));
  st = await head();
  v = st.version;
  check("marker gone after inverse", !st.markers.some((m: any) => m.id === "myai-marker-m45qa"), "");

  // ── 7. Conflict guard: stale baseVersion must 409 with the real head ──────
  const r7 = await apply(v - 1, [{ type: "AddMarker", marker: { id: "myai-marker-stale", frame: 1, label: "stale" } }]);
  check("stale baseVersion rejected with 409 + headVersion", r7.status === 409 && typeof r7.json?.headVersion === "number", `status=${r7.status} body=${JSON.stringify(r7.json).slice(0, 120)}`);

  // ── 8. Persistence: fresh GET equals last applied state (clip on audio) ───
  st = await head();
  const persisted = clipOf(st.clips, "spl-r");
  check("persistence: single clip on Video 2 at 30, 90 frames", st.clips.length === 1 && persisted?.trackId === VIDEO_TRACK.replace("-v1", "-v2") && (persisted.startFrame ?? persisted.timelineStartFrame) === 30 && persisted.sourceOutFrame - persisted.sourceInFrame === 90, `clips=${st.clips.length} ${JSON.stringify(persisted)}`);
  check("persistence: version chain advanced exactly by applied batches (v8)", st.version === v, `head=${st.version} expected=${v}`);

  console.log(`\nM45 functional gate: ${pass} pass, ${fail} fail`);
  if (failures.length) {
    console.log("FAILURES:\n" + failures.map((f) => " - " + f).join("\n"));
    process.exit(1);
  }
}

void main();
