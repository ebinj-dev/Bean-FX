# M36 — Service Lifecycle & Reverse Proxy (Phase B-C/B-D)

## 1. Actual startup/shutdown behavior (audited)

- **Start:** `dev-server.sh` → (build if `.next/BUILD_ID` missing) → copy static assets into the standalone tree → `exec node .next/standalone/server.js` with `DATABASE_URL`/`PORT`/`HOSTNAME`. One process; job runner inside it; ffmpeg children spawned per render.
- **Shutdown:** SIGTERM stops the Node server. An ffmpeg orphan after SIGKILL is harmless: the startup sweep re-queues its stale job (M20 T4 — "Recovered after a worker interruption (attempt 1/3)").
- **Startup failure reporting:** invalid env → `m36-validate-env.ts` exits 1 with actionable items (ExecStartPre gate); missing build → harness builds or fails loudly; DB unreachable → `/api/health` reports the failing component with 503 and the server still boots (operator sees DEGRADED, not a crash loop) — plus, since the M36 `db.ts` change, a real DB-init failure prints an explicit `[beanfx:db]` error instead of being swallowed.

## 2. Service configuration

`deploy/systemd/beanfx.service.template` — dedicated `beanfx` system user, `EnvironmentFile=/home/beanfx/.env.staging` (mode 600), **ExecStartPre env gate (strict)**, `Restart=on-failure` + `StartLimitBurst=3/60 s` (no config-error crash loops), `KillSignal=SIGTERM`, `TimeoutStopSec=30`, `MemoryMax=16G` (M35 sizing), journald logging. Real-host validation: **OWNER ACTION** (this sandbox has no init system).

`scripts/beanfxctl.sh` — one control surface for operators: `start|stop|restart|status|health|logs`. With systemd present it delegates to `systemctl`; otherwise it runs the validated **foreground simulation** (PID file, `setsid` detach, SIGTERM→SIGKILL graceful stop, log file). **Validated live in this sandbox:** start (env gate passed, server up) → status (running pid=4890) → health (DEGRADED with precise notes against the live app) → stop → status (exit 3, stopped). This simulation validates the *logic*; real systemd behavior remains owner-qualified.

## 3. Reverse proxy & TLS

Two templates, no hardcoded domain/cert, no DNS/public exposure performed:

- `deploy/caddy/Caddyfile.staging.template` — Caddy auto-HTTPS (owner supplies the DNS name); automatic HTTP→HTTPS redirect.
- `deploy/nginx/nginx.staging.template` — explicit 80→443 redirect; owner-obtained certbot certs; TLS 1.2/1.3 only.

Both enforce (matching the audited backend):

| Requirement | Configuration |
|---|---|
| Correct upstream | `127.0.0.1:3000` — the env template binds `BIND_HOST=127.0.0.1`, so the app is reachable **only** through the proxy |
| Upload-size limits | 2 GB proxy limit — above the app's own upload validation (proxy must not be the stricter gate) |
| Long-running render requests | 600 s proxy timeouts + `flush_interval -1`; renders are polled via `/api/jobs/:id`, no held-open long requests; no WebSocket/streaming exists in the app — none configured |
| Forwarded headers | `X-Forwarded-For $remote_addr` set from the socket peer; **client-supplied `X-Forwarded-*` never trusted/passed** (Caddy trusted-proxy defaults documented) |
| Security headers | HSTS (max-age 1 y, includeSubDomains), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, server tokens hidden; no CSP yet — owner may tighten after visual verification (documented, not imposed) |

**Not performed:** domain creation, certificate issuance, DNS changes, public firewall ports — all OWNER ACTION per milestone scope.

## 4. Log inspection guidance

- systemd: `journalctl -u beanfx -n 200` / `journalctl -u beanfx -f` (identifier `beanfx`).
- Simulation: `beanfxctl.sh logs` → tail of `/tmp/beanfx-sim.log`.
- Rehearsal/qualification logs: per-step files under the rehearsal target (`step*.log`).
- Server logs carry no secrets (provider errors are redacted in-app; env values are never echoed by any M36 tool).
