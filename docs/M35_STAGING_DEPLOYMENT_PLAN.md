# M35 Track J — Staging Deployment Plan (reproducible, not executed)

**Honesty first:** no staging environment was created (no cloud resources authorized); the plan below is prepared from the M34-qualified scripts and the scripts added this milestone that WERE validated locally (`m35-health-check.sh` against the running app, `m35-backup-drill.ts`, `preflight.ts`). Docker/containerization: architecture is container-plausible (stateless server, env-configured roots) but **unvalidated — no Docker files are added**; a container image must first pass the same checklist (items 1–14) plus an ffmpeg-in-container verification, then it may replace the process model.

## 1. Environment template (`deploy/env.staging.example` — placeholders only, never real secrets)

```bash
# BEAN FX staging env — copy to /home/beanfx/.env.staging on the host (mode 600, app-user owned)
DATABASE_URL="file:/home/beanfx/data/beanfx-staging.db"   # SQLite for the initial topology (Track C)
BEANFX_DATA_DIR="/home/beanfx/data/media-store"           # absolute dedicated dir (media-storage.ts guard)
PUBLIC_APP_URL="https://staging.__DOMAIN__"               # owner domain
PORT="3000"
RATE_LIMIT_SCALE unset (default 1)                         # NEVER set in staging/production
BEANFX_ZAI_BIN="/usr/local/bin/z-ai"                       # provider CLI path (CONFIGURATION REQUIRED if absent)
# Provider credentials: injected on-host per M35_DEPLOYMENT_SECURITY §3 — placeholders:
# ASR_PROVIDER_KEY="__SET_ON_HOST__"
# IMAGE_PROVIDER_KEY="__SET_ON_HOST__"
```

## 2. Startup scripts (the actual qualified commands)

| Step | Command (from the qualified tree) |
|---|---|
| Clean install | `bun install` (620 packages, M34-verified) |
| Prisma client | `bunx prisma generate` |
| Preflight | `bun scripts/preflight.ts` → must be 0 BLOCKED (CONFIGURATION REQUIRED rows allowed) |
| DB init | `bunx prisma db push` (idempotent, non-destructive; 66 tables) |
| Start | `bash scripts/dev-server.sh` (builds if needed, starts on $PORT) — systemd unit wraps this in production staging (`systemctl start beanfx`) |
| Health check | `bash scripts/m35-health-check.sh http://localhost:3000` (VERIFIED this milestone) |
| Backup | `bun scripts/m35-backup-drill.ts "$DATABASE_URL_FILE_PATH" "$BEANFX_DATA_DIR"` (or `backup-db.sh sqlite` where sqlite3 CLI exists) |
| Restore | `restore-db.sh sqlite <backup> <scratch-target>` → verify → swap `DATABASE_URL` → restart |

## 3. Staging qualification checklist (the 14 mandated items, each a pass/fail gate)

| # | Qualify | How |
|---|---|---|
| 1 | Clean installation | fresh checkout → `bun install` → `prisma generate` → preflight 0 BLOCKED (M34 harness `qualify-clean-checkout.sh` automates 1–9 of the core flow) |
| 2 | Database initialization | `prisma db push` → 66 tables, integrity_check ok, WAL on |
| 3 | Login | register + login via UI; session cookie issued (Secure behind TLS) |
| 4 | Project creation | UI: create project → appears in switcher + dashboard |
| 5 | Media upload | upload a real mp4 → probe completes (MediaAsset row, 200) |
| 6 | Timeline editing | add clips to timeline → save → reload persists |
| 7 | Render submission | submit render → Job row QUEUED → PROCESSING |
| 8 | Worker execution | job completes; ffprobe-validated output; no `seg_*`/`list_*` leftovers |
| 9 | Export download | download export → HTTP 200, checksum matches server-side file |
| 10 | Project packaging and import | package on user A → import on user B → media locatable (M29 flow) |
| 11 | Collaboration | invite collaborator → reviewer accesses project per M30 permissions |
| 12 | Showcase Studio | intake → campaign config → paid gate: budget required before ANY paid generation (gate must stay ON) |
| 13 | Restart and recovery | `SIGKILL` server mid-render → restart → sweep re-queues → render completes (the M20 T4 flow) |
| 14 | Backup and restore | drill PASS on staging data (item 3's restore procedure) → app runs on restored copy |

**Resource gates:** host ≥ 8 GB RAM (16 recommended), SSD ≥ 2× media headroom; sequential long renders; health-check thresholds wired per Track H.

## 4. What staging must NOT do

- No production DNS, no public announcement, no paid provider activation, no destructive migrations (`db push` only on the staging DB), `RATE_LIMIT_SCALE` unset, no secrets in the repo, no weakening of consent/budget gates.
