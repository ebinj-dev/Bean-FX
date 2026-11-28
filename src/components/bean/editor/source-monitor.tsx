"use client";
/**
 * M48-C — Source Monitor with three-point editing.
 *
 * The audit found the editor had NO source monitor: placement always inserted
 * the FULL asset at the playhead, and compileInsert/compileOverwrite in
 * lib/editor/edits.ts were dead code. This panel completes the professional
 * source→record workflow without touching the engine:
 *
 *   - Load a media asset (from the Media Browser), inspect it in its OWN
 *     timebase (probe fps), mark IN/OUT frame-exactly.
 *   - INSERT  → compileInsert: push the rest of the target track right.
 *   - OVERWRITE → compileOverwrite: trim/split/remove overlapped clips.
 *   - APPEND  → place at the end of the target track.
 *
 * All three compile to canonical reversible commands applied through the ONE
 * executor (session.apply) — same commands a manual drag would produce.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import type { EditorSession } from "@/hooks/use-editor-session";
import { compileInsert, compileOverwrite } from "@/lib/editor/edits";
import { rationalFromFps, crossTimebase, formatTimecode } from "@/lib/editor/time";

export interface SourceAssetSummary {
  id: string;
  originalName: string;
  kind: string;
  mimeType: string;
  durationSec: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
}

function assetFramesToTimeline(sourceFrames: number, assetFps: { num: number; den: number }, seqFps: { num: number; den: number }): number {
  return Math.max(1, crossTimebase(Math.round(sourceFrames), assetFps, seqFps));
}

export function SourceMonitor({
  session,
  assets,
  onNotice,
  initialAssetId,
}: {
  session: EditorSession;
  assets: SourceAssetSummary[];
  onNotice?: (m: string | null) => void;
  initialAssetId?: string | null;
}) {
  const seq = session.sequence;
  const [assetId, setAssetId] = useState<string | null>(initialAssetId ?? null);
  const [inFrame, setInFrame] = useState<number | null>(null);
  const [outFrame, setOutFrame] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [cursorFrame, setCursorFrame] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const asset = useMemo(() => assets.find((a) => a.id === assetId) ?? null, [assets, assetId]);
  const assetFps = useMemo(() => rationalFromFps(asset?.fps && asset.fps > 0 ? asset.fps : 30), [asset]);

  // M48-C — reset the marks when the loaded asset changes. Adjusting state
  // during render (React's documented pattern) instead of an effect keeps the
  // reset atomic and avoids cascading renders.
  const [lastAssetId, setLastAssetId] = useState<string | null>(assetId);
  if (lastAssetId !== assetId) {
    setLastAssetId(assetId);
    setInFrame(null);
    setOutFrame(null);
    setCursorFrame(0);
    setPlaying(false);
  }

  // Probe-frame cursor: the video element runs in wall time; the source
  // timebase is asset fps (probe), so currentTime × fps → integer frames.
  const onTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    setCursorFrame(Math.max(0, Math.round(v.currentTime * (assetFps.num / assetFps.den))));
  }, [assetFps]);

  const step = useCallback((delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    setPlaying(false);
    const fpsN = assetFps.num / assetFps.den;
    const next = Math.max(0, v.currentTime + delta / fpsN);
    v.currentTime = next;
  }, [assetFps]);

  const totalFrames = asset?.durationSec ? Math.floor(asset.durationSec * (assetFps.num / assetFps.den)) : 0;
  const durationSource = inFrame !== null && outFrame !== null && outFrame > inFrame ? outFrame - inFrame : 0;

  const targetTrack = useMemo(() => {
    if (!seq) return null;
    return seq.tracks.find((t) => t.kind === "VIDEO" && !t.locked) ?? null;
  }, [seq]);

  const buildClip = useCallback(() => {
    if (!seq || !asset || !targetTrack || durationSource < 1) return null;
    const tlDur = assetFramesToTimeline(durationSource, assetFps, seq.fps);
    return {
      id: session.newId("clip"),
      trackId: targetTrack.id,
      sourceAssetId: asset.id,
      sourceInFrame: inFrame!,
      sourceOutFrame: outFrame!,
      sourceFps: assetFps,
      timelineStartFrame: 0, // set by the compiler (insert/overwrite place it)
      timelineDurationFrames: tlDur,
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
      label: asset.originalName,
      missingMedia: false,
      pan: 0,
      groupId: null,
      effects: [],
      audioSourceInFrame: null,
  audioSourceOutFrame: null,
  avLinked: true,
  keyframes: [],
    };
  }, [seq, asset, targetTrack, durationSource, inFrame, outFrame, assetFps, session]);

  const doInsert = useCallback(() => {
    if (!seq || !asset || !targetTrack) return onNotice?.("Load a source and pick a target track first.");
    if (durationSource < 1) return onNotice?.("Mark an IN and an OUT point first.");
    const clip = buildClip();
    if (!clip) return;
    const op = compileInsert(seq, targetTrack.id, session.playheadFrame, clip);
    if (!op) return onNotice?.("Insert refused — the target track is locked.");
    if (session.apply(op.commands)) onNotice?.(op.summary);
    else onNotice?.("Insert refused — the batch failed validation (nothing changed).");
  }, [seq, asset, targetTrack, durationSource, buildClip, session, onNotice]);

  const doOverwrite = useCallback(() => {
    if (!seq || !asset || !targetTrack) return onNotice?.("Load a source and pick a target track first.");
    if (durationSource < 1) return onNotice?.("Mark an IN and an OUT point first.");
    const clip = buildClip();
    if (!clip) return;
    const placed = { ...clip, timelineStartFrame: session.playheadFrame };
    const op = compileOverwrite(seq, targetTrack.id, placed);
    if (!op) return onNotice?.("Overwrite refused — an overlapped clip cannot absorb the edit.");
    if (session.apply(op.commands)) onNotice?.(op.summary);
    else onNotice?.("Overwrite refused — the batch failed validation (nothing changed).");
  }, [seq, asset, targetTrack, durationSource, buildClip, session, onNotice]);

  const doAppend = useCallback(() => {
    if (!seq || !asset || !targetTrack) return onNotice?.("Load a source and pick a target track first.");
    if (durationSource < 1) return onNotice?.("Mark an IN and an OUT point first.");
    const clip = buildClip();
    if (!clip) return;
    let end = 0;
    for (const c of seq.clips.filter((c) => c.trackId === targetTrack.id)) end = Math.max(end, c.timelineStartFrame + c.timelineDurationFrames);
    const op = compileInsert(seq, targetTrack.id, end, clip);
    if (!op) return onNotice?.("Append refused — the target track is locked.");
    if (session.apply(op.commands)) onNotice?.(op.summary);
    else onNotice?.("Append refused — the batch failed validation (nothing changed).");
  }, [seq, asset, targetTrack, durationSource, buildClip, session, onNotice]);

  const btn = "rounded border border-[#2a2a2a] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017] disabled:opacity-40";
  return (
    <div className="flex gap-2 border-b border-[#2a2a2a] bg-[#0b0b0a] p-2" data-testid="source-monitor">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="bean-label text-[9px] text-[#d4a017]">SOURCE MONITOR</span>
          <select
            value={assetId ?? ""}
            onChange={(e) => setAssetId(e.target.value || null)}
            className="min-w-0 flex-1 rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-[10px] text-[#e6e6e0]"
            title="Load source media"
          >
            <option value="">— select media —</option>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.originalName}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-h-[132px] items-center justify-center rounded border border-[#1c1c1a] bg-black">
          {asset ? (
            <video
              ref={videoRef}
              src={`/api/media/${asset.id}/file`}
              onTimeUpdate={onTimeUpdate}
              onEnded={() => setPlaying(false)}
              playsInline
              className="max-h-[168px] max-w-full"
              data-testid="source-video"
            />
          ) : (
            <span className="text-[10px] text-[#5a5a56]">Load media from the Media panel, mark IN/OUT, then insert, overwrite or append.</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" className={btn} onClick={() => (playing ? (videoRef.current?.pause(), setPlaying(false)) : (void videoRef.current?.play(), setPlaying(true)))} disabled={!asset}>
            {playing ? "PAUSE" : "PLAY"}
          </button>
          <button type="button" className={btn} onClick={() => step(-1)} disabled={!asset} title="Step source back one frame">−1f</button>
          <button type="button" className={btn} onClick={() => step(1)} disabled={!asset} title="Step source forward one frame">+1f</button>
          <span className="min-w-[104px] text-center font-mono text-[10px] text-[#e6e6e0]">{formatTimecode(cursorFrame, assetFps)} / {formatTimecode(totalFrames, assetFps)}</span>
          <button type="button" className={btn} onClick={() => setInFrame(cursorFrame)} disabled={!asset} title="Mark source IN at the cursor">SET IN</button>
          <button type="button" className={btn} onClick={() => setOutFrame(cursorFrame)} disabled={!asset} title="Mark source OUT at the cursor">SET OUT</button>
          <button type="button" className={btn} onClick={() => { setInFrame(null); setOutFrame(null); }} disabled={inFrame === null && outFrame === null}>CLR</button>
          <span className="text-[9px] text-[#8f8f8a]">
            {inFrame !== null && outFrame !== null && outFrame > inFrame ? `range ${inFrame}–${outFrame} (${durationSource} src frames)` : inFrame !== null ? `IN ${inFrame}` : "no range"}
          </span>
        </div>
      </div>
      <div className="flex w-[118px] shrink-0 flex-col justify-center gap-1.5">
        <span className="bean-label text-[8px] text-[#7a7a76]">EDIT → {targetTrack ? targetTrack.name || targetTrack.kind : "no target"}</span>
        <button type="button" className={btn} onClick={doInsert} disabled={durationSource < 1} title="Insert: push the rest of the track right">INSERT</button>
        <button type="button" className={btn} onClick={doOverwrite} disabled={durationSource < 1} title="Overwrite: replace the overlapped region">OVERWRITE</button>
        <button type="button" className={btn} onClick={doAppend} disabled={durationSource < 1} title="Append at the end of the target track">APPEND</button>
      </div>
    </div>
  );
}
