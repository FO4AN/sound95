#!/usr/bin/env bash
# Fails if anything in an AppImage needs a newer glibc than the given version.
# The AppImage bundles GTK and WebKitGTK from the build machine but uses the system's
# glibc, so a newer build machine silently stops it starting on older systems.
# Usage: tools/check-glibc.sh 2.35 path/to/Sound95.AppImage...
set -eu
[ $# -ge 2 ] || { echo "Usage: $0 2.35 path/to/Sound95.AppImage..." >&2; exit 1; }
max=$1
shift

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
bad=0
for appimage in "$@"; do
  app=$(realpath "$appimage")
  dir=$(mktemp -d -p "$tmp")
  (cd "$dir" && "$app" --appimage-extract >/dev/null)
  elves=0
  while IFS= read -r -d '' f; do
    [ "$(head -c 4 "$f" | od -An -tx1 | tr -d ' \n')" = 7f454c46 ] || continue
    elves=$((elves + 1))
    # The loader skips a weak version it can't find, so only the others count.
    need=$(readelf -V -W "$f" 2>/dev/null |
      awk '/Name: GLIBC_[0-9.]+ +Flags:/ && !/WEAK/ { sub(/.*Name: GLIBC_/, ""); print $1 }' |
      sort -V | tail -1)
    if [ -n "$need" ] && [ "$(printf '%s\n' "$max" "$need" | sort -V | tail -1)" != "$max" ]; then
      echo "${f#"$dir"/squashfs-root/} needs glibc $need"
      bad=1
    fi
  done < <(find "$dir/squashfs-root" -type f -print0)
  # An empty or failed extraction must not pass as clean.
  [ "$elves" -gt 0 ] || { echo "Found no programs in $appimage." >&2; exit 1; }
  echo "Checked $elves programs and libraries in ${appimage##*/}."
done

if [ "$bad" = 1 ]; then
  echo "These won't load on glibc $max. Build on an older system." >&2
  exit 1
fi
echo "Everything loads on glibc $max."
