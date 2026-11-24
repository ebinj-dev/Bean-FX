# Style Recipe Schema — BEAN FX (M42-C/G)

The machine-readable registry is `scripts/ai-editing/style-recipes.json`. It is the single source of truth the style engine (M42-G) loads; the Markdown cards in `STYLE_CATALOG.md` document the same recipes for humans. Tests (`scripts/test-m42-style-engine.test.ts`) validate schema conformance and **that every referenced capability exists** in the editor model — a recipe referencing a non-existent effect/transition/keyframe param fails CI.

## Field contract

| Field | Type | Meaning | Maps to |
| --- | --- | --- | --- |
| `id` | string (unique) | Stable style id | plan `styleId` |
| `name`, `family`, `purpose`, `suitableFor`, `emotion` | strings/arrays | Creative identity + routing | style selection |
| `aspect` | array of `"16:9"\|"9:16"\|"1:1"` | Delivery targets | sequence width/height |
| `structure` | array of strings | Beat order (documented only — RIISHE narrates, never auto-generates content) | plan concept |
| `shotSelection` | string | Selection guidance | plan shot ordering |
| `pacing` | `{avgShotSec:[lo,hi], shotsPerMin:[lo,hi], acceleration}` | Timing targets | clip durations |
| `cutting` | array of technique names from `EDITING_GRAMMAR_AND_TECHNIQUES.md` | Cutting style | command sequence |
| `transitions` | `[{kind: TransitionKind, durationFrames?:[lo,hi], use?}]` | Transition plan | AddTransition args — `kind` MUST be a member of TransitionKind |
| `motion` | `{param: KeyframeProperty, from,to,interpolation, use?}` blocks | Motion defaults | SetKeyframe args — `param` MUST be a member of KeyframeProperty |
| `color` | `[{type: EffectType, amount:[lo,hi]}]` + note | Grading defaults | AddEffect args — `type` MUST be a member of EffectType |
| `audio` | fadeIn/outFrames, ducking strategy, bed | Audio defaults | ChangeVolume/fades |
| `captions` | style, fontSize range | Caption defaults | caption clips |
| `needs` | array of capability ids | NOT-guaranteed requirements | capability registry lookup → disclosed gaps |
| `qualityChecks` | array of strings | Plan + render QA gate | checklist generation |
| `notFor` | array | Anti-patterns | routing rejection |
| `promptExample` | string | Canonical example prompt | prompt guide |

## Validation rules (enforced by tests)

1. JSON parses; `version` present; `id` unique.
2. Every `transitions[].kind` ∈ TransitionKind; every `motion` block's `param` ∈ KeyframeProperty; every `color.effects[].type` ∈ EffectType.
3. `pacing`/`color` ranges are `[lo, hi]` with lo ≤ hi.
4. Every recipe has ≥ 3 `qualityChecks` and ≥ 1 `promptExample`.
5. `needs` entries must be known capability ids in the M42-D registry vocabulary (unknown id → test failure).
6. The human docs reference the same recipe ids (drift check).
