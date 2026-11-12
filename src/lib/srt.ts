/**
 * BEAN FX — SRT reference support for RIISHE.
 *
 * Parses SubRip files (preserving original text, cue order and timestamps),
 * matches subtitles against the real ASR transcript of the media, reports
 * coverage / gaps / duplicates, and — when speech-energy spans are available —
 * converts an SRT interval into a SAFE removal interval that cannot clip the
 * neighbouring narration. An SRT timestamp is never treated as verified audio
 * timing: every comparison is measured against the actual media.
 *
 * These functions are pure (no I/O) and unit-testable.
 */

export interface SrtCue {
  /** Original cue number as written in the file (may repeat or be missing). */
  index: number;
  /** Position of the cue in the file (1-based, order of appearance). */
  ordinal: number;
  start: number;
  end: number;
  /** Original text, exactly as in the file (minus the timing line). */
  text: string;
  /** Text with [cite: n] markers and speaker line breaks normalized. */
  normalizedText: string;
}

export interface SrtParseResult {
  cues: SrtCue[];
  errors: string[];
}

const TIME_LINE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function timeToSec(h: string, m: string, s: string, ms: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, "0")) / 1000;
}

/** Strip [cite: n] markers and collapse whitespace — matching only; the
 *  original text is preserved on the cue. */
export function normalizeCueText(text: string): string {
  return text
    .replace(/\[cite:\s*\d+\]/gi, " ")
    .replace(/<\/?[^>]{1,40}>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseSrt(content: string): SrtParseResult {
  const errors: string[] = [];
  const cues: SrtCue[] = [];
  const bomless = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const blocks = bomless.split(/\n{2,}/);
  let ordinal = 0;
  for (const block of blocks) {
    const lines = block.split("\n").filter((l, i) => l.trim().length > 0 || i > 0);
    if (lines.length === 0 || (lines.length === 1 && lines[0].trim() === "")) continue;
    const timeLineIdx = lines.findIndex((l) => TIME_LINE.test(l));
    if (timeLineIdx === -1) {
      const head = block.trim().slice(0, 40).replace(/\n/g, " ");
      if (head) errors.push(`Block without a timing line skipped: "${head}"`);
      continue;
    }
    const m = lines[timeLineIdx].match(TIME_LINE)!;
    const start = timeToSec(m[1], m[2], m[3], m[4]);
    const end = timeToSec(m[5], m[6], m[7], m[8]);
    const text = lines.slice(timeLineIdx + 1).join("\n").trim();
    if (!text) {
      errors.push(`Cue at ${start.toFixed(2)}s has no text — skipped.`);
      continue;
    }
    if (end <= start) {
      errors.push(`Cue at ${start.toFixed(2)}s ends before it starts — kept with clamped end.`);
    }
    let index = ordinal + 1;
    if (timeLineIdx > 0) {
      const parsed = Number(lines[0].trim());
      if (Number.isInteger(parsed) && parsed >= 0) index = parsed;
    }
    ordinal += 1;
    cues.push({ index, ordinal, start, end: Math.max(end, start), text, normalizedText: normalizeCueText(text) });
  }
  if (cues.length === 0) errors.push("No valid SRT cues found.");
  return { cues, errors };
}

/* ----------------------- matching against media ------------------------ */

export function tokens(text: string): string[] {
  return normalizeCueText(text)
    .toLowerCase()
    .replace(/[.,!?;:"'`’“”()\[\]…—–-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

export interface SrtMatchResult {
  /** Per-cue best matching transcript segment (or null) and time offsets. */
  perCue: { cue: SrtCue; segmentId: string | null; offsetSec: number | null; similarity: number }[];
  /** Offsets with decent similarity — the basis for the drift statement. */
  offsetsSec: number[];
  medianOffsetSec: number | null;
  /** |offset| growth between the first and last third of the file. */
  driftSec: number | null;
  matchedCount: number;
}

/** Match SRT cues to transcript segments by token overlap.
 *
 * Cues and ASR segments never correspond 1:1 — the ASR merges or splits
 * sentences and boundary joins stitch fragments, so a per-segment best-match
 * drifts into wrong (later) segments and reports impossible offsets. The
 * matcher therefore works on the WORD stream: for each cue it slides a window
 * of the cue's own token count over the transcript words, searching FORWARD
 * ONLY from the previous cue's match (order-preserving by construction), and
 * anchors the cue at the window with the highest containment. A cue's offset
 * is then measured against where its text actually begins in the media. */
export function matchSrtToTranscript(
  cues: SrtCue[],
  segments: { id: string; start: number; end: number; text: string; words?: { text: string; start: number; end: number }[] }[]
): SrtMatchResult {
  const perCue: SrtMatchResult["perCue"] = [];
  const offsetsSec: number[] = [];

  // Flatten the transcript into a word stream with segment ownership.
  const words: { tk: string; start: number; seg: number }[] = [];
  segments.forEach((seg, si) => {
    for (const w of seg.words ?? []) {
      const tk = tokens(w.text)[0] ?? "";
      if (tk) words.push({ tk, start: w.start, seg: si });
    }
  });

  const MATCH_MIN = 0.5; // containment required to call a cue matched
  let searchFrom = 0; // first word index the next cue may anchor at
  for (const cue of cues) {
    const ctk = tokens(cue.text);
    if (!ctk.length || words.length === 0) {
      perCue.push({ cue, segmentId: null, offsetSec: null, similarity: 0 });
      continue;
    }
    const W = Math.min(ctk.length, Math.max(1, words.length));
    const cset = new Set(ctk);
    let best: { idx: number; score: number } | null = null;
    for (let idx = searchFrom; idx + W <= words.length; idx++) {
      const set = new Set<string>();
      for (let k = 0; k < W; k++) set.add(words[idx + k].tk);
      let shared = 0;
      for (const t of cset) if (set.has(t)) shared += 1;
      const containment = shared / ctk.length;
      if (!best || containment > best.score) best = { idx, score: containment };
      if (best.score === 1) break;
    }
    const usable = Boolean(best && best.score >= MATCH_MIN);
    if (usable) {
      searchFrom = best!.idx + Math.max(1, Math.floor(W * 0.5)); // monotonic: next cue starts near this window's end
      // Anchor where the cue's spoken words BEGIN: the first word of the best
      // window that is a cue token (skipping articles/prepositions — a window
      // that slid past sentence-initial filler words must not anchor on "a").
      const STOP = new Set(["a", "an", "the", "of", "and", "in", "on", "to", "for", "with", "is", "was", "i", "my", "we", "it"]);
      let anchor = best!.idx;
      for (let k = best!.idx; k < best!.idx + W; k++) {
        if (cset.has(words[k].tk) && !STOP.has(words[k].tk)) {
          anchor = k;
          break;
        }
      }
      const seg = segments[words[anchor].seg];
      perCue.push({ cue, segmentId: seg.id, offsetSec: Math.round((words[anchor].start - cue.start) * 100) / 100, similarity: Math.round(best!.score * 100) / 100 });
      offsetsSec.push(words[anchor].start - cue.start);
    } else {
      perCue.push({ cue, segmentId: null, offsetSec: null, similarity: best ? Math.round(best.score * 100) / 100 : 0 });
    }
  }

  const median = offsetsSec.length ? [...offsetsSec].sort((a, b) => a - b)[Math.floor(offsetsSec.length / 2)] : null;
  let drift: number | null = null;
  if (offsetsSec.length >= 6) {
    const third = Math.floor(offsetsSec.length / 3);
    const first = offsetsSec.slice(0, third).reduce((a, b) => a + b, 0) / third;
    const last = offsetsSec.slice(-third).reduce((a, b) => a + b, 0) / (offsetsSec.length - 2 * third);
    drift = Math.round((last - first) * 100) / 100;
  }
  return { perCue, offsetsSec, medianOffsetSec: median, driftSec: drift, matchedCount: offsetsSec.length };
}

export interface SrtCoverage {
  cueCount: number;
  firstStartSec: number | null;
  lastEndSec: number | null;
  /** Time covered by cues (union, overlaps merged). */
  coveredSec: number;
  /** Fraction of the media duration covered by cues (0..1). */
  coverageRatio: number | null;
  /** Holes inside [firstStart, lastEnd] longer than 5 s with no cue. */
  missingRanges: { start: number; end: number; duration: number }[];
  /** Cues overlapping each other (possible duplicates or double subtitles). */
  duplicates: { a: number; b: number; start: number; end: number }[];
  /** Cues whose text near-duplicates another cue (repeated takes). */
  repeatedText: { a: number; b: number; similarity: number; text: string }[];
}

export function srtCoverage(cues: SrtCue[], durationSec: number | null): SrtCoverage {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const c of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && c.start <= prev.end + 1e-6) prev.end = Math.max(prev.end, c.end);
    else merged.push({ start: c.start, end: c.end });
  }
  const covered = merged.reduce((a, m) => a + (m.end - m.start), 0);
  const first = sorted.length ? sorted[0].start : null;
  const last = sorted.length ? Math.max(...sorted.map((c) => c.end)) : null;
  const missing: SrtCoverage["missingRanges"] = [];
  for (let i = 1; i < merged.length; i++) {
    const gap = merged[i].start - merged[i - 1].end;
    if (gap > 5) missing.push({ start: Math.round(merged[i - 1].end * 100) / 100, end: Math.round(merged[i].start * 100) / 100, duration: Math.round(gap * 100) / 100 });
  }
  const duplicates: SrtCoverage["duplicates"] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && sorted[j].start < sorted[i].end; j++) {
      duplicates.push({ a: sorted[i].ordinal, b: sorted[j].ordinal, start: sorted[i].start, end: Math.min(sorted[i].end, sorted[j].end) });
    }
  }
  const repeated: SrtCoverage["repeatedText"] = [];
  const tk = sorted.map((c) => tokens(c.text));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].start - sorted[i].start > 600) break;
      const sim = jaccard(tk[i], tk[j]);
      if (sim >= 0.7 && tk[i].length >= 4) {
        repeated.push({ a: sorted[i].ordinal, b: sorted[j].ordinal, similarity: Math.round(sim * 100) / 100, text: sorted[i].normalizedText.slice(0, 90) });
      }
    }
  }
  return {
    cueCount: cues.length,
    firstStartSec: first,
    lastEndSec: last,
    coveredSec: Math.round(covered * 100) / 100,
    coverageRatio: durationSec ? Math.round((covered / durationSec) * 1000) / 1000 : null,
    missingRanges: missing,
    duplicates,
    repeatedText: repeated,
  };
}

/* ------------------- safe interval from an SRT range -------------------- */

export interface SafeIntervalResult {
  /** The SRT reference interval (verbatim from the file). */
  reference: { start: number; end: number };
  /** Interval adjusted to actual speech-energy boundaries, or null when no
   *  safe cut exists (e.g. the range is welded into continuous narration). */
  safe: { start: number; end: number } | null;
  /** What was adjusted and why (never invented — measured from the spans). */
  adjustments: string[];
  /** True when the SRT range overlaps BOTH narration on either side with no
   *  measurable silence inside. */
  unsafe: boolean;
  /** Speech spans (seconds of measured speech) inside the reference range. */
  speechInsideSec: number;
}

/**
 * Convert an SRT reference interval into a removal interval that respects the
 * ACTUAL audio: the start may not clip the end of the previous sentence and
 * the end may not clip the beginning of the next one. When the range sits in
 * continuous speech the result is marked unsafe instead of guessing.
 */
export function safeIntervalFromSrt(
  reference: { start: number; end: number },
  speechSpans: { start: number; end: number }[],
  opts: { headPadSec?: number; tailPadSec?: number } = {}
): SafeIntervalResult {
  const headPad = opts.headPadSec ?? 0.15;
  const tailPad = opts.tailPadSec ?? 0.2;
  const adjustments: string[] = [];
  const inside = speechSpans.filter((s) => s.end > reference.start && s.start < reference.end);
  const speechInsideSec = Math.round(inside.reduce((a, s) => a + (Math.min(s.end, reference.end) - Math.max(s.start, reference.start)), 0) * 100) / 100;

  let start = reference.start;
  let end = reference.end;

  // Do not clip the PREVIOUS sentence: if a speech span is still running at
  // the range start, begin after it ends (plus head padding).
  const spanAtStart = speechSpans.find((s) => s.start < reference.start && s.end > reference.start);
  if (spanAtStart) {
    start = spanAtStart.end + headPad;
    adjustments.push(`start moved to ${start.toFixed(2)}s — the previous sentence runs until ${spanAtStart.end.toFixed(2)}s (+${headPad}s head padding)`);
  }
  // Do not clip the NEXT sentence: if a speech span is already running at the
  // range end, stop before it begins (minus tail padding).
  const spanAtEnd = speechSpans.find((s) => s.start < reference.end && s.end > reference.end);
  if (spanAtEnd) {
    end = spanAtEnd.start - tailPad;
    adjustments.push(`end moved to ${end.toFixed(2)}s — the next sentence starts at ${spanAtEnd.start.toFixed(2)}s (−${tailPad}s tail padding)`);
  }

  // The reference range must still contain measurable silence to cut; a range
  // welded into continuous narration is unsafe, never guessed.
  const silenceInside = Math.max(0, end - start) - speechInsideSec;
  const unsafe = end - start <= 0.05 || silenceInside < 0.05;
  if (unsafe) adjustments.push("no measurable silence inside the adjusted range — not proposed as a cut");
  return {
    reference,
    safe: unsafe ? null : { start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 },
    adjustments,
    unsafe,
    speechInsideSec,
  };
}
