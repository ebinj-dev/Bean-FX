# BEAN FX — Third-Party Software Notices & Inventory

Maintained per the implementation directive (§11, §18-16): every external
dependency and its license is recorded here before it enters a milestone.
This file is the living inventory; the authoritative version list for npm
packages is `package.json` (lockfile-pinned) — this file records *why* each
item is acceptable and what obligations follow.

## 1. Runtime dependencies (existing, verified in use)

| Component | License | Notes / obligations |
|---|---|---|
| Next.js, React, React DOM | MIT | Web UI framework. Notices preserved via bundling; no modification upstream. |
| Prisma / @prisma/client | Apache-2.0 | ORM. Unmodified. |
| zod | MIT | Schema validation — the basis of all editing-command validation. |
| Radix UI packages | MIT | Headless primitives used by the existing shadcn/ui design system. |
| Tailwind CSS 4, tailwindcss-animate, tw-animate-css | MIT | Styling only. |
| @tanstack/react-query, react-table | MIT | Client data layer. |
| framer-motion | MIT | Existing animations (preserved UI). |
| lucide-react | ISC | Icons. |
| next-auth | Apache-2.0 | Auth (Session model). |
| next-intl, next-themes | MIT | i18n/theming infrastructure. |
| @dnd-kit/* | MIT | Existing drag interactions; candidate for timeline drag reuse (M2). |
| react-resizable-panels | MIT | Existing panel layout. |
| sharp | Apache-2.0 (bundled libvips LGPL-2.1+) | Image processing via separate native lib — process isolation, not linked into our source. |
| recharts, embla-carousel, sonner, vaul, cmdk, etc. | MIT | Existing UI utilities. |
| z-ai-web-dev-sdk | Proprietary SDK (first-party gateway) | Configured provider gateway — the only AI path; credentials never committed. |
| uuid | MIT | ID generation. |
| date-fns | MIT | Formatting. |

## 2. External binaries (not distributed by this repository)

| Binary | License | Integration form | Obligations |
|---|---|---|---|
| FFmpeg (system-installed) | LGPL-2.1+ typically; GPL/GPLv3 if built with those flags | **Separate process**, CLI invocation only — no library linking, no source derivation | No binary redistribution from this repo without a license-reviewed build record (enabled libraries + flags). Distro binary keeps us on the distributor's licensing. |
| ffprobe (FFmpeg) | same | Separate process for media inspection | same |

## 3. Local inference sidecars (merged via PR #1)

| Component | License | Form |
|---|---|---|
| faster-whisper (Python, sidecar) | MIT | Separate process, pip-installed at deployment — not bundled. |
| CTranslate2 | MIT | Wheel dependency of faster-whisper. |
| llama.cpp `llama-server` (optional, managed by semantic sidecar) | MIT | Built/installed by the user; separate process; model files never in Git. |
| Qwen2.5 GGUF models | Apache-2.0 model license (Qwen family) | User-installed weights; never committed. |

## 4. Candidate repositories evaluated (Milestone 0) — none adopted

| Repo | License (verified position) | Decision + reason |
|---|---|---|
| FFmpeg/FFmpeg | LGPL-2.1+ / GPL build variants | Use system binary (§2). |
| mltframework/mlt | LGPL-3.0 framework, GPL components in ecosystem | Not adopted — GPL-tainted surface, no capability gap vs FFmpeg for M1–M5. |
| remotion-dev/remotion | Source-available custom license; commercial use requires paid licensing | Not adopted — NIIKI renders deterministic templates via FFmpeg filters; avoids per-company licensing obligations entirely. |
| Ronald-Prato/recai | To be re-verified at any proposed reuse time | Not adopted for M1; gate: full license + maintenance review before any code enters the repo. |
| 0xsline/OpenChatCut | Thin maintenance/license history | Not adopted; orchestration built natively on validated commands (M8). |

## 5. SBOM

A machine-readable SBOM (CycloneDX) is generated from the lockfile at each
hardening milestone (`scripts/gen_sbom.ts` — added in M10 with the
observability work). Until then this file plus `bun.lockb`/lockfile is the
inventory of record. Any milestone that adds a dependency **must** update
this file in the same commit.
