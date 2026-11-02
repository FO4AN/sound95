#!/usr/bin/env bash
# Puts the login service online and records its URL for the app to build with.
# Run it in a normal terminal: it asks for the SoundCloud app credentials.
set -euo pipefail
cd "$(dirname "$0")"

read -rp 'SoundCloud Client ID: ' client_id
read -rsp 'SoundCloud Client Secret (hidden): ' client_secret
echo

log=$(mktemp)
trap 'rm -f "$log"' EXIT
npx --yes wrangler@4 deploy | tee "$log"
printf '%s' "$client_id" | npx --yes wrangler@4 secret put SOUND95_CLIENT_ID
printf '%s' "$client_secret" | npx --yes wrangler@4 secret put SOUND95_CLIENT_SECRET

url=$(grep -oE 'https://[a-z0-9.-]+\.workers\.dev' "$log" | head -1)
if [ -z "$url" ]; then
  echo 'Deployed, but could not find the URL in the output above.' >&2
  exit 1
fi
printf '%s\n' "$url" > url.txt
echo "Done: $url"
