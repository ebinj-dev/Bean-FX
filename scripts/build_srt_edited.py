#!/usr/bin/env python3
"""Deliverable B: edited_audio_accurate.srt from RIISHE's transcript of the
uploaded edited(2).mp3 (952.372s), independently aligned by the pipeline —
no original-recording timestamps reused. Reports sync stats vs reference."""
import json
import re


def fmt(t):
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def words_to_cues(words, fallback_text, seg_start, seg_end, max_chars=84, max_dur=7.0):
    if not words:
        return [(seg_start, seg_end, fallback_text)]
    cues, cur = [], []
    cur_start = words[0]["start"]

    def flush():
        if not cur:
            return
        text = " ".join(w["text"] for w in cur).strip()
        if text:
            cues.append((cur_start, max(cur[-1]["end"], cur_start + 0.4), text))
        cur.clear()

    for w in words:
        cur.append(w)
        text_now = " ".join(x["text"] for x in cur)
        if (re.search(r"[,.;:!?।…]$|[।॥]$", w["text"]) and len(text_now) >= 30) or len(text_now) >= max_chars or (w["end"] - cur_start) >= max_dur:
            flush()
            if words.index(w) + 1 < len(words):
                cur_start = words[words.index(w) + 1]["start"]
    flush()
    return cues


d = json.load(open("/home/z/my-project/media-store/analysis-results/cmw8mvlx5000br4vl0jfur3qp.json"))
segs = d["transcript"]["segments"]
cues = []
for seg in segs:
    cues.extend(words_to_cues(seg.get("words") or [], seg["text"], seg["start"], seg["end"]))
print(f"edited transcript: {len(segs)} segments, {sum(len(s.get('words',[])) for s in segs)} words -> {len(cues)} cues")

with open("/home/z/my-project/download/edited_audio_accurate.srt", "w", encoding="utf-8") as f:
    prev_end = 0.0
    for i, (s, e, t) in enumerate(cues, 1):
        s2 = max(s, prev_end)  # cues never overlap
        e2 = max(e, s2 + 0.4)
        f.write(f"{i}\n{fmt(s2)} --> {fmt(e2)}\n{t}\n\n")
        prev_end = e2
print("written: download/edited_audio_accurate.srt")
print(f"coverage: {cues[0][0]:.2f}s -> {cues[-1][1]:.2f}s (file 952.372s)")

# sanity: compare word count against reference edited SRT
txt = open("/home/z/my-project/upload/edited_audio.srt", encoding="utf-8", errors="replace").read()
ref_words = re.sub(r"[^a-z0-9 ]", "", txt.lower()).split()
mine = re.sub(r"[^a-z0-9 ]", "", " ".join(t for _, _, t in cues).lower()).split()
print(f"word counts: RIISHE {len(mine)} vs reference SRT {len(ref_words)}")
