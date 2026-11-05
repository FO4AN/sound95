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
let listening = true; // false from load() until the reloaded Widget is ready
let pendingSeek = null; // ms to start from once the track plays
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

/* ---------- Where the music is ---------- */

// The Widget reports where the music is several times a second. A report arrives late
// by however long the pages were busy, and that only ever makes it look older, so the
// freshest-looking report of the last two seconds sets the clock. While the Widget
// repeats one position (seeking, buffering, starting up, or on Bluetooth until the
// speaker catches up) the clock holds still rather than running on and snapping back.
const CLOCK_WINDOW_MS = 2000;
const JUMP_MS = 400; // further out than this, the music itself moved
const SEEK_SETTLE_MS = 2000; // how long reports sent before a seek can trail in
const SEEK_SLACK_MS = 250;
const SLEW_MS = 200; // small errors fade out over about this long
const MAX_RUN_ON_MS = 3000; // the longest the clock runs on without reports

const clock = {
  moving: false, // the latest reports advanced with the time between them
  p: 0, // the latest report's position
  at: 0, // and when it arrived
  recent: [], // { lead: position - arrival, at } for reports while moving
  lead: 0, // the largest lead in `recent`
  gap: 100, // the usual time between reports
  gaps: 0, // how many went into it, up to a few
  reportAt: -Infinity, // when the latest report arrived
  seekTarget: null,
  seekAt: 0,
  shown: 0, // the steady reading, which never steps back on its own
  shownAt: 0,
  snap: true, // the next steady reading jumps straight to the clock
  release: false, // the music just started moving, so a frozen reading may jump ahead
};

/**
 * The music is at `ms` and not moving. `snap` is for a jump (a new track, a seek), which
 * readers show at once; `seek` also waits out the reports already on their way.
 */
function holdClock(ms, { snap = false, seek = false } = {}) {
  clock.moving = false;
  clock.release = false;
  clock.p = ms;
  clock.at = performance.now();
  clock.recent = [];
  if (snap) {
    clock.snap = true;
    clock.seekTarget = seek ? ms : null;
    clock.seekAt = clock.at;
  }
}

/** True for a report sent before the latest seek: after it, the music can't be far off. */
function beforeSeek(p, now = performance.now()) {
  if (clock.seekTarget == null) return false;
  const since = now - clock.seekAt;
  const off = p < clock.seekTarget - SEEK_SLACK_MS || p > clock.seekTarget + since + SEEK_SLACK_MS;
  if (off && since < SEEK_SETTLE_MS) return true;
  clock.seekTarget = null;
  return false;
}

/** Takes in a position report. False if it was sent before the latest seek. */
function reportClock(p) {
  const now = performance.now();
  if (beforeSeek(p, now)) return false;
  // Reports keep coming at their pace while the music holds, so every one counts here.
  if (now - clock.reportAt < 2000) {
    clock.gaps = Math.min(clock.gaps + 1, 5);
    clock.gap += (now - clock.reportAt - clock.gap) / clock.gaps;
  }
  clock.reportAt = now;
  const dp = p - clock.p;
  const dt = now - clock.at;
  if (dp < -JUMP_MS || dp > dt + JUMP_MS) {
    // The music jumped: a repeat, or a seek from elsewhere.
    holdClock(p, { snap: true });
    return true;
  }
  if (dp < Math.max(5, 0.25 * dt)) {
    // WebKit repeats the same position while it seeks or waits for sound.
    holdClock(p);
    return true;
  }
  const lead = p - now;
  if (!clock.moving || lead < clock.lead - JUMP_MS) {
    // Moving again, or moving on after a stall the reports didn't show: start afresh.
    clock.release = !clock.moving;
    clock.moving = true;
    clock.recent = [];
  }
  clock.recent.push({ lead, at: now });
  while (clock.recent[0].at < now - CLOCK_WINDOW_MS) clock.recent.shift();
  clock.lead = Math.max(...clock.recent.map((r) => r.lead));
  clock.p = p;
  clock.at = now;
  return true;
}

function clockAt(at) {
  if (!player.playing || !clock.moving) return clock.p;
  // When reports stop coming, so does the clock, a little after the next one was due.
  const until = clock.at + Math.min(MAX_RUN_ON_MS, Math.max(250, 2.5 * clock.gap));
  return clock.lead + Math.min(at, until);
}

/** Where the music is at `at` (a performance.now() time), as well as it is known. */
export function livePositionMs(at = performance.now()) {
  const ms = Math.max(0, clockAt(at));
  return durationMs() ? Math.min(ms, durationMs()) : ms;
}

/**
 * livePositionMs for one reader that draws every frame, like karaoke. It never steps
 * back unless the music jumped, waits when it got ahead, and fades small corrections in
 * by running a little fast or slow, so a word wipe never stutters.
 */
export function steadyPositionMs(at = performance.now()) {
  const target = livePositionMs(at);
  const dt = Math.max(0, at - clock.shownAt);
  const { shown } = clock;
  clock.shownAt = at;
  // Jumps come flagged; being ahead unflagged means the clock ran on through a stall.
  if (clock.snap || target - shown > JUMP_MS || shown - target > MAX_RUN_ON_MS) {
    clock.shown = target;
    clock.snap = false;
    clock.release = false;
  } else if (clock.release && target > shown) {
    clock.shown = target;
    clock.release = false;
  } else if (!player.playing || !clock.moving) {
    clock.shown = Math.max(shown, Math.min(target, shown + dt));
  } else {
    // A frame later than SLEW_MS corrects the whole error, never more.
    const free = shown + dt;
    clock.shown = free + Math.min(0.5 * dt, Math.max(-dt, (target - free) * Math.min(1, dt / SLEW_MS)));
  }
  return clock.shown;
}

/* ---------- The Widget ---------- */

function seekWidget(ms) {
  setPosition(Math.max(0, ms));
  holdClock(position, { snap: true, seek: true });
  widget.seekTo(position);
}

function started(mine) {
  if (mine !== generation) return;
  clearTimeout(startTimer);
  player.loading = false;
  skips = 0;
  const track = player.current;
  if (track) setStatus(tr('Now playing: {track}', { track: `${track.artist} - ${track.title}` }));
  widget.getDuration((ms) => { if (mine === generation && ms) duration = ms; });
  // The Widget only seeks once the sound is playing.
  if (pendingSeek != null) {
    const ms = pendingSeek;
    pendingSeek = null;
    seekWidget(ms);
  }
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

/** The position an event carries, unless it is missing or older than a seek or a start point. */
function eventPosition(e) {
  const p = e?.currentPosition;
  return Number.isFinite(p) && pendingSeek == null && !beforeSeek(p) ? p : null;
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
  listening = true;
  const { Events } = window.SC.Widget;
  // A dropped Widget can still have events on their way, and load() reloads the
  // Widget's page, whose old copy keeps playing and reporting until it is gone.
  const bind = (event, fn) => own.bind(event, (e) => { if (own === widget && listening) fn(e); });
  bind(Events.READY, () => {
    own.setVolume(Math.round(volume * 100));
    own.play();
  });
  bind(Events.PLAY, (e) => {
    const p = eventPosition(e);
    if (p != null) setPosition(p);
    // Sound can lag the event, so the clock waits for reports that move.
    holdClock(p ?? clock.p);
    player.playing = true;
    // A start point still waiting means the track failed to open and is playing after
    // all, so it starts properly now: otherwise every report would wait for that seek.
    if (player.loading || pendingSeek != null) started(generation);
    else notify();
  });
  bind(Events.PAUSE, (e) => {
    const p = eventPosition(e) ?? livePositionMs();
    setPosition(p);
    holdClock(p);
    player.playing = false;
    notify();
  });
  bind(Events.PLAY_PROGRESS, (e) => {
    const p = e?.currentPosition;
    if (!Number.isFinite(p) || pendingSeek != null || !reportClock(p)) return;
    setPosition(p);
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

/** Plays `track`, from `start` ms if given. */
function load(track, start = null) {
  if (!track) return;
  const mine = ++generation;
  player.loading = true;
  player.playing = false;
  pendingSeek = start;
  setPosition(start ?? 0);
  holdClock(position, { snap: true });
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
  listening = false;
  own.load(trackUrl(track), {
    ...WIDGET_OPTIONS,
    callback: () => {
      if (mine !== generation || own !== widget) return;
      listening = true;
      own.setVolume(Math.round(volume * 100));
      own.play();
    },
  });
}

/** Plays `tracks` from `index`, and from `start` ms into that track if given. */
export function playList(tracks, index, start = null) {
  const queue = tracks.filter((t) => t.access !== 'blocked');
  const wanted = tracks[index];
  if (!queue.length) {
    setStatus(tr('Could not play "{title}".', { title: wanted?.title ?? '' }));
    return;
  }
  player.queue = queue;
  player.index = Math.max(0, queue.findIndex((t) => t.urn === wanted?.urn));
  if (player.shuffle) shuffleRest();
  skips = 0;
  load(player.current, player.current.urn === wanted?.urn ? start : null);
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
  if (!widget) load(track, pendingSeek);
  else widget.toggle();
}

export function next({ auto = false } = {}) {
  if (!player.queue.length) return;
  if (auto && player.repeat === 'one' && widget) {
    // Not seekToMs: its notify would show a stop between the end and the restart.
    setPosition(0);
    holdClock(0, { snap: true, seek: true });
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
    seekToMs(0);
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
  if (durationMs()) seekToMs(durationMs() * ratio);
}

export function seekToMs(ms) {
  if (!player.current) return;
  const at = Math.max(0, ms);
  if (widget && !player.loading) {
    seekWidget(at);
  } else {
    // Nothing is playing yet (just restored, or still opening): start from here.
    pendingSeek = at;
    setPosition(at);
    holdClock(at, { snap: true });
  }
  notify();
}

export const durationMs = () => duration || player.current?.duration || 0;
export const positionMs = () => position;

export function setVolume(v) {
  volume = Math.min(1, Math.max(0, v));
  widget?.setVolume(Math.round(volume * 100));
  persist();
}
export const getVolume = () => volume;
