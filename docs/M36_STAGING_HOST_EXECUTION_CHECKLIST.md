# M36 — Staging Host Execution Checklist (Phase H)

**Phase-H gate resolved honestly:** no staging host exists in this environment and none is provisioned or authorized during this milestone — no remote host was connected to, no cloud account/server/storage/DNS/certificate was created, no public port opened, no real user data uploaded. Therefore M36 completes the **local** rehearsal and delivers this checklist as the explicit owner path to staging execution.

## 0. Host requirements (from M35 sizing, M34 render evidence)

| Item | Requirement |
|---|---|
| OS | Linux x64 (systemd-based distro recommended) |
| RAM | ≥ 8 GB minimum; **16 GB recommended** (M35 sizing: ffmpeg ~2.5 GB RSS on long renders + OS + server) |
| CPU | ≥ 4 dedicated vCPU (libx264 `veryfast` CPU-bound; M20 T3 600 s timeline ≈ 395 s wall on 4 vCPU-class) |
| Disk | SSD/NVMe; ≥ 2× largest planned export free (transient segments + concat); separate growth headroom for media |
| Runtime | Bun ≥ 1.3 + Node ≥ 20 + ffmpeg + ffprobe (versions checked by `m36-install.sh`) |
| GPU | **none required** (CPU rendering; no GPU path exists) |

## 1. Access & permissions
- [ ] SSH access with sudo; create dedicated `beanfx` system user (no login shell): `useradd -r -m -d /home/beanfx -s /usr/sbin/nologin beanfx`
- [ ] App checkout owned by `beanfx`; data root `/home/beanfx/data` mode 700
- [ ] No secrets ever pasted in chat — env file created ON the host (mode 600)

## 2. Firewall & TLS prerequisites
- [ ] Public ports: 80 + 443 ONLY (proxy); app bound to `127.0.0.1` (`BIND_HOST=127.0.0.1`)
- [ ] DNS `A/AAAA` record → host (owner-managed; **created by owner, not this milestone**)
- [ ] TLS: Caddy (auto-HTTPS) or Nginx + certbot — templates in `deploy/caddy/` / `deploy/nginx/`; owner supplies the real hostname
- [ ] Direct app port (3000) NOT reachable from outside

## 3. Persistent storage setup
- [ ] `bash scripts/m36-fs-layout.sh /home/beanfx/data` → creates `media-store/`, `backups/` (0700), `logs/`; refuses system paths; checks headroom
- [ ] Confirm renders have ≥2× export headroom; confirm backups dir exists for the health check's freshness rule

## 4. Environment configuration
- [ ] Copy `deploy/env.staging.example` → `/home/beanfx/.env.staging` (mode 600); set real `DATABASE_URL` + `BEANFX_DATA_DIR`; `BIND_HOST=127.0.0.1`; providers left unconfigured unless owner-approved
- [ ] `bun scripts/m36-validate-env.ts --env /home/beanfx/.env.staging --strict` → 0/2 (never 1)
- [ ] `RATE_LIMIT_SCALE` unset

## 5. Installation
- [ ] Clone the repo as `beanfx` onto the host; `bash scripts/m36-install.sh --env /home/beanfx/.env.staging` → `INSTALL_OK` (9 gated steps incl. non-destructive `db push` + db verify)

## 6. Service
- [ ] Install `deploy/systemd/beanfx.service.template` → `/etc/systemd/system/beanfx.service` (adjust paths); `daemon-reload && enable --now beanfx`
- [ ] `beanfxctl.sh status` → active; `beanfxctl.sh health` → HEALTHY (or DEGRADED with explained notes)

## 7. Proxy & TLS
- [ ] Install Caddyfile/nginx template with the real hostname; reload; verify `https://<host>` serves the editor and `http://` redirects

## 8. Render qualification (on the real host)
- [ ] Submit one short render via UI; verify ffprobe-valid export + zero `seg_*`/`list_*` leftovers (health check stays clean)
- [ ] One long render (≥300 s timeline) to observe memory/disk on real hardware; record measurements (M35 estimates → replace with host measurements)

## 9. Backup & restore drill (REQUIRED before calling staging operational)
- [ ] First manual backup: `m36-backup.ts backup --db … --media … --out /home/beanfx/data/backups --verify` → `BACKUP_VERIFY_OK` + note `OFF-HOST BACKUP: CONFIGURATION REQUIRED` (decide the off-host adapter → M36_BACKUP_RESTORE_OPERATIONS §3)
- [ ] Nightly timer installed (runbook §4) + quarterly restore drill scheduled
- [ ] Full restore drill: restore → `m36-db-ops verify` → scratch-boot restored app → `/api/health` 200

## 10. Rollback procedure
- [ ] Previous build retained: `m36-upgrade.sh` rebuilds in place — rollback = `git checkout <previous-tag/sha>` → `bun install --frozen-lockfile && bunx prisma generate && bun run build` → `systemctl restart beanfx`
- [ ] Data rollback = restore latest verified snapshot into an isolated root → verify → swap `DATABASE_URL`/`BEANFX_DATA_DIR` → restart (never in-place repair)
- [ ] Database schema rollback: `db push` is not auto-reversible — restore the pre-upgrade snapshot instead (the upgrade made one BEFORE touching schema)

## 11. Acceptance evidence required BEFORE staging can be declared operational
1. `INSTALL_OK` + preflight 0 BLOCKED · 2. health HEALTHY · 3. TLS/proxy verified · 4. render qualification with ffprobe evidence + resource measurements · 5. backup with `BACKUP_VERIFY_OK` · 6. restore drill with row counts + media hashes · 7. restart drill (SIGTERM → start → jobs functional) · 8. off-host backup decision recorded · 9. all of it in the ops log with dates.

**Verdict impact:** until these are produced, the honest milestone verdict remains READY FOR STAGING HOST EXECUTION (owner-provisioned, owner-authorized) — staging is NOT claimed qualified by this milestone.
