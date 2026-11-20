# M31 FEATURE MATRIX — BEAN AI Production Studio

| Capability | Implemented | Automated | Real media | Config needed | Notes |
|---|---|---|---|---|---|
| Pipeline engine + state machine | VERIFIED | VERIFIED (core 14/14) | n/a | none | 11 states, invalid transitions rejected |
| NL intake → structured brief | VERIFIED | VERIFIED (core + live) | n/a | LLM enhance optional | deterministic extraction; honest provider note |
| Concept options + decision record | VERIFIED | VERIFIED (core + live) | n/a | LLM enhance optional | 3 distinct directions; append-only decisions |
| Script + duration validation + revisions | VERIFIED | VERIFIED (core + live) | n/a | LLM enhance optional | ±5% duration gate; revision 1→2 verified |
| Storyboard + scene approvals | VERIFIED | VERIFIED (live) | placeholders marked pending | LLM enhance optional | no fabricated thumbnails |
| Asset planning + rights provenance | VERIFIED | VERIFIED (live) | user media attached | generation = CONFIG REQUIRED | RESTRICTED unapprovable; unknown cost = unknown |
| Production Board UI | VERIFIED | VERIFIED (live via API; UI additive) | yes | none | real state only; no fake progress |
| Template C — Social Video Factory | VERIFIED | **E2E 15/15 with real media** | yes | none | intake→…→delivery |
| Template E — Podcast Repurposing | VERIFIED (analysis + chain) | VERIFIED (analysis deterministic) | yes | ASR = CONFIG REQUIRED | transcript honestly NOT RUN |
| Template D — Brand Commercial | VERIFIED | **E2E via M30 review bridge** | yes | none | review→approve→render→QA→delivery |
| Templates A/B/F | PARTIAL (stages defined) | blocked-start VERIFIED (409 + reason) | — | CONFIGURATION REQUIRED | exact blockers shown |
| Native timeline assembly | VERIFIED | VERIFIED (canonical commands; rough cut on editor timeline) | yes | none | undo/redo/manual edit preserved |
| Render on durable jobs | VERIFIED | VERIFIED (job submitted + COMPLETED) | yes | none | no second queue |
| QA layer | VERIFIED | VERIFIED (real renders checked) | yes | none | PASSED/FAILED/NEEDS_HUMAN_REVIEW |
| Cost gates | VERIFIED | VERIFIED (core + live) | n/a | — | no paid call without approval+config |
| Restart/resume | VERIFIED | VERIFIED (recovery test) | yes | none | no duplicated assets/clips |

Simulated: NONE. Every VERIFIED claim cites `download/m31-evidence/` logs. Provider-dependent capabilities are CONFIGURATION REQUIRED, never faked.
