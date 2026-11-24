# Social And Short Form Editing (M42-C)

Recipes: see STYLE_CATALOG.md / scripts/ai-editing/style-recipes.json (instagram-reel, vertical-reframe).

The hook IS the format: strongest frame first, fastest cuts in the first 5 seconds, payoff by the 50% mark. Vertical safety: subject in the upper 2/3 of frame, captions inside the safe area (90% width, above the bottom UI line).

Zoom punches (EASE_OUT, <= 0.5 s) mark payoffs, not every cut. The edit should loop cleanly: the last cut returns to the opening frame. Duration target <= 60 s for reels.

Reframing 16:9 -> 9:16: animated x keyframes when the subject moves (analysis-assisted), center-crop with disclosure otherwise. The original 16:9 sequence is never modified.

**Execution contract:** everything described maps to real editor capabilities or is disclosed via the capability matrix (STYLE_CAPABILITY_MATRIX.md). Nothing in this file instructs RIISHE to fake an unsupported effect.
