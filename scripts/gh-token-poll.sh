#!/bin/bash
# Poll the OAuth device flow, then persist the credential durably:
#   .git/gh-sec/token   — durable store (inside .git: never committed, never
#                         cleaned by recycle, survives because .git IS the
#                         persistence mechanism)
#   authdata/gh.token   — session mirror (gitignored, 0600)
# Then execs gh-auth-restore.sh, which wires git + validates + reports.
# The token itself is NEVER printed.
set -u
SRC=/home/z/my-project
AUTH="$SRC/authdata"
SEC="$SRC/.git/gh-sec"
DEVICE_CODE=$(python3 -c "import json;print(json.load(open('$AUTH/device-flow.json')).get('device_code',''))")
INTERVAL=$(python3 -c "import json;print(json.load(open('$AUTH/device-flow.json')).get('interval',5))")
if [ -z "$DEVICE_CODE" ]; then echo "NO_DEVICE_CODE"; exit 1; fi
for i in $(seq 1 $((15 * 60 / (INTERVAL > 0 ? INTERVAL : 5)))); do
  sleep "${INTERVAL:-5}"
  RESP=$(curl -sS -X POST https://github.com/login/oauth/access_token \
    -H "Accept: application/json" \
    -d "client_id=178c6fc778ccc68e1d6a" \
    -d "device_code=$DEVICE_CODE" \
    -d "grant_type=urn:ietf:params:oauth:grant-type:device_code")
  ERR=$(echo "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('error',''))" 2>/dev/null)
  if [ "$ERR" = "authorization_pending" ]; then continue; fi
  if [ "$ERR" = "slow_down" ]; then sleep 6; continue; fi
  TOKEN=$(echo "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)
  if [ -n "$TOKEN" ]; then
    umask 177
    mkdir -p "$SEC"; chmod 700 "$SEC"
    printf '%s' "$TOKEN" > "$SEC/token"      # durable store first
    chmod 600 "$SEC/token"
    printf '%s' "$TOKEN" > "$AUTH/gh.token"  # session mirror
    chmod 600 "$AUTH/gh.token"
    echo "TOKEN_STORED durably=.git/gh-sec/token mirror=authdata/gh.token perms_checked"
    exec bash "$SRC/scripts/gh-auth-restore.sh"
  fi
  echo "FLOW_ERROR $ERR"
  exit 1
done
echo "POLL_TIMEOUT"
exit 1
