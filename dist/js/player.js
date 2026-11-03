// Queue and playback. Audio comes from SoundCloud's official Widget player,
// which each listener streams from directly; the player bar drives it.

import { tr } from './i18n.js';
import { setStatus } from './dom.js';

const STORE_KEY = 'sound95.player';
const MAX_SKIPS = 3;
const START_TIMEOUT_MS = 15000;
const PROGRESS_EVERY_MS = 200; // the Widget reports far more often than the bar can show
const WIDGET_API = 'https://w.soundcloud.com/player/api.js';
const slot = () => document.getElementById('widget-slot');

export const player = {
  queue: [],
  index: -1,
  shuffle: false,
  repeat: 'off', // off | all | one
  loading: false,
  playing: false,
  get current() { return this.queue[this.index] || null; },
};

const listeners = new Set();
const progressListeners = new Set();
export function onPlayerChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function onProgress(fn) { progressListeners.add(fn); return () => progressListeners.delete(fn); }
const notify = () => listeners.forEach((fn) => fn());
function emit() {
  notify();
  persist();
}

let volume = 0.8;
let widget = null;
let frame = null;
let position = 0;
let positionAt = 0;
let progressAt = 0;
let duration = 0;
let generation = 0;
let skips = 0;
let startTimer = null;

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      queue: player.queue.slice(0, 500),
      index: player.index,
      shuffle: player.shuffle,
      repeat: player.repeat,
      volume,
    }));
  } catch { /* storage full or blocked: settings just won't persist */ }
}

export function restorePlayer() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved) {
      player.queue = Array.isArray(saved.queue) ? saved.queue.filter((t) => t?.urn) : [];
      player.index = Math.min(Number.isInteger(saved.index) ? saved.index : -1, player.queue.length - 1);
      player.shuffle = !!saved.shuffle;
      player.repeat = ['off', 'all', 'one'].includes(saved.repeat) ? saved.repeat : 'off';
      if (typeof saved.volume === 'number') volume = saved.volume;
    }
  } catch { /* corrupt settings: keep the defaults */ }
  emit();
}

const trackUrl = (track) => `https://api.soundcloud.com/tracks/${track.urn.split(':').pop()}`;

const WIDGET_OPTIONS = {
  auto_play: false,
  color: '#000080',
  buying: false,
  sharing: false,
  download: false,
  show_comments: false,
  show_reposts: false,
  show_teaser: false,
  show_artwork: true,
  show_user: true,
  show_playcount: false,
  visual: false,
};

function setPosition(ms) {
  position = ms;
  positionAt = performance.now();
}

function started(mine) {
  if (mine !== generation) return;
  clearTimeout(startTimer);
  player.loading = false;
  skips = 0;
  const track = player.current;
  setStatus(tr('Now playing: {track}', { track: `${track.artist} - ${track.title}` }));
  widget.getDuration((ms) => { if (mine === generation && ms) duration = ms; });
  emit();
}

/** A Widget that stopped answering stays that way, so the next track gets a new one. */
function dropWidget() {
  widget = null;
  frame = null;
  slot().replaceChildren();
}

function failed(track) {
  clearTimeout(startTimer);
  player.loading = false;
  player.playing = false;
  if (skips < MAX_SKIPS && player.index < player.queue.length - 1) {
    skips += 1;
    setStatus(tr('Could not play "{title}". Skipping.', { title: track.title }));
    next();
    return;
  }
  setStatus(tr('Could not play "{title}".', { title: track.title }), { sticky: true });
  emit();
}

/** The page's own copy never arrives if Sound95 starts without a connection. */
function fetchWidgetApi() {
  return new Promise((done, fail) => {
    const script = document.createElement('script');
    script.src = WIDGET_API;
    script.onload = done;
    script.onerror = fail;
    document.head.append(script);
  });
}

function createWidget(track) {
  if (!window.SC?.Widget) {
    const mine = generation;
    const give = () => { if (mine === generation) failed(track); };
    fetchWidgetApi().then(() => {
      if (window.SC?.Widget && mine === generation) createWidget(track);
      else give();
    }, give);
    return;
  }
  const params = new URLSearchParams({ url: trackUrl(track), ...WIDGET_OPTIONS });
  frame = document.createElement('iframe');
  frame.title = 'SoundCloud player';
  frame.allow = 'autoplay';
  frame.src = `https://w.soundcloud.com/player/?${params}`;
  slot().replaceChildren(frame);
  const own = window.SC.Widget(frame);
  widget = own;
  const { Events } = window.SC.Widget;
  // A dropped Widget can still have events on their way.
  const bind = (event, fn) => own.bind(event, (e) => { if (own === widget) fn(e); });
  bind(Events.READY, () => {
    own.setVolume(Math.round(volume * 100));
    own.play();
  });
  bind(Events.PLAY, () => {
    player.playing = true;
    setPosition(position);
    if (player.loading) started(generation);
    else notify();
  });
  bind(Events.PAUSE, () => {
    setPosition(livePositionMs());
    player.playing = false;
    notify();
  });
  bind(Events.PLAY_PROGRESS, (e) => {
    setPosition(e.currentPosition);
    if (positionAt - progressAt < PROGRESS_EVERY_MS) return;
    progressAt = positionAt;
    progressListeners.forEach((fn) => fn());
  });
  bind(Events.FINISH, () => {
    player.playing = false;
    next({ auto: true });
  });
  bind(Events.ERROR, () => { if (player.current) failed(player.current); });
}

function load(track) {
  const mine = ++generation;
  player.loading = true;
  player.playing = false;
  setPosition(0);
  duration = track.duration || 0;
  emit();
  setStatus(tr('Opening "{title}"...', { title: track.title }), { sticky: true });
  clearTimeout(startTimer);
  startTimer = setTimeout(() => {
    if (mine !== generation || !player.loading) return;
    dropWidget();
    failed(track);
  }, START_TIMEOUT_MS);
  if (!widget) {
    createWidget(track);
    return;
  }
  const own = widget;
  own.load(trackUrl(track), {
    ...WIDGET_OPTIONS,
    callback: () => {
      if (mine !== generation || own !== widget) return;
      own.setVolume(Math.round(volume * 100));
      own.play();
    },
  });
}

export function playList(tracks, index) {
  player.queue = tracks.filter((t) => t.access !== 'blocked');
  const wanted = tracks[index];
  player.index = Math.max(0, player.queue.findIndex((t) => t.urn === wanted?.urn));
  if (player.shuffle) shuffleRest();
  skips = 0;
  load(player.current);
}

function shuffleRest() {
  const q = player.queue;
  const current = q[player.index];
  const rest = q.filter((_, i) => i !== player.index);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  player.queue = current ? [current, ...rest] : rest;
  player.index = current ? 0 : -1;
}

export function enqueue(track, { nextUp = false } = {}) {
  if (track.access === 'blocked') return;
  if (player.index < 0) {
    player.queue = [track];
    player.index = 0;
    load(track);
    return;
  }
  player.queue.splice(nextUp ? player.index + 1 : player.queue.length, 0, track);
  setStatus(tr('Added "{title}" to Up Next', { title: track.title }));
  emit();
}

export function jumpTo(index) {
  if (index < 0 || index >= player.queue.length) return;
  player.index = index;
  skips = 0;
  load(player.current);
}

export function clearUpcoming() {
  player.queue = player.current ? [player.current] : [];
  player.index = player.current ? 0 : -1;
  emit();
}

export function togglePlay() {
  const track = player.current;
  if (!track) return;
  if (!widget) load(track);
  else widget.toggle();
}

export function next({ auto = false } = {}) {
  if (!player.queue.length) return;
  if (auto && player.repeat === 'one') {
    widget.seekTo(0);
    widget.play();
    return;
  }
  if (player.index < player.queue.length - 1) {
    player.index += 1;
  } else if (player.repeat === 'off' && auto) {
    setStatus(tr('End of queue'));
    emit();
    return;
  } else {
    player.index = 0;
  }
  load(player.current);
}

export function prev() {
  if (position > 3000 || player.index <= 0) {
    widget?.seekTo(0);
    return;
  }
  player.index -= 1;
  load(player.current);
}

export function toggleShuffle() {
  player.shuffle = !player.shuffle;
  if (player.shuffle && player.queue.length > 1) shuffleRest();
  emit();
}

export function cycleRepeat() {
  player.repeat = { off: 'all', all: 'one', one: 'off' }[player.repeat];
  emit();
}

export function seekTo(ratio) {
  if (!widget || !duration) return;
  setPosition(duration * ratio);
  widget.seekTo(position);
  notify();
}

export function seekToMs(ms) {
  if (!widget) return;
  setPosition(Math.max(0, ms));
  widget.seekTo(position);
  notify();
}

export const durationMs = () => duration || player.current?.duration || 0;
export const positionMs = () => position;

/** The Widget reports a few times a second, which is too coarse for karaoke. */
export function livePositionMs() {
  if (!player.playing) return position;
  const moved = position + performance.now() - positionAt;
  return durationMs() ? Math.min(moved, durationMs()) : moved;
}

export function setVolume(v) {
  volume = Math.min(1, Math.max(0, v));
  widget?.setVolume(Math.round(volume * 100));
  persist();
}
export const getVolume = () => volume;
