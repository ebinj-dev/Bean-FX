# M29-C — Test Matrix (honest, every row executed unless marked)

| Suite / check | Command | Result |
|---|---|---|
| M29 integrity & bulk relink | `M29_BASE=…:3118 bun test scripts/test-m29-integrity.test.ts` | **8/8 PASS** |
| M29 portable workflow | `M29_BASE=…:3118 bun test scripts/test-m29-portability.test.ts` | **4/4 PASS** |
| Security supplements | `M29_BASE=…:3118 bun test scripts/test-m29c-security.test.ts` | **5/5 PASS** |
| M1–M28 regression batch | `DATABASE_URL=file:m29closeout.db BEANFX_DATA_DIR=media-store-closeout bash scripts/run-all-tests.sh` | **34 suites PASS; 2 FAIL (M13 temporal — sandbox OpenCV lacks CSRT; INFRASTRUCTURE REQUIRED)** |
| T1 durability render | `M29_BASE=…:3118 M29_DB=file:m29closeout.db bun scripts/m28-render-evidence.ts` | PASS — 9 s wall, ffprobe-validated, luma ramp + crossfade PASS |
| A/V synchronization | ffprobe stream comparison of the T1 output | **+0.000 s** delta (baseline ≈ −0.052 s ±0.15 s) PASS |
| Browser walkthrough | agent-browser real UI sessions (W1 package/download; W2 import; bulk relink; failure) | PASS — screenshots 01–08 |
| 375px responsive | agent-browser viewport 375×812 + scrollWidth probes | PASS — no overflow (375=375) |
| TypeScript | `bunx tsc --noEmit` | 0 errors |
| ESLint | `bunx eslint` on all touched files | clean |
| Prisma | `bunx prisma validate` | valid |
| Production build | `bun run build` | SUCCESS |
| Dev-DB isolation | reference snapshots before/after | `db/custom.db` untouched (8 users both sides) |

Environment: `scripts/m29closeout-env.sh` → `db/m29closeout.db` + `media-store-closeout/` + `:3118` + `M29_BASE` overrides in the suites.
