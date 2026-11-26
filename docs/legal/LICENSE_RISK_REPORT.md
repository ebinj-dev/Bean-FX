# LICENSE RISK REPORT — BEAN FX

Generated 2026-11-26T16:52:56.927Z. Automated classification of the npm dependency tree plus system components. This is an engineering assessment, not legal advice; items marked RESOLVE require owner/legal review before commercial distribution.

## Summary

- npm packages audited: **537** (70 direct / 467 transitive)
- Classification: PERMISSIVE=521, NON-STANDARD=2, COPYLEFT-WEAK=14
- System/fonts: FFmpeg (GPL-enabled build — see below), Noto + Geist fonts (OFL-1.1), system Python (PSF-2.0).

## Items requiring attention

### 1. FFmpeg system build — GPL components (COPYLEFT-STRONG)

The installed FFmpeg 7.1.5 Debian build reports `--enable-gpl` + `--enable-libx264`. Running FFmpeg server-side on users' own media is generally not "distribution" of the program; however, shipping this build inside a distributed BEAN FX product would trigger GPL-2.0 obligations (and x264's GPL terms). **Status: RESOLVE before any product distribution — server-side SaaS use is the assumed mode.**

### 2. z-ai-web-dev-sdk gateway (environment-provided)

Not in the lockfile; loaded at runtime when the deployment provides it. Its distribution terms are the provider's and are NOT assessed here. **Status: EXCLUDED from redistribution claims — treat as a deployment dependency.**

### 3. @codesandbox/nodebox — Sustainable Use License (transitive)

Dependency chain: `@mdxeditor/editor` → `@codesandbox/sandpack-react` (Apache-2.0) → `@codesandbox/sandpack-client` (Apache-2.0) → `@codesandbox/nodebox` ("Sustainable Use License" — restricts paid/commercial use of the licensed work). BEAN FX does not call nodebox directly; it is a transitive installation. **Status: EXCLUDED from commercial distribution until resolved — if the editor surface that pulls sandpack is ever distributed commercially, this chain must be removed, replaced, or cleared with the licensor.**

### 4. npm packages not classified PERMISSIVE

| Package | Version | License (declared) | Classification | Action |
|---|---|---|---|---|
| @codesandbox/nodebox | 0.1.8 | SEE LICENSE IN ./LICENSE | NON-STANDARD | RESOLVE — non-standard license field |
| @img/sharp-libvips-darwin-arm64 | 1.2.4 | LGPL-3.0-or-later | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-libvips-darwin-x64 | 1.2.4 | LGPL-3.0-or-later | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-libvips-linux-arm | 1.2.4 | LGPL-3.0-or-later | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-libvips-linux-arm64 | 1.2.4 | LGPL-3.0-or-later | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-libvips-linux-ppc64 | 1.2.4 | LGPL-3.0-or-later | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-libvips-linux-riscv64 | 1.2.4 | LGPL-3.0-or-later | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-libvips-linux-s390x | 1.2.4 | LGPL-3.0-or-later | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-libvips-linux-x64 | 1.2.4 | LGPL-3.0-or-later | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-libvips-linuxmusl-arm64 | 1.2.4 | LGPL-3.0-or-later | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-libvips-linuxmusl-x64 | 1.2.4 | LGPL-3.0-or-later | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-wasm32 | 0.34.5 | Apache-2.0 AND LGPL-3.0-or-later AND MIT | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-win32-arm64 | 0.34.5 | Apache-2.0 AND LGPL-3.0-or-later | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-win32-ia32 | 0.34.5 | Apache-2.0 AND LGPL-3.0-or-later | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-win32-x64 | 0.34.5 | Apache-2.0 AND LGPL-3.0-or-later | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| intersection-observer | 0.10.0 | W3C-20150513 | NON-STANDARD | RESOLVE — non-standard license field |

### 5. Fonts (OFL-1.1)

Noto Sans, Noto Sans Tamil (bundled files) and Geist/Geist Mono (build-time via next/font) are SIL OFL-1.1. OFL permits commercial use and redistribution when the license accompanies the fonts and reserved font names are respected. **Status: OK — keep the OFL text with any font redistribution.**

## Explicitly excluded from commercial distribution until resolved

- Any package classified UNKNOWN or NON-STANDARD above.
- The GPL-enabled FFmpeg build if BEAN FX is ever distributed as a bundled product (SaaS operation over user media is the current distribution mode).
- The gateway SDK (provider terms apply; not redistributed by this repository).
