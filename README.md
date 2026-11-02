# SoundScape — Win95-style SoundCloud player (Tauri 2 / Linux)

Tauri 2 desktop wrapper around the SoundScape web frontend (Win95 UI, SoundCloud API playback).

## Build & install (Linux)

```bash
# system deps (Ubuntu/Debian)
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev

# frontend dist is committed in ./dist
cd src-tauri
cargo tauri build          # builds deb + AppImage
sudo dpkg -i target/release/soundscape_0.1.0_amd64.deb   # or use the AppImage
```

## Auto-update from GitHub

Releases are built by GitHub Actions on `v*` tags via `tauri-action` (AppImage + updater artifacts).
The updater is configured to check:

```
https://github.com/USER/REPO/releases/latest/download/{arch}-latest.json
```

Replace `USER` / `REPO` in `src-tauri/tauri.conf.json` → `plugins.updater.publishing` and the
`endpoints` array with your actual GitHub owner/repo before the first release.

After first install, the app auto-updates on launch.
