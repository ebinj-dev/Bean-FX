#!/bin/bash
# GitHub OAuth device flow (uses the public gh-cli OAuth app client_id).
# Writes the token to /home/z/my-project/.tools/gh.token (chmod 600).
# No secrets are printed; only the user_code (meant to be shown to the user).
set -u
mkdir -p /home/z/my-project/.tools
OUT=/home/z/my-project/.tools/device-flow.json
for attempt in 1 2 3 4 5 6; do
  curl -s -X POST https://github.com/login/device/code \
    -H "Accept: application/json" \
    -d client_id=178c6fc778ccc68e1d6a \
    -d "scope=repo,workflow" -d audience="https://github.com/ebinj-dev/Bean-FX" > "$OUT" 2>/dev/null
  DEVICE_CODE=$(python3 -c "import json;print(json.load(open('$OUT')).get('device_code',''))" 2>/dev/null)
  USER_CODE=$(python3 -c "import json;print(json.load(open('$OUT')).get('user_code',''))" 2>/dev/null)
  INTERVAL=$(python3 -c "import json;print(json.load(open('$OUT')).get('interval',5))" 2>/dev/null)
  if [ -z "$DEVICE_CODE" ] || [ -z "$USER_CODE" ]; then sleep 3; continue; fi
  echo "USER_CODE_READY $USER_CODE (attempt $attempt)"
  # Poll for up to ~14 minutes (code TTL); then exit and let the next attempt re-issue.
  for i in $(seq 1 $((14 * 60 / (INTERVAL > 0 ? INTERVAL : 5)))); do
    sleep "${INTERVAL:-5}"
    RESP=$(curl -s -X POST https://github.com/login/oauth/access_token \
      -H "Accept: application/json" \
      -d client_id=178c6fc778ccc68e1d6a \
      -d device_code="$DEVICE_CODE" \
      -d "grant_type=urn:ietf:params:oauth:grant-type:device_code")
    ERR=$(echo "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('error',''))" 2>/dev/null)
    if [ "$ERR" = "authorization_pending" ]; then continue; fi
    if [ "$ERR" = "slow_down" ]; then sleep 5; continue; fi
    TOKEN=$(echo "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)
    if [ -n "$TOKEN" ]; then
      umask 177; printf 'ghp-placeholder' > /dev/null  # no-op guard
      printf '%s' "$TOKEN" > /home/z/my-project/.tools/gh.token
      chmod 600 /home/z/my-project/.tools/gh.token
      echo "AUTH_COMPLETE"
      exit 0
    fi
    echo "FLOW_ERROR $ERR"; exit 1
  done
  echo "CODE_EXPIRED_ATTEMPT $attempt"
done
echo "FLOW_GAVE_UP"
exit 1
