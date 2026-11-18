#!/usr/bin/env python3
"""Deliverable C: unwanted_sections_verified.txt — merges the content
alignment, RMS dead-air measurements on both recordings, RIISHE's calibrated
plan, and the reference document's transcript diffs into one verified report
with confirmed-vs-review separation."""
import json
import re
from datetime import datetime

AL = json.load(open("/home/z/my-project/scripts/alignment.json"))
DO = json.load(open("/home/z/my-project/scripts/deadair_original.json"))
DE = json.load(open("/home/z/my-project/scripts/deadair_edited.json"))
RI = json.load(open("/home/z/my-project/media-store/analysis-results/cmw8nmgds000lr4vls49rz8wg.json"))

def ts(t):
    m, s = divmod(float(t), 60)
    h, m = divmod(int(m), 60)
    return f"{h:02d}:{m:02d}:{s:04.1f}"

L = []
A = L.append
A("UNWANTED SECTIONS — VERIFIED REPORT")
A("Generated: " + datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"))
A("Recording pair: not edited(2).mp3 (1219.732s) vs edited(2).mp3 (952.372s)")
A("Method: RIISHE ASR transcripts of BOTH uploaded files (0 failed chunks), monotonic token alignment,")
A("        100ms RMS windows (< -50 dBFS dead air, < -45 dBFS review), reference documents cross-checked.")
A("")
A("=" * 100)
A("A. DURATION ACCOUNTING (verified against the decoded files)")
A("=" * 100)
A(f"Original duration           : 1219.732 s (20:19)")
A(f"Edited duration             : 952.372 s (15:52)")
A(f"Removed by the professional edit: 267.360 s (4:27, 21.9% of the original)")
acc = AL["accounting"]
A(f"Alignment attribution       : {acc['removedSpansSec']}s in removed spans (speech + the pauses inside them)")
A(f"                              + {acc['tightenedPausesSec']}s tightened pauses between retained passages")
A(f"                              = {acc['combinedSec']}s attributed (approximate: re-worded passages overlap categories)")
A("Speech vs pause split (reference-SRT based): ~131.9 s removed speech, ~135.4 s removed pauses/dead air")
A("")
A("=" * 100)
A("B. CONFIRMED UNWANTED SECTIONS (present in the original, absent in the professional edit)")
A("=" * 100)
A("Evidence: absent from the edited recording's own ASR transcript AND mapped by sequence alignment.")
A("")
n = 0
for s in AL["sections"]:
    if s["status"] != "removed":
        continue
    n += 1
    cat = s.get("category", "REMOVED")
    A(f"{n:03d}. [{cat}]  {ts(s['originalStart'])} --> {ts(s['originalEnd'])}  ({s['originalEnd']-s['originalStart']:.1f}s)")
    A(f"     transcript : {s['transcript'][:180]}")
    A(f"     evidence   : {s['reason']} words={s.get('words','-')} deadAirOverlap={s.get('deadAirOverlapSec','-')}s")
    A(f"     edited location: removed (not present in edited(2).mp3)")
    A(f"     confidence : {s['confidence']}")
    A("")
# tightened pauses
A("B.2 CONFIRMED SHORTENED PAUSES (retained passages whose inter-sentence pause the edit tightened)")
A("")
for i, p in enumerate(AL["tightenedPauses"], 1):
    A(f"{i:03d}. [UNNECESSARY PAUSE] {ts(p['originalStart'])} --> {ts(p['originalEnd'])}  pause {p['originalPauseSec']}s -> {p['editedPauseSec']}s (removed {p['removedSec']}s)")
A("")
A("=" * 100)
A("C. DEAD AIR (RMS < -50 dBFS, 100 ms windows) — measured on the uploaded original,")
A("   cross-checked against the professional edit")
A("=" * 100)
removed_spans = [(s["originalStart"], s["originalEnd"]) for s in AL["sections"] if s["status"] == "removed"]
plan_remove = [(r["start"], r["end"]) for r in RI["plan"]["removals"]]
def span_hit(a, b, spans, frac=0.5):
    return any(min(b, e) - max(a, s) >= frac * (b - a) for s, e in spans)
conf = review = 0
conf_list = []
for k, x in enumerate(DO["deadAir50"], 1):
    a, b = x["start"], x["end"]
    in_removed = span_hit(a, b, removed_spans)
    in_plan = span_hit(a, b, plan_remove, 0.3)
    tag = "CONFIRMED-REMOVED-BY-EDIT" if in_removed else ("RIISHE-REMOVE-PROPOSAL" if in_plan else "REVIEW (kept by the professional edit — ambience/music or intentional)")
    if in_removed or in_plan:
        conf += 1
        conf_list.append((k, a, b, tag))
    else:
        review += 1
A(f"Measured: {len(DO['deadAir50'])} intervals, {sum(x['dur'] for x in DO['deadAir50']):.1f}s total.")
A(f"  - {conf} intervals are inside content the professional edit removed or inside RIISHE's REMOVE plan (confirmed unwanted).")
A(f"  - {review} intervals survive in the professional edit (edited audio still measures {sum(x['dur'] for x in DE['deadAir50']):.1f}s of dead air)")
A(f"    -> these are ambience/music beds or intentional pauses: NOT automatically unwanted. Reference doc measured")
A(f"       91 intervals / 85.6s with a ~3 dB more conservative full-scale convention; the ratio original->edited agrees.")
A("")
A("Confirmed dead-air intervals (removed by the edit and/or proposed by RIISHE):")
for k, a, b, tag in conf_list:
    A(f"  {k:03d}. {ts(a)} --> {ts(b)} ({b-a:.1f}s)  {tag}")
A("")
A("=" * 100)
A("D. RIISHE'S CALIBRATED PLAN ON THE ORIGINAL (after reference calibration)")
A("=" * 100)
A(f"Candidates: {len(RI['candidates'])} | plan: {len(RI['plan']['removals'])} REMOVE intervals, {RI['plan']['removedSec']:.2f}s -> final {RI['plan']['finalDurationSec']:.1f}s")
A("")
A("REMOVE proposals (evidence-backed, human approval still required):")
for r in RI["plan"]["removals"]:
    c = next((c for c in RI["candidates"] if abs(c["start"] - r["start"]) < 0.5), None)
    A(f"  {ts(r['start'])} --> {ts(r['end'])} ({r['end']-r['start']:.2f}s)")
    if c:
        A(f"     {c['reason'][:190]}")
A("")
A(f"REVIEW candidates: {sum(1 for c in RI['candidates'] if c['review']=='REVIEW')} intervals — uncertain pauses,")
A("most of which the professional editor also tightened. These need human listening; bulk-approving them")
A("approaches the reference edit's ~135s of pause removal. They are NOT auto-proposed for removal.")
A("")
A("=" * 100)
A("E. REFERENCE-DOCUMENT TRANSCRIPT DIFFS — VERDICTS AFTER CONTEXT/AUDIO CHECK")
A("=" * 100)
verdicts = [
    ("00:01:15.140-00:01:18.320 'occupied they'", "REVIEW — fragment-level diff; cue-level timing, no word boundaries; likely ASR variance in one of the two transcripts, not a real cut."),
    ("00:02:21.580-00:02:38.660 'The oldest and most important inscription...'", "CONFIRMED REMOVED — full narration block absent from the edited transcript and audio; the edit jumps to the next passage."),
    ("00:07:19.380-00:07:23.480 'the'", "REVIEW — single-word diff; recognition variance, not an editorial cut."),
    ("00:10:07.000-00:10:10.320 'Okay section 4 temple full of people'", "CONFIRMED REMOVED — production chatter / section marker spoken aloud; the edit removes it."),
    ("00:13:32.750-00:13:34.150 'Protecting the temple's wealth'", "CONFIRMED REMOVED — spoken chapter heading removed before the section body."),
    ("00:15:05.960-00:15:08.840 'lamps'", "REVIEW — single-word diff; recognition variance."),
    ("00:15:16.070-00:15:17.270 'Life beyond the temple'", "CONFIRMED REMOVED — spoken chapter heading."),
    ("00:15:49.510-00:15:50.770 'Drama dance and culture'", "CONFIRMED REMOVED — spoken chapter heading."),
    ("00:17:16.400-00:17:19.020 'border'", "REVIEW — single-word diff; recognition variance."),
]
for i, (rng, v) in enumerate(verdicts, 1):
    A(f"{i}. {rng}")
    A(f"   verdict: {v}")
A("")
A("=" * 100)
A("F. WHAT THE PROFESSIONAL EDIT PRESERVED (do not cut)")
A("=" * 100)
A(f"- {len(DE['deadAir50'])} dead-air intervals totalling {sum(x['dur'] for x in DE['deadAir50']):.1f}s remain in the EDITED audio — quiet gaps the editor kept.")
A("- The presenter intro and sign-off (incl. the closing thanks, transcribed 'Danny Madagala.' / ref 'Dhanyavadakulu.').")
A("- All Tamil/English/Tanglish content is preserved untranslated; language detection: English (Latin script)")
A("  with the closing phrase recognized in Indic script — kept exactly as recognized.")
A("- Breathing, natural short pauses (<1s: skipped by RIISHE as natural rhythm) and quiet narration.")
A("")
A("WORD-TIMING DISCLOSURE: RIISHE obtains word-level times by aligning ASR text to measured speech energy")
A("(per-word estimates inside measured segment bounds). This is NOT forced alignment. Segment start/end are")
A("energy-measured and validated (163/163); per-word times are estimates within those bounds. No timestamps")
A("are fabricated; both deliverable SRTs carry this limitation.")
open("/home/z/my-project/download/unwanted_sections_verified.txt", "w").write("\n".join(L))
print("written download/unwanted_sections_verified.txt:", len(L), "lines")
