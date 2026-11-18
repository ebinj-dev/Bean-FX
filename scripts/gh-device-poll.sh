#!/usr/bin/env bash
# Poll GitHub's OAuth device flow for the user's authorization.
# On success the access token is handed ONLY to `gh auth login --with-token`
# (stored in gh's own config under GH_CONFIG_DIR) and the temp file is
# destroyed. The token is never printed, never written to .env or source.
set -u
GH_BIN=/home/z/my-project/.tools/gh
export GH_CONFIG_DIR=/home/z/my-project/.tools/gh-config
CODE_JSON=/tmp/gh-device-code.json
TOKEN_FILE=/tmp/.gh-token-$$
trap 'shred -u "$TOKEN_FILE" 2>/dev/null; rm -f "$TOKEN_FILE"' EXIT

CLIENT_ID=178c6fc778ccc68e1d6a
DEVICE_CODE=$(python3 -c "import json;print(json.load(open('$CODE_JSON'))['device_code'])")
INTERVAL=$(python3 -c "import json;print(json.load(open('$CODE_JSON')).get('interval',5))")

for i in $(seq 1 16); do
  sleep 15
  RESP=$(curl -s -X POST https://github.com/login/oauth/access_token \
    -H "Accept: application/json" \
    -d "client_id=$CLIENT_ID" \
    -d "device_code=$DEVICE_CODE" \
    -d "grant_type=urn:ietf:params:oauth:grant-type:device_code")
  ERR=$(printf '%s' "$RESP" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('error',''))" 2>/dev/null)
  case "$ERR" in
    authorization_pending) echo "[poll $i] waiting for user authorization..." ;;
    slow_down) sleep 5; echo "[poll $i] slowing down" ;;
    expired_token|'' )
      if printf '%s' "$RESP" | grep -q '"access_token"'; then
        printf '%s' "$RESP" | python3 -c "import json,sys;open('$TOKEN_FILE','w').write(json.load(sys.stdin)['access_token'])"
        chmod 600 "$TOKEN_FILE"
        if "$GH_BIN" auth login --hostname github.com --with-token < "$TOKEN_FILE" >/dev/null 2>&1; then
          echo "gh auth login: OK (gh-managed config)"
        else
          echo "gh auth login failed (likely api.github.com rate limit) — writing hosts.yml directly (no API call)"
          mkdir -p "$GH_CONFIG_DIR"
          python3 - "$TOKEN_FILE" <<'PYEOF'
import sys, yaml, pathlib
token = pathlib.Path(sys.argv[1]).read_text().strip()
cfg_dir = pathlib.Path('/home/z/my-project/.tools/gh-config')
hosts = cfg_dir / 'hosts.yml'
data = {}
if hosts.exists():
    data = yaml.safe_load(hosts.read_text()) or {}
entry = data.get('github.com') or {}
entry.update({'oauth_token': token, 'git_protocol': 'https', 'user': 'ebinj-dev'})
data['github.com'] = entry
hosts.write_text(yaml.safe_dump(data, default_flow_style=False))
hosts.chmod(0o600)
PYEOF
        fi
        # Verify WITHOUT api.github.com: git ls-remote uses github.com only
        if git -c credential.helper="" -c credential.helper="!/home/z/my-project/.tools/gh auth git-credential" ls-remote https://github.com/ebinj-dev/Bean-FX.git HEAD >/dev/null 2>&1; then
          echo "RESULT: AUTHENTICATED (token proven against Bean-FX repo)"
          exit 0
        else
          echo "RESULT: TOKEN_STORED_BUT_REPO_ACCESS_FAILED"
          exit 2
        fi
      elif [ "$ERR" = "expired_token" ]; then
        echo "RESULT: DEVICE_CODE_EXPIRED"
        exit 1
      else
        echo "[poll $i] unexpected response: $(printf '%s' "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('error_description','?'))" 2>/dev/null)"
      fi
      ;;
    *) echo "[poll $i] error: $ERR" ;;
  esac
done
echo "RESULT: STILL_PENDING"
exit 1
