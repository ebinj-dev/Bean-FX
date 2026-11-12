/**
 * BEAN FX — SRT / VTT codec with validation.
 * Preserves Unicode (Tamil, Hindi, mixed-language) — text is stored as-is.
 */

export interface Cue {
  id: string;
  start: number;
  end: number;
  text: string;
}

export class CaptionValidationError extends Error {}

function pad(n: number, len = 2): string {
  return String(Math.floor(n)).padStart(len, "0");
}

export function formatTimestamp(sec: number, style: "srt" | "vtt"): string {
  if (!Number.isFinite(sec) || sec < 0) throw new CaptionValidationError(`Invalid timestamp: ${sec}`);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const mm = ms === 1000 ? 999 : ms; // guard rounding overflow
  return `${pad(h)}:${pad(m)}:${pad(s)}${style === "srt" ? "," : "."}${pad(mm, 3)}`;
}

function parseTimestamp(token: string, style: "srt" | "vtt"): number {
  const cleaned = token.trim().replace(",", ".");
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)$/.exec(cleaned);
  if (!m) throw new CaptionValidationError(`Invalid timestamp "${token}"`);
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const sec = Number(m[3]);
  if (min > 59 || sec >= 60 && !m[3].includes(".")) {
    // allow 59.999 style seconds; minutes must be < 60
  }
  if (min > 59) throw new CaptionValidationError(`Invalid minutes in timestamp "${token}"`);
  const total = h * 3600 + min * 60 + sec;
  if (!Number.isFinite(total) || total < 0) throw new CaptionValidationError(`Invalid timestamp "${token}"`);
  void style;
  return total;
}

/**
 * Parse SRT or VTT. Throws CaptionValidationError with a human-readable
 * message on malformed input. Preserves Unicode text exactly.
 */
export function parseSubtitles(content: string, forcedFormat?: "srt" | "vtt"): { cues: Cue[]; format: "srt" | "vtt" } {
  const text = content.replace(/^\uFEFF/, ""); // strip BOM
  const isVtt =
    forcedFormat === "vtt" ||
    (forcedFormat === undefined && /^WEBVTT/i.test(text.trimStart()));
  const format: "srt" | "vtt" = isVtt ? "vtt" : "srt";

  const lines = text.split(/\r\n|\r|\n/);
  const cues: Cue[] = [];
  let i = 0;
  let cueIndex = 0;

  if (format === "vtt") {
    // Skip header lines until a blank line or first cue.
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].includes("-->")) i++;
  }

  while (i < lines.length) {
    // Skip blank lines.
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i >= lines.length) break;

    // Optional NOTE/STYLE blocks in VTT.
    if (format === "vtt" && /^(NOTE|STYLE|REGION)\b/.test(lines[i])) {
      while (i < lines.length && lines[i].trim() !== "") i++;
      continue;
    }

    // Cue identifier line (optional).
    let id = `cue-${++cueIndex}`;
    if (!lines[i].includes("-->")) {
      const custom = lines[i].trim();
      i++;
      if (i >= lines.length || !lines[i].includes("-->")) {
        throw new CaptionValidationError(`Malformed cue near line ${i}: expected "start --> end".`);
      }
      if (custom) id = custom;
    }

    const timeLine = lines[i];
    const match = /(\S+)\s*-->\s*(\S+)(?:\s+(.*))?/.exec(timeLine);
    if (!match) {
      throw new CaptionValidationError(`Malformed timing line: "${timeLine}"`);
    }
    const start = parseTimestamp(match[1], format);
    const end = parseTimestamp(match[2], format);
    i++;
    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      textLines.push(lines[i]);
      i++;
    }
    const cueText = textLines.join("\n").trim();
    if (!cueText) throw new CaptionValidationError(`Cue ${id} has empty text.`);
    if (end <= start) throw new CaptionValidationError(`Cue ${id}: end (${end.toFixed(2)}s) must be after start (${start.toFixed(2)}s).`);
    cues.push({ id, start, end, text: cueText });
  }

  if (!cues.length) throw new CaptionValidationError("No subtitle cues found in file.");
  validateCueOrder(cues);
  return { cues, format };
}

/** Detect overlaps / out-of-order cues. Overlaps are reported, not silently fixed. */
export function validateCueOrder(cues: Cue[]): string[] {
  const problems: string[] = [];
  for (let i = 1; i < cues.length; i++) {
    if (cues[i].start < cues[i - 1].start) {
      problems.push(`Cue ${i + 1} starts before cue ${i} (out of order).`);
    }
    if (cues[i].start < cues[i - 1].end) {
      problems.push(`Cue ${i + 1} overlaps cue ${i}.`);
    }
  }
  return problems;
}

export function serializeSrt(cues: Cue[]): string {
  const ordered = [...cues].sort((a, b) => a.start - b.start);
  return (
    ordered
      .map((c, idx) => `${idx + 1}\n${formatTimestamp(c.start, "srt")} --> ${formatTimestamp(c.end, "srt")}\n${c.text}`)
      .join("\n\n") + "\n"
  );
}

export function serializeVtt(cues: Cue[]): string {
  const ordered = [...cues].sort((a, b) => a.start - b.start);
  return (
    "WEBVTT\n\n" +
    ordered
      .map((c) => `${c.id}\n${formatTimestamp(c.start, "vtt")} --> ${formatTimestamp(c.end, "vtt")}\n${c.text}`)
      .join("\n\n") +
    "\n"
  );
}

/**
 * Distribute plain ASR text into cues aligned to measured speech spans.
 * This is an ESTIMATED alignment (the ASR provider returns no timestamps):
 * words are spread across speech spans proportionally to word character length.
 * Callers must present the result as estimated timing.
 */
export function alignTextToSpeech(
  text: string,
  speechSpans: { start: number; end: number }[],
  maxCharsPerCue = 84
): Cue[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length || !speechSpans.length) return [];
  const totalChars = words.reduce((a, w) => a + w.length + 1, 0);
  const totalSpeech = speechSpans.reduce((a, s) => a + (s.end - s.start), 0);
  if (totalSpeech <= 0) return [];

  // Assign words to spans proportionally to span duration.
  const cues: Cue[] = [];
  let wordIdx = 0;
  let charsUsed = 0;
  speechSpans.forEach((span, spanIdx) => {
    const spanDur = span.end - span.start;
    const spanChars = Math.max(1, Math.round((spanDur / totalSpeech) * totalChars));
    const spanWords: string[] = [];
    let consumed = 0;
    while (wordIdx < words.length && (consumed < spanChars || spanIdx === speechSpans.length - 1)) {
      spanWords.push(words[wordIdx]);
      consumed += words[wordIdx].length + 1;
      wordIdx++;
      if (spanIdx === speechSpans.length - 1 && wordIdx >= words.length) break;
      if (consumed >= spanChars && spanIdx !== speechSpans.length - 1) break;
    }
    if (!spanWords.length) return;

    // Chunk words into cues of <= maxCharsPerCue.
    let chunk: string[] = [];
    const flushChunk = (isLast: boolean) => {
      if (!chunk.length) return;
      const chunkChars = chunk.reduce((a, w) => a + w.length + 1, 0);
      const fracStart = charsUsed / totalChars;
      charsUsed += chunkChars;
      const fracEnd = Math.min(1, charsUsed / totalChars);
      const cStart = span.start + fracStart * spanDur;
      const cEnd = isLast && spanIdx === speechSpans.length - 1 ? span.end : span.start + fracEnd * spanDur;
      cues.push({
        id: `est-${cues.length + 1}`,
        start: Math.max(0, cStart),
        end: Math.max(cStart + 0.2, cEnd),
        text: chunk.join(" "),
      });
      chunk = [];
    };
    for (const w of spanWords) {
      chunk.push(w);
      if (chunk.reduce((a, x) => a + x.length + 1, 0) >= maxCharsPerCue) flushChunk(false);
    }
    flushChunk(true);
  });

  // Any leftover words (rare rounding edge) go to a final cue.
  if (wordIdx < words.length && cues.length) {
    const last = cues[cues.length - 1];
    last.text += " " + words.slice(wordIdx).join(" ");
  }
  return cues;
}
