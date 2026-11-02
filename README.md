# Sound95

A Windows 95 style desktop client for SoundCloud, laid out like Spotify: library
tree, main pane, Up Next queue and a bottom player bar. Built with Tauri 2, Rust and
plain JavaScript, with no frontend build step.

## Install

Download a build from [Releases](https://github.com/FO4AN/soundscape/releases) and run it.
Click **Log In** and sign in on SoundCloud's own page, in the window that opens. There is
nothing else to set up. Your likes, playlists and follows live on SoundCloud, so they sync
everywhere. Missing audio plug-ins install themselves after one password prompt (pacman,
apt, dnf or zypper).

## Build

```bash
cd src-tauri
cargo build --release           # target/release/sound95
cargo install tauri-cli --version "^2" --locked && cargo tauri build   # deb + AppImage
```

The frontend in `dist/` is embedded at compile time, so rebuild after changing it.
Pushing a `v*` tag builds a GitHub release.

## How it works

- `src-tauri/src/login.rs`: opens SoundCloud's sign-in page in its own window and keeps
  the session it leaves behind. Sessions last about a day, so it renews them by loading
  the website out of sight. The page can't call the app, and no client ID or secret is
  involved.
- `src-tauri/src/client.rs`: API client. Holds the session and keeps requests on the API
  origin. It talks to api-v2, the website's API, because the public API answers website
  sessions with 403.
- `dist/js/api.js`: the only frontend file that knows api-v2's paths and shapes.
- `dist/js/player.js`: plays through SoundCloud's official
  [Widget](https://developers.soundcloud.com/docs/api/html5-widget), so listeners stream
  directly and don't use the app's stream limit. The player bar controls it.
- `dist/js/`: the rest of the UI.

## Testing

```bash
cd src-tauri && cargo test
cd .. && OUT=/tmp/s95 tools/e2e.sh   # needs a debug build
```

`tools/mock-soundcloud.mjs` stands in for SoundCloud, including its sign-in page, and
`tools/e2e.sh` drives the real app against it. The test hooks only exist in debug builds.

## SoundCloud API terms

The [API terms](https://developers.soundcloud.com/docs/api/terms-of-use) ban "alternative
digital content services" and copying SoundCloud's overall experience, as well as
downloads and offline listening. Sound95 credits uploaders, links back to SoundCloud and
stores no audio. It uses your own website session and the website's undocumented API
rather than a registered app, which SoundCloud doesn't support, so a change on their side
could break it without warning.
