'use strict';

/* SoundScape — Windows 95 style SoundCloud player
   API flow (mirrors reverse-engineered SoundCloud Desktop client):
   1. GET https://soundcloud.com            -> extract public client_id from hydration
   2. GET https://api-v2.soundcloud.com/... -> tracks / search / resolve
   3. resolve transcoding url -> stream audio
*/

const audio = document.getElementById('audio');
const searchInput = document.getElementById('search');
const btnSearch = document.getElementById('btn-search');
const btnPlay = document.getElementById('btn-play');
const btnStop = document.getElementById('btn-stop');
const btnPrev = document.getElementById('np-prev');
const btnNext = document.getElementById('np-next');
const npPlayPause = document.getElementById('np-playpause');
const npStop = document.getElementById('np-stop');
const trackListEl = document.getElementById('tracklist');
const statusEl = document.getElementById('statusbar');
const statusMsg = document.getElementById('status-msg');
const statusRight = document.getElementById('status-right');
const artworkEl = document.getElementById('artwork');
const npTitle = document.getElementById('np-title');
const npArtist = document.getElementById('np-artist');
const progressFill = document.getElementById('progress-fill');
const seekEl = document.getElementById('seek');
const timeCur = document.getElementById('time-cur');
const timeTotal = document.getElementById('time-total');
const volEl = document.getElementById('volume');

let queue = [];
let currentIndex = -1;
let currentTrack = null;
let clientId = null;
let duration = 0;

function setStatus(s) { statusMsg.textContent = s || ''; }
function setStatusRight(s) { statusRight.textContent = s || ''; }

function fmt(ms) {
  if (ms == null || isNaN(ms)) return '0:00';
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ':' + String(r).padStart(2, '0');
}

function artistOf(t) { return (t.artist || t.artist_names || 'Unknown Artist'); }

/* ---------- SoundCloud API ---------- */

async function getClientId() {
  if (clientId) return clientId;
  if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
    clientId = await window.__TAURI_INTERNALS__.invoke('sc_client_id', {});
    setStatusRight('SC client_id loaded (rust)');
    return clientId;
  }
  const html = await (await fetch('https://soundcloud.com')).text();
  const re = /"hydratable"\s*:\s*"apiClient"\s*,\s*"data"\s*:\s*\{\s*"id"\s*:\s*"([^"]+)"/;
  const m = html.match(re);
  if (!m) throw new Error('Could not extract SoundCloud client_id');
  clientId = m[1];
  setStatusRight('SC client_id loaded');
  return clientId;
}

async function scApi(path) {
  const cid = await getClientId();
  const res = await fetch('https://api-v2.soundcloud.com' + path + '?client_id=' + cid);
  if (!res.ok) throw new Error('SoundCloud API error ' + res.status);
  return res.json();
}

async function searchTracks(q) {
  setStatus('Searching for "' + q + '"...');
  if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
    const tracks = await window.__TAURI_INTERNALS__.invoke('sc_search', { q: q, limit: 30 });
    const results = (tracks || []).filter(function (r) { return r && r.id; });
    return results.map(function (r) {
      return {
        id: r.id,
        urn: r.urn,
        title: r.title || 'Untitled',
        artist: r.artist || r.artist_names || 'Unknown Artist',
        duration: r.duration || 0,
        artwork: r.artwork || '',
        transcodings: r.transcodings || [],
        track_authorization: r.track_authorization || null
      };
    });
  }
  const data = await scApi('/search/tracks?q=' + encodeURIComponent(q) + '&limit=30&offset=0');
  const results = (data.results || []).filter(function (r) { return r.kind === 'track'; });
  const tracks = results.map(function (r) {
    return {
      id: r.id,
      urn: r.urn,
      title: r.title || 'Untitled',
      artist: artistOf(r),
      duration: r.duration || 0,
      artwork: r.artwork_url || '',
      transcodings: (r.media && Array.isArray(r.media.transcodings)) ? r.media.transcodings : (r.transcodings || []),
      track_authorization: r.track_authorization || null
    };
  });
  return tracks;
}

function pickBest(list) {
  const usable = (list || []).filter(function (t) {
    if (!t || !t.url) return false;
    if (String(t.url).indexOf('/preview') !== -1) return false;
    if (t.snipped) return false;
    if (t.format && t.format.protocol && String(t.format.protocol).toLowerCase().indexOf('encrypt') !== -1) return false;
    return true;
  });
  const presets = ['mp3_1_0', 'aac_160k', 'opus_0_0', 'abr_sq'];
  const key = function (t) { const i = presets.indexOf(t.preset); return i < 0 ? 999 : i; };
  const isProgressive = function (t) { return !!(t.format && t.format.protocol === 'progressive'); };
  const progressive = usable.filter(isProgressive);
  const other = usable.filter(function (t) { return !isProgressive(t); });
  const out = [];
  const addAll = function (arr) {
    arr.slice().sort(function (a, b) { return key(a) - key(b); }).forEach(function (t) { if (out.indexOf(t) === -1) out.push(t); });
  };
  for (let i = 0; i < presets.length; i++) { const f = progressive.find(function (t) { return t.preset === presets[i]; }); if (f) out.push(f); }
  progressive.forEach(function (t) { if (out.indexOf(t) === -1) out.push(t); });
  for (let i = 0; i < presets.length; i++) { const f = other.find(function (t) { return t.preset === presets[i]; }); if (f) out.push(f); }
  other.forEach(function (t) { if (out.indexOf(t) === -1) out.push(t); });
  return out[0] || null;
}

function resolveStreamUrl(t, cid, auth) {
  var sep = t.url.indexOf('?') === -1 ? '?' : '&';
  var url = t.url + sep + 'client_id=' + cid;
  if (auth) url += '&track_authorization=' + auth;
  return url;
}

/* ---------- Playback ---------- */

async function playTrack(track, index) {
  if (!track) return;
  currentIndex = index;
  currentTrack = track;
  setStatus('Loading "' + track.title + '"...');
  try {
    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
      try {
        const res = await window.__TAURI_INTERNALS__.invoke('sc_play_track', { trackId: track.id });
        if (res && res.stream_url) {
          currentTrack = Object.assign({}, track, res);
          audio.src = res.stream_url;
          audio.volume = parseFloat(volEl.value) || 1;
          await audio.play();
          setStatus('Playing: ' + currentTrack.title);
          return;
        }
      } catch (e) { /* fall through to local resolve flow */ }
    }
    let trans = track.transcodings;
    let auth = track.track_authorization;
    if ((!trans || !trans.length) && track.id) {
      const full = await scApi('/tracks/' + track.id);
      trans = (full.media && Array.isArray(full.media.transcodings)) ? full.media.transcodings : (full.transcodings || []);
      auth = full.track_authorization || null;
    }
    const t = pickBest(trans || []);
    if (!t) { setStatus('No stream available for this track.'); return; }
    // Resolve: transcoding url + client_id -> JSON { url: <final signed stream url> }
    const sep = t.url.indexOf('?') === -1 ? '?' : '&';
    const resolveUrl = t.url + sep + 'client_id=' + clientId + (auth ? '&track_authorization=' + auth : '');
    const rres = await fetch(resolveUrl);
    if (!rres.ok) throw new Error('Resolve failed: HTTP ' + rres.status);
    const rjson = await rres.json();
    const finalUrl = rjson.url || resolveUrl;
    audio.src = finalUrl;
    audio.volume = parseFloat(volEl.value) || 1;
    await audio.play();
    setStatus('Playing: ' + track.artist + ' - ' + track.title);
  } catch (e) {
    setStatus('Playback error: ' + e.message);
  }
}

async function playAt(i) {
  if (i < 0 || i >= queue.length) return;
  await playTrack(queue[i], i);
}

function stopPlayback() {
  try { audio.pause(); } catch (e) {}
  audio.removeAttribute('src');
  audio.load();
  currentIndex = -1;
  currentTrack = null;
  duration = 0;
  timeCur.textContent = '0:00';
  timeTotal.textContent = '-0:00';
  npTitle.textContent = 'Nothing playing';
  npArtist.textContent = '\u2014';
  artworkEl.src = '';
  renderNowPlaying();
}

function togglePlay() {
  if (currentTrack) {
    if (audio.src && !audio.paused) { audio.pause(); npPlayPause.innerHTML = '&#9654;'; }
    else { audio.play(); npPlayPause.innerHTML = '&#10074;'; }
  } else if (queue.length) {
    playAt(0);
  }
}

function nextTrack() {
  if (currentIndex >= 0 && currentIndex < queue.length - 1) playAt(currentIndex + 1);
}

function prevTrack() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (currentIndex > 0) playAt(currentIndex - 1);
}

/* ---------- Events ---------- */

audio.addEventListener('timeupdate', function () {
  const cur = audio.currentTime * 1000;
  timeCur.textContent = fmt(cur);
  if (duration) {
    const rem = duration - cur;
    timeTotal.textContent = fmt(rem > 0 ? rem : 0);
  }
  var pct = 0;
  if (duration > 0) pct = Math.min(100, (cur / duration) * 100);
  progressFill.style.width = pct + '%';
});

audio.addEventListener('loadedmetadata', function () {
  duration = (audio.duration * 1000) || 0;
  seekEl.max = duration ? duration / 1000 : 0;
  seekEl.value = 0;
  timeTotal.textContent = fmt(duration);
  renderNowPlaying();
});

audio.addEventListener('ended', function () {
  if (currentIndex >= 0 && currentIndex < queue.length - 1) playAt(currentIndex + 1);
  else stopPlayback();
});

progressFill.addEventListener('click', function (e) {
  if (!duration) return;
  var r = progressFill.getBoundingClientRect();
  var ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  audio.currentTime = ratio * duration;
});

seekEl.addEventListener('input', function () {
  if (!duration) return;
  audio.currentTime = parseFloat(seekEl.value);
});

volEl.addEventListener('input', function () { audio.volume = parseFloat(volEl.value); });

btnPlay.addEventListener('click', togglePlay);
btnStop.addEventListener('click', stopPlayback);
btnPrev.addEventListener('click', prevTrack);
btnNext.addEventListener('click', function () { if (currentIndex >= 0) playAt(currentIndex + 1); });
npPlayPause.addEventListener('click', togglePlay);
npStop.addEventListener('click', stopPlayback);

audio.addEventListener('play', function () { npPlayPause.innerHTML = '&#10074;'; });
audio.addEventListener('pause', function () { npPlayPause.innerHTML = '&#9654;'; });

/* ---------- Rendering ---------- */

function renderList() {
  trackListEl.innerHTML = '';
  var empty = document.createElement('div');
  empty.id = 'tracklist-empty';
  empty.textContent = queue.length ? '' : 'No tracks loaded. Search for something!';
  trackListEl.appendChild(empty);
  queue.forEach(function (t, i) {
    var row = document.createElement('div');
    row.className = 'track-row' + (i === currentIndex ? ' playing' : '');
    var play = document.createElement('button');
    play.style.minWidth = '22px';
    play.textContent = '\u25B6';
    play.addEventListener('click', function () { playAt(i); });
    var title = document.createElement('span');
    title.className = 't-title';
    title.textContent = t.title;
    var artist = document.createElement('span');
    artist.className = 't-artist';
    artist.textContent = t.artist;
    var dur = document.createElement('span');
    dur.textContent = fmt(t.duration);
    row.appendChild(play);
    row.appendChild(title);
    row.appendChild(artist);
    row.appendChild(dur);
    row.addEventListener('click', function () { playAt(i); });
    trackListEl.appendChild(row);
  });
}

function renderNowPlaying() {
  if (!currentTrack) {
    npTitle.textContent = 'Nothing playing';
    npArtist.textContent = '\u2014';
    artworkEl.src = '';
    npPlayPause.innerHTML = '&#9654;';
    return;
  }
  npTitle.textContent = currentTrack.title;
  npArtist.textContent = currentTrack.artist;
  artworkEl.src = currentTrack.artwork || '';
  npPlayPause.innerHTML = (audio.src && !audio.paused) ? '&#10074;' : '&#9654;';
}

/* ---------- Actions ---------- */

async function doSearch() {
  var q = searchInput.value.trim();
  if (!q) { setStatus('Type something to search for.'); return; }
  try {
    var tracks = await searchTracks(q);
    queue = tracks;
    renderList();
    setStatus('Found ' + tracks.length + ' tracks for "' + q + '".');
    if (tracks.length) playAt(0);
  } catch (e) {
    setStatus('Search failed: ' + e.message);
  }
}

btnSearch.addEventListener('click', doSearch);
searchInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });

/* ---------- State persistence (localStorage) ---------- */

function saveState() {
  try {
    localStorage.setItem('sc_win95_state', JSON.stringify({
      queue: (queue || []).slice(0, 100).map(function (t) {
        return { id: t.id, urn: t.urn, title: t.title, artist: t.artist, duration: t.duration || 0, artwork: t.artwork || '' };
      }),
      currentIndex: currentIndex,
      volume: audio ? audio.volume : 1
    }));
  } catch (e) { /* storage unavailable */ }
}

audio.addEventListener('volumechange', function () { saveState(); });
audio.addEventListener('timeupdate', function () { /* progress is view-only */ });

/* ---------- Init ---------- */

setStatusRight('SoundScape v0.1');

/* Restore persisted volume + queue on boot. */
try {
  var saved = JSON.parse(localStorage.getItem('sc_win95_state') || 'null');
  if (saved && Array.isArray(saved.queue)) queue = saved.queue;
  if (saved) currentIndex = typeof saved.currentIndex === 'number' ? saved.currentIndex : -1;
  if (saved && typeof saved.volume === 'number') audio.volume = saved.volume;
} catch (e) { /* ignore */ }

/* Auto-load a starting query so the app has something to show. */
searchInput.value = 'chill';
doSearch();

/* ================= TODO / BACKLOG =================
   [ ] Scrobble sync — POST to https://ws.audioscrobbler.com/2.0/ + ListenBrainz /1
   [ ] Likes sync — /me/likes/tracks, /me/likes/playlists, library endpoints
   [ ] Offline / bulk cache — cache by `soundcloud:tracks:<id>` URN, audio_liked dirs
   [ ] Group listening / calls — call-1/call-2.scnative.dev WebRTC SFU + NATS relay
   [ ] Discord Rich Presence — /call + discord IPC
   [ ] Premium tier streaming — api-star/stream-star/storage-star bases
   [ ] Lyrics fetch — api.music.yandex.net / lyrics endpoints
   [ ] Local library import — ym import endpoints
   [ ] Upload flow — /tracks/upload
   ================================================= */
