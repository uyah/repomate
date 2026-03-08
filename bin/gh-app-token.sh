#!/bin/bash
# gh-app-token.sh - GitHub App Installation Token を取得
#
# Usage:
#   eval "$(./bin/gh-app-token.sh)"
#   # => GH_TOKEN が設定される
#
# Required environment variables:
#   REPOMATE_APP_ID          - GitHub App ID
#   REPOMATE_INSTALLATION_ID - GitHub App Installation ID
#   REPOMATE_PEM_FILE        - Path to private key PEM file
#
# Backwards compatible: also reads MAC_MINI_* variants
#
# Requires: openssl, curl, jq

set -euo pipefail

APP_ID="${REPOMATE_APP_ID:-${MAC_MINI_APP_ID:?REPOMATE_APP_ID is required}}"
INSTALLATION_ID="${REPOMATE_INSTALLATION_ID:-${MAC_MINI_INSTALLATION_ID:?REPOMATE_INSTALLATION_ID is required}}"
PEM_FILE="${REPOMATE_PEM_FILE:-${MAC_MINI_PEM_FILE:?REPOMATE_PEM_FILE is required}}"

if [ ! -f "$PEM_FILE" ]; then
  echo "ERROR: PEM file not found: $PEM_FILE" >&2
  exit 1
fi

# --- Generate JWT ---
now=$(date +%s)
iat=$((now - 60))
exp=$((now + 600))

header=$(echo -n '{"alg":"RS256","typ":"JWT"}' | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')
payload=$(echo -n "{\"iat\":${iat},\"exp\":${exp},\"iss\":\"${APP_ID}\"}" | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')
signature=$(echo -n "${header}.${payload}" | openssl dgst -sha256 -sign "$PEM_FILE" | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')
jwt="${header}.${payload}.${signature}"

# --- Get Installation Token ---
token=$(curl -s -X POST \
  -H "Authorization: Bearer ${jwt}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens" | jq -r '.token // empty')

if [ -z "$token" ]; then
  echo "ERROR: Failed to get installation token" >&2
  exit 1
fi

echo "export GH_TOKEN='${token}'"
