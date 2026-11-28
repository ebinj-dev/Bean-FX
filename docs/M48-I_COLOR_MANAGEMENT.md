# M48-I — color management (SDR): supported spaces, honest matrix

Working space: **stored-gamma RGB [0,1] with Rec.709 primaries assumed** (standard
SDR NLE behaviour). Sources are decoded as stored; nothing is silently converted.

## Input handling (probed metadata → interpretation)

- `ffprobe` extracts `color_space/color_transfer/color_primaries/color_range/pix_fmt`
  into `probeMetaJson` (M-era deep probe already persists it).
- `/api/media/[id]` returns `colorInterpretation` (interpretSourceColor):
  missing metadata → documented default (limited-range Rec.709) + flagged;
  full-range → supported + noted; non-Rec.709-family primaries/HDR transfers →
  **flagged, not converted, support=false**.

## Compatibility matrix (also machine-readable: `COLOR_SUPPORT_MATRIX`)

| Case | Status |
| --- | --- |
| Rec.709/sRGB SDR limited range | supported (native) |
| Rec.709/sRGB SDR full range | supported (flag preserved on export) |
| Rec.601-family SDR | supported as stored-gamma (flagged, no matrix conversion) |
| Missing metadata | defaulted + flagged |
| HDR10 (smpte2084) | NOT implemented — flagged |
| HLG | NOT implemented — flagged |
| Dolby Vision | NOT implemented — flagged |
| ACES / ICC | NOT implemented (no claim, no partial path) |
| 3D .cube LUT (2..128³) | supported (trilinear, domain respected) |
| 1D .cube | parsed + validated; application NOT supported (never mis-applied) |
| .3dl/.csp/hald | NOT supported |

## Parity model

One grading model (`src/lib/color/grade-model.ts`) → WebGL2 shader (preview)
+ 129³ baked cube via `lut3d` (export). Measured parity on decoded pixels:
mean ≤ 0.45/255 for grade-only / LUT-only / grade+LUT / identity-LUT with a
symmetric 4:2:0 chroma round-trip (see scripts/test-m48-i5-parity.test.ts).

## Unavoidable differences (documented)

- Display color management: the browser presents sRGB; the export carries no
  display transform. On a wide-gamut display with system color management the
  preview appearance may differ cosmetically from a player's rendering.
- GPU precision: the preview shader runs float32; the export quantizes through
  the cube + yuv420p encoding. Measured residual: mean ≤ 0.45/255, p99.9 ≤ 9/255.
- Scopes sample at 256×144 (disclosed on the panel) from the graded image.

## Licensing

No LUT libraries or color-processing dependencies were bundled (I9: zero new
dependencies). Imported .cube files are user-owned; licensing responsibility
stays with the user (stated in the UI).
