#!/usr/bin/env bash
# Installs the latest Sound95 for the current user, with a menu entry. Needs no root.
set -eu
REPO=FO4AN/sound95
RELEASES=https://github.com/$REPO/releases/latest/download
BIN=$HOME/.local/bin/sound95
ICON=$HOME/.local/share/icons/hicolor/512x512/apps/sound95.png
ENTRY=$HOME/.local/share/applications/sound95.desktop

# Only an x86-64 build is published, and anything else would install but never start.
arch=$(uname -m)
[ "$arch" = x86_64 ] || { echo "Sound95 only has a Linux build for x86-64. This machine is $arch." >&2; exit 1; }

# The AppImage uses the system's glibc, so it needs at least the one it was built on.
# Keep in step with .github/workflows/release.yml.
v=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')
if [ -z "$v" ] || [ "$(printf '%s\n' 2.35 "$v" | sort -V | head -1)" != 2.35 ]; then
  echo "Sound95 needs glibc 2.35 or newer (Ubuntu 22.04, Debian 12, Fedora 36 or later). This system has ${v:-no glibc}." >&2
  exit 1
fi

url=$(curl -fsSL "$RELEASES/latest.json" | grep -o 'https://[^"]*\.AppImage' | head -1)
[ -n "$url" ] || { echo "No Linux build found in the latest release." >&2; exit 1; }

echo "Downloading ${url##*/}"
mkdir -p "${BIN%/*}" "${ICON%/*}" "${ENTRY%/*}"
curl -fL --progress-bar -o "$BIN.new" "$url"
chmod 755 "$BIN.new"
mv -f "$BIN.new" "$BIN"
curl -fsSL -o "$ICON" "https://raw.githubusercontent.com/$REPO/main/src-tauri/icons/icon.png"

cat > "$ENTRY" <<ENTRY
[Desktop Entry]
Type=Application
Name=Sound95
Comment=A Windows 95 style SoundCloud client
Exec=$BIN
Icon=sound95
Categories=AudioVideo;Audio;Player;
StartupWMClass=sound95
Terminal=false
ENTRY
update-desktop-database "${ENTRY%/*}" 2>/dev/null || true

echo "Installed. Open Sound95 from your app menu, or run: $BIN"
