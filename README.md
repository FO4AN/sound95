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

## Features

- **Track pages.** Click a track's name or picture for its page: waveform, details, lyrics
  and related tracks, all inside the app.
- **Visualizer.** Spectrum, Oscilloscope, Mystify and Starfield, driven by the audio that's
  actually playing. There's a small meter in the player bar too. Double click to fill the window.
- **Karaoke.** Finds lyrics for whatever plays and wipes through them in time. `[` moves the
  words earlier and `]` later. If a song only has plain text, the timing is a guess, and **Tap to
  Sync** lets you fix it: press Space as each line starts and it's saved for that track.
  **Paste Lyrics** covers songs nobody has published words for.

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
- `src-tauri/src/lyrics.rs`: finds lyrics. LRCLIB and NetEase have timing, and Genius has
  the words when they don't. It works out the artist and song from messy titles, checks
  each result against the track's name and length, and scales the timing of sped-up
  uploads. Hosts are fixed in the code and no SoundCloud session is sent to them.
- `src-tauri/src/visual.rs`: taps the app's own audio through PipeWire (`pw-record`) and
  turns it into frequency bands, because the page can't read SoundCloud's player. It
  only touches this app's streams and never opens a microphone, though a desktop that
  flags any audio capture may show a recording icon. It also reads the output device's
  delay, about 300 ms on Bluetooth, so words and bars match what you hear. Without PipeWire, the visualizer
  follows the track's published loudness and says so in its status bar.
- `dist/js/player.js`: plays through SoundCloud's official
  [Widget](https://developers.soundcloud.com/docs/api/html5-widget), so listeners stream
  directly and don't use the app's stream limit. The player bar controls it.
- `dist/js/karaoke.js`, `visualizer.js`, `waveform.js`, `windows.js`: the new windows.
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
stores no audio. Lyrics are fetched when you ask for them and belong to their writers;
NetEase's and Genius's endpoints are undocumented too. It uses your own website session and the website's undocumented API
rather than a registered app, which SoundCloud doesn't support, so a change on their side
could break it without warning.
