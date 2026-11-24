# Captions and Subtitle Styles (M42-C)

Executable today: caption clips carrying `CaptionStyle` (fontSize 8–400, color, background hex/nullable, position TOP/CENTER/BOTTOM). Word-level timing only when provenance (ASR with timestamps / aligned user script) exists — provenance is recorded in the plan.

| Style | Recipe mapping | Position | Notes |
| --- | --- | --- | --- |
| Documentary subtitles | dialogue verbatim, 28–40 px, subtle background | BOTTOM | no paraphrase; speaker labels only with diarization provenance |
| Social word captions | near-word chunks, 42–72 px, bold color + background | CENTER or BOTTOM | chunk at phrase level when word timing absent (disclosed) |
| Karaoke / word-by-word | word timestamps required | BOTTOM | timing ±100 ms gate |
| Highlighted keywords | keyword list → emphasis via color | BOTTOM | keyword source disclosed (user prompt) |
| Speaker labels | diarization provenance required | BOTTOM | otherwise disclosed gap |
| Lower thirds / animated titles / kinetic typography | D — beyond caption clips (NIIKI motion lane) | — | disclosed, never faked |

Rules: safe areas (keep captions inside 90% width, above the bottom UI line at 9:16), contrast (light text needs dark background or vice versa), language direction respected, accessibility (min 28 px for 1080p), export format SRT/VTT sidecar available from transcript data.
