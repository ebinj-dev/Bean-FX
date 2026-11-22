#!/usr/bin/env bash
# BEAN FX — M36 Phase B-C: service lifecycle control.
#
# Delegates to systemd when the unit exists (systemctl beanfx …); otherwise
# runs a validated FOREGROUND SIMULATION with a PID file — the sandbox has no
# init system, so real-host behavior is OWNER ACTION (systemd template at
# deploy/systemd/beanfx.service.template).
#
# Usage: beanfxctl.sh {start|stop|restart|status|health|logs} [--env FILE]
set -u
cd "$(dirname "$0")/.."

# Generic arg parse: action first (or after --env), --env anywhere.
ENV_FILE="/home/beanfx/.env.staging"
ACTION="status"
_prev=""
for a in "$@"; do
  case "$a" in
    --env) _prev="--env" ;;
    start|stop|restart|status|health|logs) ACTION="$a"; _prev="" ;;
    *) [ "$_prev" = "--env" ] && { ENV_FILE="$a"; _prev=""; } ;;
  esac
done

PID_FILE="/tmp/beanfx-sim.pid"
LOG_FILE="/tmp/beanfx-sim.log"
PORT_FROM_ENV=$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d '"')
PORT="${PORT_FROM_ENV:-3000}"

have_systemd() { command -v systemctl >/dev/null && systemctl list-unit-files 2>/dev/null | grep -q '^beanfx\.service'; }

case "$ACTION" in
  start)
    if have_systemd; then systemctl start beanfx && systemctl status beanfx --no-pager | head -8; exit $?; fi
    # Foreground simulation: start detached from THIS shell (setsid, so the
    # service survives the operator's session), log to a file, record PID.
    [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null && { echo "already running pid=$(cat "$PID_FILE")"; exit 0; }
    # Startup gate: env must validate before the app is started (fail clearly).
    bun scripts/m36-validate-env.ts --env "$ENV_FILE" || { echo "REFUSING TO START: invalid environment"; exit 1; }
    # shellcheck disable=SC1090
    set -a; . "$ENV_FILE"; set +a
    echo "sim: starting standalone server (no init system — use systemd on a real host)"
    setsid bash scripts/dev-server.sh >"$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"; sleep 3
    ;;
  stop)
    if have_systemd; then systemctl stop beanfx; exit $?; fi
    [ -f "$PID_FILE" ] || { echo "not running (no pid file)"; exit 0; }
    PID=$(cat "$PID_FILE")
    # Controlled shutdown: SIGTERM to the process group, then SIGKILL fallback.
    kill -TERM -- "-$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
    kill -KILL -- "-$PID" 2>/dev/null || true
    rm -f "$PID_FILE"; echo "stopped"
    ;;
  restart) "$0" stop --env "$ENV_FILE"; "$0" start --env "$ENV_FILE";;
  status)
    if have_systemd; then systemctl status beanfx --no-pager | head -12; exit $?; fi
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "running (simulated) pid=$(cat "$PID_FILE")"; exit 0
    fi
    echo "stopped"; exit 3
    ;;
  health)
    MEDIA_ROOT=$(grep -E '^BEANFX_DATA_DIR=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d '"')
    bash scripts/m36-health-check.sh "http://localhost:$PORT" "${MEDIA_ROOT:-}"
    ;;
  logs)
    if have_systemd; then journalctl -u beanfx -n 100 --no-pager; else tail -50 "$LOG_FILE" 2>/dev/null || echo "no sim log"; fi
    ;;
  *) echo "usage: beanfxctl.sh {start|stop|restart|status|health|logs} [--env FILE]"; exit 2;;
esac
