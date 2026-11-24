# Editing Quality Checklist (M42 §17) — machine-checkable gate

RIISHE runs this after applying a plan and again after render. A failed check is reported with actionable feedback; the creative result is never silently altered to hide a failure.

## Story (plan-time, from plan + analysis)
- [ ] Clear opening: first shot registers the subject ≤ 3 s
- [ ] Logical structure: declared beats present in order
- [ ] Consistent subject: no unrelated shots unless declared b-roll
- [ ] No accidental repetition: no identical shot twice in a row (scene-id + range check)
- [ ] Strong ending: final shot declared and held ≥ declared minimum

## Visuals (plan-time + post-render probe)
- [ ] Shot order respects continuity (motion-direction continuity where analysis exists)
- [ ] Crops/aspect correct: all clips inside sequence dims; no transform discontinuity (keyframe boundary check)
- [ ] Stable framing: no unintentional < 1-frame jumps
- [ ] No unintended black frames: first/last frame luma check post-render
- [ ] Transitions valid: kinds ∈ TransitionKind, durations within recipe range

## Audio (post-render ffprobe + analysis)
- [ ] Dialogue intelligibility: speech segments not ducked below threshold (when transcript exists)
- [ ] Fades correct: fadeIn/outFrames within range; no click at boundaries
- [ ] No unintended clipping: peak sample check post-render
- [ ] No unwanted silent gaps > style threshold (silencedetect)

## Captions (when present)
- [ ] Words match transcript verbatim; timing within ±100 ms of word timestamps
- [ ] Speaker attribution only when diarization provenance exists
- [ ] Placement within safe areas; fontSize within recipe range

## Export (post-render, ffprobe — hard gate)
- [ ] Container/codec/frame rate/dimensions match the plan
- [ ] Duration within max(0.5 s, 2%) of planned
- [ ] Audio stream present with expected channels
- [ ] Output file exists and is readable
