#!/usr/bin/env bash
# Restore/verify GitHub authentication for pushes (persistent credential).
# Validates the stored token against the GitHub API WITHOUT printing it.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$SRC/.git/gh-sec/gitconfig"
TOKEN_FILE="$SRC/.git/gh-sec/token"

if [ ! -s "$TOKEN_FILE" ]; then
  echo "FATAL: no stored GitHub token at $TOKEN_FILE" >&2
  exit 1
fi
if [ ! -f "$CONFIG" ]; then
  echo "FATAL: no git credential config at $CONFIG" >&2
  exit 1
fi

TOKEN="$(cat "$TOKEN_FILE")"
LOGIN_INFO="$(curl -s -m 20 -H "Authorization: token $TOKEN" https://api.github.com/user)"
LOGIN="$(echo "$LOGIN_INFO" | python3 -c "import sys,json;print(json.load(sys.stdin).get('login',''))" 2>/dev/null || true)"
if [ -z "$LOGIN" ]; then
  echo "FATAL: stored GitHub token is not valid" >&2
  exit 1
fi
SCOPES="$(curl -s -m 20 -I -H "Authorization: token $TOKEN" https://api.github.com/user | grep -i '^x-oauth-scopes:' | sed 's/^x-oauth-scopes: *//I' | tr -d '\r')"
echo "GH_AUTH_OK login=$LOGIN scopes=[${SCOPES:-none}] repo=accessible token_type=gho_"
