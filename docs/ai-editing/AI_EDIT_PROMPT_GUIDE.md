# AI Edit Prompt Guide (M42-C)

How RIISHE maps ordinary language to editing intents. The chat resolves, in order: (1) active project + authorized media, (2) conversation state (previous approved operations, pending plans), (3) current sequence revision.

## Intent patterns

| User language | Intent | Default style routing |
| --- | --- | --- |
| "trailer", "teaser", "cinematic promo" | build-promo | cinematic-trailer |
| "reel", "short", "TikTok", "vertical" | build-social | instagram-reel / vertical-reframe |
| "documentary", "story", "interview" | build-story | documentary-interview / cinematic-storytelling |
| "wedding", "emotional highlight" | build-event | wedding-highlight |
| "gaming", "fast cuts, zooms" | build-energetic | gaming-highlight |
| "product", "ad", "advertisement" | build-commercial | product-ad |
| "captions", "subtitles" | caption-pass | (current style) + caption layer |
| "synchronize with music", "beat" | beat-sync | music-video-montage layer |
| "remove silences", "tighten" | cleanup | current style + pacing tighten |
| "vertical 9:16", "reframe" | reframe | vertical-reframe |
| "show me three styles" | style-compare | plan 3 alternative recipes (no apply until one is chosen) |
| "undo the last change" | history-op | inverse of last approved operation |
| "make the intro shorter" / "use the second scene instead" / "warmer colors" | scoped-revision | targeted commands on the current edit |

## Rules

1. Vague prompts ("make it better") → RIISHE proposes a style + asks to confirm before long analysis.
2. Follow-ups bind to the conversation: "the second scene" = scene #2 of the LAST analysis, not a re-scan.
3. Destructive asks ("delete the originals") require explicit approval.
4. Requests needing unavailable capabilities get a disclosure + nearest alternative.
5. Every apply happens only after the plan preview is approved; "render another version" renders the CURRENT approved timeline without re-editing.
