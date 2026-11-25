# Third-Party Licenses Register (M43)

**Policy (binding):** every third-party component — source code, model weights, datasets, shaders, fonts, bundled assets — is checked individually and recorded here with its exact source and revision. Incompatible licenses (e.g. CC-BY-NC for commercial distribution) are **rejected and recorded as rejections**, never silently included.

## Register

| Component | Source + revision | License | Commercial use | Verified | Decision |
| --- | --- | --- | --- | --- | --- |
| FilmCraft (storytold/filmcraft) | https://github.com/storytold/filmcraft — inspected 2026-11-25 (repo page + license statement; latest `main`) | MIT **or** Apache-2.0 (dual, at recipient's option); `NOTICE` required; ArtCraft name/logos excluded | Allowed (with notices) | Yes | **Architecture pattern adopted** (single authoritative command registry, uniform UI/AI/MCP dispatch, enabled gating, engine-level undo, integer-frame determinism). **No code copied** — Rust codebase; BEAN FX registry is an original TypeScript implementation. Re-inspect `NOTICE`/`ATTRIBUTION.md` before any file-level reuse. |
| gl-transitions | https://github.com/gl-transitions/gl-transitions — inspected 2026-11-25 | Repo MIT; **per-file `License:` headers authoritative** — exactly two transitions BSD, rest MIT | Allowed per-transition (manifest required) | Yes | Planned (M43-D): each imported shader enters a catalog manifest with its original author/license header; the two BSD-licensed transitions are flagged/excluded from commercial builds. Nothing imported yet. |
| ACE-Step (code) | https://github.com/ace-step/ACE-Step — inspected 2026-11-25 | Apache-2.0 | Allowed (with notices) | Yes | Planned (M43-D/E): optional local music-generation integration. Integration not started. |
| ACE-Step checkpoints | https://huggingface.co/ACE-Step/ACE-Step-v1-3.5B | **NOT VERIFIED** — the repo page states no checkpoint license | **Unknown** | **No — TO VERIFY on the exact HF model-card revision before any use** | **Gate:** generation stays disabled and the Music Supervisor reports "checkpoint license unverified" until this row records the exact revision + license + commercial verdict. |
| Woosh (SonyResearch) code | https://github.com/SonyResearch/Woosh — inspected 2026-11-25 | MIT (most code) + Apache-2.0 (V2A parts) | Allowed (with notices) | Yes | Code patterns noted; no integration. |
| Woosh pretrained weights | https://github.com/SonyResearch/Woosh (releases) | **CC-BY-NC 4.0** | **REJECTED for commercial BEAN FX** | Yes | **Recorded rejection** — never bundled, redistributed or enabled. SFX subsystem is built model-agnostic so a cleared generator can slot in later. |
| Colourway (Gadfly-Yang) | https://github.com/Gadfly-Yang/Colourway — inspected 2026-11-25 | MIT | Allowed (with notices) | Yes | **Philosophy adopted** (parametric editable grading, no baked LUTs, direction-matching for reference grade) into an original BEAN FX Auto Color tool. No code copied. |
| claude-remotion-skill | https://github.com/haidrrrry/claude-remotion-skill — inspected 2026-11-25 | MIT (skill) | Allowed | Yes | **Motion-design craft rules adopted** (frame-derived timing, centralized theme, staggered choreography, inspect-before-deliver). The Remotion render engine itself has separate company-license terms — **NOT adopted/bundled**. |
| Remotion (engine) | https://remotion.dev | Company license (separate terms for larger orgs) | Requires individual evaluation | Partial (license nature confirmed) | **Not bundled** — only the MIT skill's patterns are referenced. |
| givemotion | https://github.com/givemotion/givemotion — inspected 2026-11-25 | MIT (`THIRD_PARTY_NOTICES.md` for bundled OFL fonts; Chrome/ffmpeg under their own licenses) | Allowed | Yes | Patterns adopted (frame-exact virtual-clock timing, editable parameterized presets, agent self-check QC, alpha overlays via ffmpeg reuse). Not bundled as a dependency in M43-B. |
| gh CLI v2.105.0 (workspace tooling only) | https://github.com/cli/cli/releases/tag/v2.105.0 — sha256 `79e7ab5d…` verified against release checksums | MIT | Allowed | Yes | Development/publication tooling in this workspace only; **not a BEAN FX dependency** — nothing shipped in the app. |

## Bundled dependencies

No new third-party runtime dependency was added to the application in M43-B (the registry and service use the existing zod/prisma stack only).

## Verification log

- 2026-11-25 — All seven upstream repositories re-inspected from source (license statements fetched directly from the repo pages) by the M43 workspace agent. ACE-Step checkpoint license deliberately left UNVERIFIED with the generation feature gated off.
