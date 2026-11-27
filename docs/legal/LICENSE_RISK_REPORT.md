# LICENSE RISK REPORT — BEAN FX

Generated 2026-11-27T12:33:27.847Z. Engineering assessment of the complete instance inventory — technical detection is NOT legal clearance. Not legal advice. Items marked RESOLVE require owner/legal review before commercial distribution.

## Summary

- 1007 lockfile entries → 584 production / 423 development instances (548 unique names, 570 unique versions).
- Production classification: PERMISSIVE=568, NON-STANDARD=2, COPYLEFT-WEAK=14
- Nested production instances: 37 (37 at versions differing from the top-level copy — evaluated as their OWN instances).
- Unresolved license evidence: 0 instance(s) — EXCLUDED from commercial distribution until evaluated.
- System/fonts: FFmpeg GPL-enabled build (below), Noto + Geist fonts (OFL-1.1), system Python (PSF-2.0), gateway SDK (provider terms).

## Items requiring attention

### 1. FFmpeg system build — GPL components (COPYLEFT-STRONG)

FFmpeg 7.1.5 Debian build reports `--enable-gpl` + `--enable-libx264`. Server-side operation over users' own media is generally not "distribution" of the program; shipping this build inside a distributed BEAN FX product would trigger GPL-2.0 obligations (and x264's GPL terms). Open questions for legal review: the exact build configuration in production, the distribution model (SaaS vs bundled), and any bundled-encoder policy. **Status: RESOLVE before product distribution.**

### 2. @codesandbox/nodebox — Sustainable Use License (transitive chain)

Chain: `@mdxeditor/editor` → `@codesandbox/sandpack-react` (Apache-2.0) → `@codesandbox/sandpack-client` (Apache-2.0) → `@codesandbox/nodebox` ("Sustainable Use License" — restricts paid/commercial use of the licensed work). BEAN FX does not call nodebox directly; it is an installed transitive instance. Open questions: whether the MDX editor surface that pulls sandpack ships in the commercial product, and whether a paid-use arrangement or removal is required. **Status: EXCLUDED from commercial distribution until resolved.**

### 3. Declared dependencies missing from the lockfile (install-state integrity)

None — every `package.json` dependency has lockfile entries. `npm ci` reproducibility is intact.

### 4. z-ai gateway SDK (environment-provided)

Not in the lockfile; loaded at runtime when the deployment provides it. Provider terms NOT assessed here. **Status: EXCLUDED from redistribution claims — deployment dependency.**

### 5. npm instances not classified PERMISSIVE (production)

| Instance | Install path | License (evidence) | Classification | Action |
|---|---|---|---|---|
| @codesandbox/nodebox@0.1.8 | node_modules/@codesandbox/nodebox | SEE LICENSE IN ./LICENSE (installed-package) | NON-STANDARD | RESOLVE — non-standard or restricted license |
| @img/sharp-libvips-darwin-arm64@1.3.4 | node_modules/@img/sharp-libvips-darwin-arm64 | LGPL-3.0-or-later (npm-registry) | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-libvips-darwin-x64@1.3.4 | node_modules/@img/sharp-libvips-darwin-x64 | LGPL-3.0-or-later (npm-registry) | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-libvips-linux-arm@1.3.4 | node_modules/@img/sharp-libvips-linux-arm | LGPL-3.0-or-later (npm-registry) | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-libvips-linux-arm64@1.3.4 | node_modules/@img/sharp-libvips-linux-arm64 | LGPL-3.0-or-later (npm-registry) | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-libvips-linux-ppc64@1.3.4 | node_modules/@img/sharp-libvips-linux-ppc64 | LGPL-3.0-or-later (npm-registry) | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-libvips-linux-riscv64@1.3.4 | node_modules/@img/sharp-libvips-linux-riscv64 | LGPL-3.0-or-later (npm-registry) | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-libvips-linux-s390x@1.3.4 | node_modules/@img/sharp-libvips-linux-s390x | LGPL-3.0-or-later (npm-registry) | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-libvips-linux-x64@1.3.4 | node_modules/@img/sharp-libvips-linux-x64 | LGPL-3.0-or-later (installed-package) | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-libvips-linuxmusl-arm64@1.3.4 | node_modules/@img/sharp-libvips-linuxmusl-arm64 | LGPL-3.0-or-later (npm-registry) | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-libvips-linuxmusl-x64@1.3.4 | node_modules/@img/sharp-libvips-linuxmusl-x64 | LGPL-3.0-or-later (installed-package) | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-wasm32@0.35.5 | node_modules/@img/sharp-wasm32 | Apache-2.0 AND LGPL-3.0-or-later AND MIT (npm-registry) | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-win32-arm64@0.35.5 | node_modules/@img/sharp-win32-arm64 | Apache-2.0 AND LGPL-3.0-or-later (npm-registry) | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-win32-ia32@0.35.5 | node_modules/@img/sharp-win32-ia32 | Apache-2.0 AND LGPL-3.0-or-later (npm-registry) | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| @img/sharp-win32-x64@0.35.5 | node_modules/@img/sharp-win32-x64 | Apache-2.0 AND LGPL-3.0-or-later (npm-registry) | COPYLEFT-WEAK | NOTICE — include license text if redistributed |
| intersection-observer@0.10.0 | node_modules/intersection-observer | W3C-20150513 (installed-package) | NON-STANDARD | RESOLVE — non-standard or restricted license |

### 6. Fonts (OFL-1.1)

Noto Sans, Noto Sans Tamil (bundled) and Geist/Geist Mono (build-time) are SIL OFL-1.1. OFL permits commercial use and redistribution when the license accompanies the fonts and reserved font names are respected. **Status: OK — keep the OFL text with any font redistribution.**

## Explicitly excluded from commercial distribution until resolved

- Every instance classified UNKNOWN / NON-STANDARD above (including the nodebox chain).
- The GPL-enabled FFmpeg build if BEAN FX is distributed as a bundled product.
- The gateway SDK (provider terms apply; not redistributed by this repository).
