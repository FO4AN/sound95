#!/usr/bin/env bash
# Installs the latest Sound95 for the current user, with a menu entry. Needs no root.
set -eu
REPO=FO4AN/sound95
RELEASES=https://github.com/$REPO/releases/latest/download
BIN=$HOME/.local/bin/sound95
ICON=$HOME/.local/share/icons/hicolor/512x512/apps/sound95.png
ENTRY=$HOME/.local/share/applications/sound95.desktop

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
