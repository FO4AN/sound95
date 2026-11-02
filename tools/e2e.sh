#!/usr/bin/env bash
# Runs tools/e2e.js in a real debug build against the mock SoundCloud server.
# Needs Hyprland for screenshots (hyprctl + grim). Usage:
#   OUT=/some/dir tools/e2e.sh
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${OUT:-$(mktemp -d)}
mkdir -p "$OUT"; rm -rf "$OUT/cfg" "$OUT/data"; rm -f "$OUT"/*.png
node "$ROOT/tools/mock-soundcloud.mjs" > "$OUT/mock.log" 2>&1 &
MOCK=$!
trap 'kill $MOCK ${APP:-} 2>/dev/null' EXIT
sleep 0.5
BASE=http://127.0.0.1:${MOCK_PORT:-17996}
env XDG_CONFIG_HOME="$OUT/cfg" XDG_DATA_HOME="$OUT/data" SOUND95_API_BASE=$BASE SOUND95_SIGNIN_URL=$BASE/signin SOUND95_RENEW_URL=$BASE/ \
  SOUND95_NO_BROWSER=1 SOUND95_E2E="$ROOT/tools/e2e.js" GST_REGISTRY="$OUT/reg.bin" \
  "$ROOT/src-tauri/target/debug/sound95" > "$OUT/app.log" 2>&1 &
APP=$!
shot() {
  sleep 0.4
  local at
  at=$(hyprctl clients -j | node -e "const c=JSON.parse(require('fs').readFileSync(0)).find(c=>/sound95/i.test(c.class));if(c)console.log(c.at[0]+','+c.at[1]+' '+c.size[0]+'x'+c.size[1])")
  [ -n "$at" ] && grim -g "$at" "$OUT/$1.png"
}
seen=0
for _ in $(seq 1 900); do
  sleep 0.1
  mapfile -t lines < <(grep '^E2E ' "$OUT/mock.log" | tail -n +$((seen + 1)))
  for line in "${lines[@]}"; do
    seen=$((seen + 1))
    msg=${line#E2E }
    case $msg in
      SHOT\ *) shot "${msg#SHOT }" ;;
      RESULT*) echo "$msg"; curl -s "$BASE/__log" > "$OUT/api.json"; exit 0 ;;
      *) echo "$msg" ;;
    esac
  done
done
echo "TIMEOUT"; tail -5 "$OUT/app.log"; curl -s "$BASE/__log" > "$OUT/api.json"
