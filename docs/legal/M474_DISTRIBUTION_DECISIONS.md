# M47.4 — THIRD-PARTY DISTRIBUTION DECISION PACKET

`docs/legal/M474_DISTRIBUTION_DECISIONS.md`

**This packet is technical evidence, not legal advice or legal clearance.** Every item ends in a
decision required from the repository owner (ideally with qualified counsel). No license status in
BEAN FX was changed to make this report look cleaner; the SBOM and notices from M47.3 are preserved
untouched (they still match the current lockfile — regenerated only if dependency data changes).

Distribution modes used in this document:

- **HOSTED** — BEAN FX runs as a server the operator hosts; users interact via browser/API only.
- **SELF-HOST DISTRIBUTION** — the operator distributes a deployable artifact (docker image, VM,
  on-prem bundle) that CONTAINS the dependency binaries.
- **CLIENT DISTRIBUTION** — shipping application code/binaries to end-user machines (not a current
  BEAN FX mode; included for completeness).

---

## D1. FFmpeg (GPL-enabled system build)

| Field | Evidence |
| --- | --- |
| Component | `ffmpeg` / `ffprobe`, **system binaries resolved from PATH** (Debian 13 package `7.1.5-0+deb13u1` in the current environment). |
| Build flags | `--enable-gpl --enable-libx264` (verified via `ffmpeg -buildconf`) → the invoked build is **GPL-enabled**; libx264 itself is GPL-licensed. |
| How BEAN FX uses it | The canonical renderer (M46.1, `src/lib/publish/timeline-render.ts`) composes filter chains; processes execute it externally: `execFile("ffprobe", …)` (`src/lib/publish/variants.ts:40`), `execFile` for temporal/graphic work (`src/lib/creative/visual/temporal/mograph.ts:20`), narration/media-analysis/laxii/jazmii processing. It is **separate-process invocation (exec/spawn)** — no in-process linking of FFmpeg libraries. |
| Bundled? | **No.** No ffmpeg binary, static build, or shared object exists in the repository (searched; only node_modules/platform artifacts). The binary is installed by the OPERATOR on the host. |
| Redistributed? | **Not in the HOSTED mode.** The web app ships no FFmpeg bits. In SELF-HOST DISTRIBUTION (e.g. a docker image with `apt-get install ffmpeg`), the FFmpeg/libx264 binaries WOULD be distributed inside the artifact. |
| Existing disclosure | The public Legal Center already states the product relies on "the GPL-enabled FFmpeg system build" (`src/app/(public)/legal/copyright/page.tsx:69`) and the Open Source Center lists it — consistent with reality. |
| Unresolved legal questions | 1) Does process-level invocation of a GPL build create derivative-work obligations for BEAN FX code (the "mere aggregation"/separate-process analysis)? 2) In SELF-HOST DISTRIBUTION, what GPL obligations attach to the artifact that CONTAINS the GPL binaries (source offers, notices)? 3) Alternative builds: an LGPL `--disable-gpl` build (no libx264 — H.264 encoding via an alternative codec or a licensed encoder) changes the obligations but also changes render capability/compatibility. |
| Possible technical alternatives | (a) Stay HOSTED-only: never distribute the binary — operator installs it; document the requirement. (b) Self-host images: include FFmpeg via apt in the image + GPL notices/source offers, reviewed by counsel. (c) LGPL build + different encoder — materially changes output codec behavior; would require re-running the full render matrix. |
| **State: OWNER REVIEW REQUIRED** | Decision needed: permitted distribution modes + whether counsel reviews the GPL analysis before any SELF-HOST DISTRIBUTION of the product. **No clearance is claimed.** |

## D2. `@codesandbox/nodebox` (Sustainable Use License)

| Field | Evidence |
| --- | --- |
| Package | `@codesandbox/nodebox@0.1.8` (audit: scope `transitive`, classification NON-STANDARD, lockfile `bun.lock`/`package-lock.json` both present). |
| Dependency path | **DIRECT** dependency `@mdxeditor/editor@3.52.3` (`package.json` `"@mdxeditor/editor": "^3.39.1"`) → `@codesandbox/sandpack-client@2.19.8` → `@codesandbox/nodebox@0.1.8`. |
| License | "Sustainable Use License" Version 1.0 (read from `node_modules/@codesandbox/nodebox/LICENSE`): *"You may use or modify the software only for your own internal business purposes or for non-commercial or personal use. You may distribute the software or provide it to others only if you do so free of charge for non-commercial purposes."* |
| Actual BEAN FX usage | **No application code imports it — or the whole chain.** `src/` contains zero imports of `@mdxeditor/editor`, `@codesandbox/sandpack-client`, or `@codesandbox/nodebox` (the only mentions are TEXT on the public Open Source/Legal pages). The built server bundle contains no nodebox JS: the only hits for "nodebox" in `.next/standalone` are inside the PRE-RENDERED HTML of the Open Source page (the page's own legal wording). |
| Is anything shipped dependent on it? | **No shipped product functionality depends on nodebox** — it is an installed-but-unimported transitive package. This is verified, not assumed: import scan + bundle scan (evidence above). |
| Distribution implication | In HOSTED mode the package is present only inside the deployment's node_modules (files served to nobody). In CLIENT DISTRIBUTION or if a full node_modules were ever shipped to customers, the Sustainable Use restriction would be live. The restriction's main practical risk is any future paid/commercial use of the mdxeditor/sandpack chain itself. |
| Possible technical alternatives | (a) Keep as-is for HOSTED mode (unimported, unbundled) — document the exclusion (already on the Open Source Center). (b) Before any commercial distribution: remove `@mdxeditor/editor` if it stays unimported (smallest change, kills the chain) — requires owner sign-off since it changes package.json. (c) Replace the editor dependency with an MIT-licensed editor if/when an MDX editor is actually wanted. (d) License the chain commercially from CodeSandbox. |
| **State: OWNER REVIEW REQUIRED** | Decision needed: whether to (a) keep the unused direct dependency (documented exclusion, HOSTED-only), or (b) remove `@mdxeditor/editor` before commercial distribution. **Not removed in this milestone** (out of scope; removal must be the owner's call). |

## D3. libvips via `sharp` (prebuilt per-platform binaries)

| Field | Evidence |
| --- | --- |
| Packages | `sharp@0.35.5` (DIRECT, `package.json` `"sharp": "^0.35.5"`) with optional per-platform prebuilt binaries `@img/sharp-libvips-*@1.3.4` and `@img/sharp-*@0.35.5`. Audit: `@img/sharp-libvips-*` license **LGPL-3.0-or-later**, classification **COPYLEFT-WEAK** (14 instances across platforms); `sharp` itself Apache-2.0 (PERMISSIVE). |
| Actual BEAN FX usage | Image decoding/compositing in the media pipeline (thumbnails, asset processing). Used at runtime on the server. |
| Distribution implication | The prebuilt libvips shared libraries ARE binaries that live in node_modules. In HOSTED mode they run on the operator's server and are served to nobody. In SELF-HOST DISTRIBUTION the LGPL libraries are redistributed inside the artifact — LGPL obligations (notices, allowing relinking/source availability for the LIBRARY) attach; sharp's Apache-2.0 wrapper is unaffected. |
| Possible technical alternatives | (a) HOSTED-only: no change needed beyond notices (already in THIRD_PARTY_NOTICES). (b) Self-host: keep the LGPL binaries + include notices + the library source offer, counsel-reviewed. (c) Build sharp against a system libvips (removes the prebuilt binaries from the artifact) — changes the build/deploy procedure. |
| **State: OWNER REVIEW REQUIRED** | Decision needed: acceptable distribution modes + notice mechanics for self-host artifacts. |

## D4. Everything else

The M47.3 audit (regenerated on the corrected lockfile: 1007 entries → 584 production instances,
548 unique names; classification 568 PERMISSIVE / 14 COPYLEFT-WEAK / 2 NON-STANDARD; **0 unresolved
license evidence**) remains the machine-readable inventory: `docs/legal/generated/dependency-audit.json`,
`docs/legal/generated/sbom.cdx.json` (1007 components), `THIRD_PARTY_NOTICES.md`,
`docs/legal/generated/open-source-inventory.md`. The 2 NON-STANDARD instances are exactly the
nodebox chain documented in D2. No new dependency was added in M47.4; no notices were removed.

---

## Summary of decisions required from the owner

1. **D1 FFmpeg**: confirm HOSTED-only distribution (operator-installed binary) as the permitted
   mode, and instruct whether a counsel review of GPL process-invocation is required before any
   self-host artifact ships.
2. **D2 nodebox**: choose keep-with-exclusion (HOSTED) or remove the unused `@mdxeditor/editor`
   dependency before commercial distribution.
3. **D3 libvips/sharp**: confirm notice mechanics for any self-host distribution mode.

None of these decisions were made by the coding agent, and no behavior was changed to simplify them.
