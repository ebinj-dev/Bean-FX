# Color And Image Finishing (M42-C)

Recipes: see STYLE_CATALOG.md / scripts/ai-editing/style-recipes.json (cross-cutting layer).

Order of operations: exposure -> white balance (temperature/tint) -> contrast -> saturation -> targeted highlights/shadows/whites/blacks -> vignette/sharpen.

Sample per-shot statistics before grading; apply per-clip amounts so a scene reads consistently. Skin-tone hue drift stays < 0.03 after any grade. Black & white = grayscale 1.0 + contrast 0.05-0.15. Stylized looks (vintage/pastel) are disclosed as stylized, never presented as correction.

No third-party LUTs or presets without rights; amounts are sampled, not magic.

**Execution contract:** everything described maps to real editor capabilities or is disclosed via the capability matrix (STYLE_CAPABILITY_MATRIX.md). Nothing in this file instructs RIISHE to fake an unsupported effect.
