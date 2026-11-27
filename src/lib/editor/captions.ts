/**
 * M48-F — caption sidecar export (SRT) from the canonical timeline.
 *
 * Captions live as CAPTION-track clips in the ONE canonical sequence; this
 * module renders them to a SubRip sidecar WITHOUT inventing or re-timing
 * anything: cue start/end come from the clip's timeline frames converted to
 * wall-clock at the SEQUENCE fps (SRT is wall-clock, not frame-accurate —
 * rounding is documented). Empty/whitespace caption text is skipped honestly.
 */
import type { Sequence } from "./model";

export function sequenceToSrt(sequence: Sequence): string {
  const fpsNum = sequence.fps.num;
  const fpsDen = sequence.fps.den;
  const cues = sequence.clips
    .filter((c) => c.trackId && sequence.tracks.find((t) => t.id === c.trackId)?.kind === "CAPTION")
    .filter((c) => typeof c.captionText === "string" && c.captionText.trim().length > 0)
    .sort((a, b) => a.timelineStartFrame - b.timelineStartFrame);

  const stamp = (frame: number): string => {
    const seconds = (frame * fpsDen) / fpsNum;
    const totalMs = Math.round(seconds * 1000);
    const ms = totalMs % 1000;
    const totalSec = Math.floor(totalMs / 1000);
    const ss = totalSec % 60;
    const mm = Math.floor(totalSec / 60) % 60;
    const hh = Math.floor(totalSec / 3600);
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${pad(hh)}:${pad(mm)}:${pad(ss)},${pad(ms, 3)}`;
  };

  return (
    cues
      .map((c, i) => {
        const start = stamp(c.timelineStartFrame);
        const end = stamp(c.timelineStartFrame + Math.max(1, c.timelineDurationFrames));
        return `${i + 1}\n${start} --> ${end}\n${c.captionText!.trim()}`;
      })
      .join("\n\n") + (cues.length > 0 ? "\n" : "")
  );
}
