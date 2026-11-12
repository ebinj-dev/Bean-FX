#!/usr/bin/env python3
"""Generate the Phase 4 diagnosis report skeleton with the full 123-candidate
table (deterministic-before vs semantic-after for the DIAGNOSED run)."""
import json, collections

rows = []
with open("/home/z/my-project/scripts/audit-candidates-20m19-full.tsv") as f:
    hdr = f.readline().rstrip("\n").split("\t")
    for line in f:
        p = line.rstrip("\n").split("\t")
        rows.append(dict(zip(hdr, p)))

d = json.load(open("/home/z/my-project/media-store/analysis-results/cmw5tdcjm0001slfxsmu5v5ny.json"))
orig = collections.Counter(r["orig"] for r in rows)
fin = collections.Counter(r["final"] for r in rows)

def fmt(v):
    f = float(v)
    return f"{f:.2f}"

lines = []
lines.append("| # | ID | Range (s) | Pause (s) | Original (deterministic) | Rule that fired | Final (zai-chat) | Conf. | In canonical plan | Reason (final, truncated) |")
lines.append("|---|---|---|---|---|---|---|---|---|---|")
for i, r in enumerate(rows, 1):
    why = {"intra-sentence<=3s": "intra-sentence ≤3s", "intra-sentence>3s": "intra-sentence >3s", "builtin-lexicon": "builtin lexicon", "words-in-range": "words in range", "repeated-take": "repeated take", "floor-unreliable": "floor unreliable", "punctuation-unknown": "punctuation unknown", "inter-sentence-silence": "inter-sentence silence"}.get(r["origWhy"], r["origWhy"])
    reason = r["reason"][:100].replace("|", "/").replace("\n", " ")
    lines.append(f"| {i} | {r['id']} | {fmt(r['start'])}–{fmt(r['end'])} | {r['pause']} | {r['orig']} | {why} | {r['final']} | {r['finalConf']} | {'YES' if r['inPlan'] == 'True' else 'no'} | {reason} |")
table = "\n".join(lines)

header = f"""# BEAN FX — RIISHE Zero-Cut Diagnosis & Timeline Marking Fix (Phase 4)

**Date:** 2026-11-07 · Media: `not edited(2).mp3` (1219.728 s ≈ 20:19, job `cmw5tdcjm0001slfxsmu5v5ny`) · No commits, no pushes.

## 1. Executive summary

The zero-cut result was **not** the semantic model being wrong — it never had anything to overturn. The deterministic
evidence layer already produced **0 REMOVE** (114 KEEP / 9 REVIEW), and the zai-chat semantic stage flipped **zero**
classifications (transition matrix: KEEP→KEEP 114, REVIEW→REVIEW 9; it only rewrote reasons/confidences). The root cause
sits in detection + deterministic classification, and the semantic stage then rubber-stamped it with `confidence: 1.0`.

Meanwhile the recording contains real removable material: {sum(1 for r in rows if float(r['pause']) >= 2)} pauses ≥ 2 s
(largest {max(float(r['pause']) for r in rows):.2f} s) at RMS 0.001–0.003 — essentially the noise floor (0.0017) — with
**zero transcript words in range**. Those are dead air by measurement, not meaningful pauses.

## 2. Root cause (with file:line evidence)

**RC1 — the same-segment continuity heuristic is unreliable under estimated word timings** (`src/lib/autocut-analysis.ts:866-874`).
`intraSentence` becomes true when one transcript segment spans the whole gap (`prevSeg === nextSeg`). With anchored ASR
word timings that is a strong signal; here timings are energy-estimated (`alignmentStats.anchored = 0`), so a single
segment routinely stretches across a genuine silence between two spoken thoughts. Anatomy of the 119 silence gaps:
**101 flagged intra-sentence via same-segment (65 identical short segments + 36 long segments whose two 120-char slices
differ), 13 via lowercase/connective continuation, 5 via non-terminal previous sentence — 0 detected as true
inter-sentence silence.** The `±1.5 s` neighbour tolerance (`:860-865`) widens this further.

**RC2 — the deterministic KEEP rule swallowed every intra-sentence pause up to 3 s** (`src/lib/autocut-analysis.ts:915-920`,
pre-fix). `intraSentence && pauseSec <= 3 → KEEP (0.75)` applied regardless of pause depth or word evidence: 105 of the
119 gaps (0.25–2.68 s) became KEEP even at 2.68 s of near-digital silence. The >3 s branch sent the remaining 5 gaps
(3.14–6.76 s — true dead air) to REVIEW, never REMOVE. Result: the deterministic canonical plan was already empty.

**RC3 — the semantic prompt reinforced the same error** (`src/lib/riishe-inference.ts:185`, pre-fix): *"A pause inside an
ongoing sentence must be KEEP"* is an absolute rule, plus *"If the transcript has no sentence punctuation … never REMOVE
on your own guess"* (`:189`). The model had no path to REMOVE for intra-sentence dead air, so it confirmed all 114 KEEPs
and 9 REVIEWs — asserting **confidence exactly 1.0 on 114 of them** (no pipeline cap; `riishe-safety.ts:37` copies the
model's confidence verbatim).

**RC4 (not the culprit, verified) — the safety guard never fired** (`src/lib/riishe-safety.ts:25-34`): it downgrades only
semantic REMOVEs over transcribed speech; with zero REMOVE suggestions it had nothing to downgrade
(`inferenceNote`: "classified 123/123", 0 downgraded). The plan union (`src/app/api/autocut/analyze/route.ts:378`) then
correctly produced 0 intervals. **The timeline honestly showed no red marks because the plan was genuinely empty.**

**RC5 (ASR status)** — `transcription: UNAVAILABLE` is the *honest* label for partial provider loss: the hosted zai ASR
transcribed 45/49 chunks and was rate-limited on the last 4 (≈ the final 100 s), `src/lib/autocut-analysis.ts:1429-1438`
deliberately marks partial loss UNAVAILABLE ("never a DONE with hidden gaps"). Word timings are estimated
(`anchored = 0`) and the UI/notes say so — that part of the reporting was already correct.

## 3. Fixes implemented (audit-driven, no hardcoding)

1. **Deterministic rules** (`src/lib/autocut-analysis.ts:899-970`): intra-sentence ≤1.2 s → KEEP (natural micro-pause);
   1.2–3 s → REVIEW 0.5 (uncertain); >3 s with deep silence (gap RMS ≤ 15 % of median speech RMS — new `speechRatio`
   evidence) → **REMOVE** conf ≤0.7 (evidence-backed dead air, human approves); >3 s without deep silence → REVIEW 0.45.
   Words-in-range → REVIEW and low-energy speech protection unchanged; nothing is removed for being quiet.
2. **Semantic prompt** (`src/lib/riishe-inference.ts`): rewritten taxonomy — dead air, fillers, accidental repeats,
   repeated sentences, false starts, production chatter vs meaningful pauses (breath/emphasis/rhetoric); REMOVE requires
   measured evidence (≥~1.5 s, silenceRatio ≪1, no words in range) *even mid-sentence*; explicit bans: never remove
   speech for low energy, never a KEEP merely for being intra-sentence, language never a removal reason
   (Tamil/English/Tanglish preserved), no invented words/boundaries, uncertain → REVIEW, **confidence ≤0.95, never 1.0**,
   deterministic hint may be confirmed/downgraded with stated reasons.
3. **Override transparency** (`src/lib/riishe-safety.ts`): the note now counts how many evidence-backed deterministic
   REMOVE proposals the semantic stage talked out of the plan — an empty plan can never again be unexplained
   (wired into `inferenceNote`, `src/app/api/autocut/analyze/route.ts:351-354`).
4. **Timeline marker staleness** (`src/components/bean/waveform.tsx:112-117`): the static-layer cache key included only
   cut id+status — editing a candidate's IN/OUT bounds repainted nothing (stale red rectangle). Bounds now key the cache.
   Verified otherwise: REMOVE-only rendering (`:219-232` skips KEEP/REVIEW entirely), view-window alignment on
   zoom/scroll/seek, redraw on classify/delete (id/status set in key), APPROVED_REMOVE darker red, ruler from
   `niceStep(viewDur/8)` (never hardcoded).
5. **Honest summary** (`src/components/bean/tools/auto-cut.tsx:944-985, 1471-1500`, `src/lib/types.ts:266`): the three
   numbers the user must see are now separated — **DETECTED** (all candidates + total duration), **PROPOSED REMOVE**
   (REMOVE-only count + union seconds; REVIEW never counts), **APPROVED (APPLIED)** (what an export actually applied,
   0 until apply succeeds), **FINAL** (estimated from the proposed plan before apply; actual `estimatedFinalSec` after).
   Plus an explicit "why the output has not changed" banner when the plan is empty.

## 4. Classification breakdown — the diagnosed run (before the fix)

- Deterministic (original): **KEEP 114 · REVIEW 9 · REMOVE 0**
- After zai-chat inference (final): **KEEP 114 · REVIEW 9 · REMOVE 0** — 0 flips
- Canonical removal intervals: **0** → final duration 20:19.728 (unchanged)
- Pause evidence ignored by the old rules: 8 pauses 2.0–2.68 s → KEEP; 5 pauses 3.14–6.76 s → REVIEW; total candidate
  pause 142.3 s of 1219.7 s.

## 5. All 123 candidates — original vs final classification (diagnosed run)

`Original` = the deterministic evidence-layer classification reconstructed verbatim from the recorded evidence via the
pre-fix rule chain (`scripts/phase4-reconstruct.py`, exact port of `autocut-analysis.ts:899-938`). `In canonical plan` is
no for every row because no candidate was ever classified REMOVE. Full untruncated reasons: `scripts/audit-candidates-20m19-full.tsv`.

{table}

## 6. After the fix — re-run on the real recordings (live API, audit user, fresh upload, default settings)

**20:19 recording** (job `cmw5uiizw000dslfxlapadz2v`, result `/tmp/p4/result-20m19.json`):

- **109 candidates: KEEP 78 · REVIEW 27 · REMOVE 4** (candidate count changed from 123 because ASR now covers the whole
  recording — the 4 previously rate-limited tail chunks transcribed on retry, `transcription: DONE, failedChunks: []` —
  which also changed tail segmentation).
- Canonical plan: **4 removal intervals, 15.44 s** → final 1204.288 s. All four have **0 transcript words in range**,
  silenceRatio 0.019–0.039 (true dead air at 2–4 % of speech level):

| Candidate | Range (s) | Pause | Removed | silenceRatio | Model confidence | Model reason (excerpt) |
|---|---|---|---|---|---|---|
| sil-17 | 136.08–139.35 | 3.62 s | 3.27 s | 0.039 | 0.8 | "Long pause … low silenceRatio (0.04) and no transcript words" |
| sil-25 | 237.76–244.13 | 6.72 s | 6.37 s | 0.026 | 0.8 | "Long pause (6.37s) … appears to be dead air" |
| sil-30 | 303.42–306.47 | 3.40 s | 3.05 s | 0.019 | 0.8 | "Long pause (3.05s) with low silenceRatio" |
| sil-98 | 1151.98–1154.73 | 3.10 s | 2.75 s | 0.038 | 0.8 | "near-silence … indicating dead air" |

- Semantic override transparency: the note reports 0 overridden evidence-backed proposals — deterministic REMOVEs and
  model REMOVEs agree; all model confidences ≤ 0.95 (was 1.0 on 114 KEEP verdicts before).
- **Per-candidate before → after** (matched by time overlap): KEEP→KEEP 77, KEEP→REVIEW 22 (the 1.2–3 s band is now
  honestly uncertain instead of auto-KEEP), REVIEW→**REMOVE** 4 (the dead air), REVIEW→REVIEW 1, 19 candidates not
  re-detected and 5 new (completed ASR tail + re-detected lexicon matches). No KEEP became REMOVE; nothing with words in
  range is ever proposed.
- **Approval & export (real ffmpeg exports through `/api/process/autocut`):**
  - Approve all 4 → export `cmw5ukk6c000hslfx0uj2p8cf`: ffprobe duration **1204.288000 s = plan.finalDurationSec exactly**.
  - Reject the first interval (simulated human rejection) → export `cmw5ukpki000lslfxfks3k380`: **1207.558000 s = plan + 3.270 s rejected interval exactly**.
  - Original file md5 `72ba633556e2…` **identical before and after** — the recording is never modified.
  - Server `estimatedFinalSec` (1204.292) vs container duration (1204.288): 4 ms ffmpeg frame rounding, disclosed.

**31.66 s reference recording** (job `cmw5uksvc000pslfxq27j03a1`): 11 candidates — **2 REMOVE** (head 0.15–0.61 s and
tail 30.53–31.41 s, RMS = 0, silenceRatio = 0 — lead-in/lead-out dead air), 9 REVIEW (in-sentence micro-pauses stay
REVIEW under estimated timings), plan removes 1.337 s → 30.27 s. Zero cuts *would* have been valid for the mid-recording
pauses; the two removable ranges are the boundary silences, each with measured evidence.

**Timeline verification** (code + data): the red marks render exactly the REMOVE candidates — verified that
`plan.removals == unionIntervals(REMOVE candidates)` on the new result (`True`); the component draws only REMOVE /
APPROVED_REMOVE (`waveform.tsx:219-232`), positions derive from the live view window (zoom/scroll/seek-safe), the cache
key now includes bounds so IN/OUT edits repaint, and classify/delete/reject all change the key (id/status/length).

**Test results:** `tsc --noEmit` clean · bun **54/54** · sidecar service suite **23/23** · end-to-end validation script
`scripts/phase4-validate.sh` (analyze → approve → export → reject → export → md5) all green.

## 7. Remaining limitations

1. Word timings are still energy-estimated for this media (hosted ASR returns no word timestamps; `anchored = 0`).
   Consequence by design: mid-sentence medium pauses (1.2–3 s) stay REVIEW, and the 31 s head/tail REMOVEs are the only
   sub-1.5 s ranges proposed (RMS = 0 boundary silence). Real word-level ASR (the local faster-whisper sidecar from
   Phase 3, pending model-download confirmation) will sharpen these.
2. Semantic classification runs on the configured hosted `zai-chat` provider; the local-http sidecar is not configured in
   this environment yet (`BEANFX_SEMANTIC_PROVIDER` unset → default). Selection is logged either way.
3. `estimatedFinalSec` can differ from the exported container by a few ms of ffmpeg frame rounding.
4. The semantic stage can still override deterministic REMOVE proposals (by design, always disclosed in the note) —
   the human approver is the final authority either way.
"""

with open("/home/z/my-project/download/RIISHE-ZEROCUT-DIAGNOSIS.md", "w") as f:
    f.write(header)
print("report skeleton written, table rows:", len(lines) - 2)
