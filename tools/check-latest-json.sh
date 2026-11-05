#!/usr/bin/env bash
# Fails unless a release's latest.json offers this version to Windows and Linux, and
# every entry in it points at a file of the release with that file's signature.
# Every installed copy reads this file, and the Windows and Linux builds each merge
# their entries into it at the same time, so one can overwrite the other's.
# Usage: GH_REPO=owner/repo tools/check-latest-json.sh <release id> <version>
set -euo pipefail
[ $# -eq 2 ] || { echo "Usage: GH_REPO=owner/repo $0 <release id> <version>" >&2; exit 1; }
release=$1
version=$2

fail() {
  echo "::error::$*"
  exit 1
}
assets=$(gh api "repos/$GH_REPO/releases/$release/assets?per_page=100" --jq '.[] | "\(.id)\t\(.name)"')
has() { awk -F'\t' -v name="$1" '$2 == name { found = 1 } END { exit !found }' <<< "$assets"; }
# Prints a file of the release, or fails if it has none by that name.
asset() {
  local id
  id=$(awk -F'\t' -v name="$1" '$2 == name { print $1 }' <<< "$assets")
  [ -n "$id" ] && gh api -H 'Accept: application/octet-stream' "repos/$GH_REPO/releases/assets/$id"
}

json=$(asset latest.json) || fail "The release has no latest.json."
found=$(jq -r '.version' <<< "$json")
[ "$found" = "$version" ] || fail "latest.json offers version $found, not $version."
for platform in windows-x86_64 linux-x86_64; do
  jq -e --arg p "$platform" '.platforms[$p].url' <<< "$json" > /dev/null ||
    fail "latest.json has no $platform entry, so that platform would never see $version. Re-run that platform's build job, which merges its entries back in; publish then runs again."
done
while IFS=$'\t' read -r platform url; do
  name=${url##*/}
  has "$name" || fail "latest.json's $platform entry points at $name, which isn't in the release."
  sig=$(asset "$name.sig") || fail "The release has no $name.sig for latest.json's $platform entry."
  signature=$(jq -r --arg p "$platform" '.platforms[$p].signature // ""' <<< "$json")
  [ -n "$signature" ] && [ "$signature" = "$sig" ] ||
    fail "latest.json's $platform signature isn't the one in $name.sig, so the update would be refused."
  echo "$platform: $name"
done < <(jq -r '.platforms | to_entries[] | "\(.key)\t\(.value.url)"' <<< "$json")
echo "latest.json offers $version to Windows and Linux."
