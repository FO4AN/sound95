// Karaoke. Finds lyrics for whatever is playing and wipes through them in time with
// the music. Timed lyrics are used when anyone has them; otherwise the words are laid
// out over the track as a guess, and Tap to Sync lets you time them properly.

import { tr } from './i18n.js';
import { api } from './api.js';
import { clear, el, errorText, fmtTime } from './dom.js';
import { dialog } from './dialogs.js';
import { durationMs, livePositionMs, onPlayerChange, player, seekToMs } from './player.js';
import { attachVisual, outputDelayMs } from './visualizer.js';
import { floatWindow } from './windows.js';

const STORE_KEY = 'sound95.karaoke';
const SIZE_KEY = 'sound95.karaoke.size';
const NUDGE_MS = 250;
const SIZES = { Small: 22, Medium: 33, Large: 44 };
const REST_MS = 4000; // a gap this long gets a break screen
const COUNT_IN_MS = 3000;
const LINE_TAIL_MS = 300;
const RETRY_MS = 3000; // lyrics sites often fail once and then answer
const INTRO_SHARE = 0.06; // guessed timing: where the singing starts and how long it runs
const SINGING_SHARE = 0.9;

/* ---------- Finding lyrics ---------- */

const searches = new Map();

const requestFor = (track) => ({
  title: track.title,
  artist: track.artist,
  durationMs: track.fullDuration || track.duration || 0,
  // Find Lyrics replaces the title with what you type, which seldom says "(sped up)".
  speedTitle: track.title,
});

/** Results for a track, best first. Kept for the session, except failures. */
export function lyricsFor(track) {
  if (!searches.has(track.urn)) {
    const search = api.lyrics(requestFor(track));
    searches.set(track.urn, search);
    search.catch(() => searches.delete(track.urn));
  }
  return searches.get(track.urn);
}

function savedAll() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { return {}; }
}
const saved = (urn) => savedAll()[urn] || {};
function save(urn, changes) {
  const all = savedAll();
  all[urn] = { ...all[urn], ...changes };
  try { localStorage.setItem(STORE_KEY, JSON.stringify(all)); } catch { /* optional */ }
}

/* ---------- Timing ---------- */

function spreadWords(text, start, end) {
  const pieces = text.match(/\S+\s*/g) || [];
  const total = pieces.reduce((sum, p) => sum + p.trim().length, 0) || 1;
  let at = start;
  return pieces.map((piece) => {
    const dur = ((end - start) * piece.trim().length) / total;
    const word = { ms: at, dur, text: piece };
    at += dur;
    return word;
  });
}

/** Lays untimed lines over the track, longer lines getting more time. */
function guessTimes(lines, total) {
  const weight = (l) => (l.text ? Math.max(8, l.text.length) : 6);
  const sum = lines.reduce((s, l) => s + weight(l), 0) || 1;
  let at = total * INTRO_SHARE;
  return lines.map((line) => {
    const ms = at;
    at += (total * SINGING_SHARE * weight(line)) / sum;
    return { ...line, ms, dur: 0 };
  });
}

/** Turns lyrics into cues: spoken lines with word timing and an end time. */
function toCues(lyrics, total) {
  const lines = lyrics.synced ? lyrics.lines : guessTimes(lyrics.lines, total);
  const cues = [];
  lines.forEach((line, i) => {
    if (!line.text) return;
    const next = lines[i + 1]?.ms ?? line.ms + 5000;
    const gap = Math.max(300, next - line.ms);
    const wordCount = line.text.split(/\s+/).length;
    // Singers finish before the next line starts, so don't drag the wipe out to it.
    const end = line.ms + (line.dur || Math.min(gap * 0.92, 600 + 420 * wordCount));
    cues.push({
      ms: line.ms,
      end,
      text: line.text,
      words: line.words?.length ? line.words : spreadWords(line.text, line.ms, end),
    });
  });
  return cues;
}

function lastCueBefore(cues, t) {
  let low = 0;
  let high = cues.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (cues[middle].ms <= t) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  return found;
}

/** `[mm:ss.xx]` lines if the pasted text has them, plain lines if not. */
function parsePasted(text) {
  const stamped = /^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/;
  const rows = text.split('\n').map((l) => l.trim());
  const timed = rows.map((l) => stamped.exec(l)).filter(Boolean);
  if (timed.length >= 3) {
    return {
      synced: true,
      lines: timed.map(([, m, s, t]) => ({ ms: Number(m) * 60000 + Number(s) * 1000, dur: 0, text: t, words: [] })),
    };
  }
  return { synced: false, lines: rows.map((t) => ({ ms: 0, dur: 0, text: t, words: [] })) };
}

/* ---------- The window ---------- */

const state = {
  win: null,
  track: null,
  results: [],
  lyrics: null,
  cues: [],
  offset: 0,
  shownDelay: 0,
  rowsKey: '',
  activeWords: [],
  tap: null,
  raf: 0,
  token: 0,
};

const toggleListeners = new Set();
export const onKaraokeToggle = (fn) => toggleListeners.add(fn);
export const karaokeOpen = () => !!state.win;

const sizeNow = () => {
  try { return SIZES[localStorage.getItem(SIZE_KEY)] ? localStorage.getItem(SIZE_KEY) : 'Medium'; } catch { return 'Medium'; }
};

const stage = el('div', { class: 'k-stage' });
const linesBox = el('div', { class: 'k-lines' });
const strip = el('canvas', { class: 'k-strip' });

function describe() {
  const { win, lyrics, offset } = state;
  if (!win) return;
  if (!lyrics) { win.setStatus(''); return; }
  const timing = lyrics.custom ? tr('your timing') : lyrics.byWord ? tr('timed word by word') : lyrics.synced ? tr('timed by line') : tr('estimated timing, try Tap to Sync');
  const parts = [tr(lyrics.source), timing];
  if (lyrics.speedAdjusted) parts.push(tr('adjusted to this speed'));
  else if (lyrics.synced && Math.abs(lyrics.offBy) > 4) parts.push(tr(lyrics.offBy > 0 ? 'from a version {seconds}s longer' : 'from a version {seconds}s shorter', { seconds: Math.abs(lyrics.offBy) }));
  if (offset) parts.push(`${offset > 0 ? '+' : ''}${(offset / 1000).toFixed(2)}s`);
  if (outputDelayMs() >= 30) parts.push(tr('{ms} ms speaker delay fixed', { ms: outputDelayMs() }));
  win.setStatus(parts.join(' - '));
}

function showNotice(text, ...buttons) {
  state.rowsKey = '';
  state.cues = [];
  state.lyrics = null;
  clear(linesBox, el('div', { class: 'k-notice' }, el('div', {}, text), buttons.length ? el('div', { class: 'k-buttons' }, buttons) : null));
  describe();
}

function use(lyrics) {
  state.lyrics = lyrics;
  state.cues = toCues(lyrics, state.track?.fullDuration || durationMs());
  state.rowsKey = '';
  describe();
}

const findButton = () => el('button', { onClick: findDialog }, tr('Find Lyrics...'));
const pasteButton = () => el('button', { onClick: pasteDialog }, tr('Paste Lyrics...'));

async function load(track, retried = false) {
  const token = ++state.token;
  state.track = track;
  state.results = [];
  state.lyrics = null;
  state.cues = [];
  state.tap = null;
  if (!track) { showNotice(tr('Play a track to sing along.')); return; }
  const remembered = saved(track.urn);
  state.offset = remembered.offset || 0;
  if (remembered.custom) {
    use(remembered.custom);
    return;
  }
  clear(linesBox, el('div', { class: 'k-notice' }, el('div', {}, tr('Searching for lyrics...')), el('div', { class: 'marquee sunken' })));
  try {
    const results = await lyricsFor(track);
    if (token !== state.token) return;
    state.results = results;
    if (results.length) use(results[0]);
    else showNotice(tr('No lyrics found for this track.'), findButton(), pasteButton());
  } catch (e) {
    if (token !== state.token) return;
    if (!retried) {
      setTimeout(() => { if (token === state.token) load(track, true); }, RETRY_MS);
      return;
    }
    showNotice(errorText(e), el('button', { onClick: () => load(track) }, tr('Retry')), pasteButton());
  }
}

function setRows(rows) {
  state.activeWords = [];
  clear(linesBox, rows.map(({ cue, role }) => {
    if (cue.marker) return el('div', { class: `k-line ${role} k-marker` }, cue.marker);
    const spans = cue.words.map((word) => {
      const span = el('span', { class: 'k-word' }, word.text);
      if (role === 'current') state.activeWords.push({ span, word, fill: 0 });
      return span;
    });
    return el('div', { class: `k-line ${role}`, title: fmtTime(cue.ms), onClick: () => seekToMs(cue.ms + state.offset) }, spans);
  }));
}

function paintWords(t) {
  for (const entry of state.activeWords) {
    const { word } = entry;
    const share = word.dur > 0 ? (t - word.ms) / word.dur : Number(t >= word.ms);
    const fill = Math.min(100, Math.max(0, share * 100));
    if (fill !== entry.fill) {
      entry.fill = fill;
      entry.span.style.setProperty('--fill', `${fill}%`);
    }
  }
}

function renderCues(t) {
  const { cues } = state;
  if (!cues.length) return;
  const index = lastCueBefore(cues, t);
  const cue = cues[index];
  const upcoming = cues[index + 1];
  const quietUntilNext = upcoming && upcoming.ms - (cue?.end ?? 0) > REST_MS;
  const resting = index < 0 || (t > cue.end + LINE_TAIL_MS && quietUntilNext);
  const left = upcoming ? upcoming.ms - t : 0;
  const count = resting && left <= COUNT_IN_MS ? Math.ceil(left / 1000) : 0;
  const key = `${index}:${resting}:${count}`;
  if (key !== state.rowsKey) {
    state.rowsKey = key;
    const later = cues.slice(index + 1, index + 3);
    if (resting) {
      const marker = count ? '● '.repeat(count).trim() : '♪ ♪ ♪';
      setRows([
        cue ? { cue, role: 'past' } : null,
        { cue: { marker }, role: 'current' },
        ...later.map((c) => ({ cue: c, role: 'next' })),
      ].filter(Boolean));
    } else {
      setRows([
        cues[index - 1] ? { cue: cues[index - 1], role: 'past' } : null,
        { cue, role: 'current' },
        ...later.map((c) => ({ cue: c, role: 'next' })),
      ].filter(Boolean));
    }
  }
  if (!resting) paintWords(t);
}

/** Where the song is at your ears, which is what the words have to match. */
const heardMs = () => livePositionMs() - outputDelayMs();

function loop() {
  if (!state.win) return;
  if (state.shownDelay !== outputDelayMs()) {
    state.shownDelay = outputDelayMs();
    describe();
  }
  if (!state.tap) renderCues(heardMs() - state.offset);
  state.raf = requestAnimationFrame(loop);
}

/* ---------- Timing controls ---------- */

function nudge(delta) {
  state.offset = delta ? state.offset + delta : 0;
  if (state.track) save(state.track.urn, { offset: state.offset });
  describe();
}

function stopTapping() {
  state.tap = null;
  state.rowsKey = '';
  clear(linesBox);
}

function showTapLine() {
  const { lines, index } = state.tap;
  clear(linesBox,
    el('div', { class: 'k-line past' }, lines[index - 1]?.text || ''),
    el('div', { class: 'k-line current k-tap' }, lines[index]?.text),
    el('div', { class: 'k-line next' }, lines[index + 1]?.text || ''),
    el('div', { class: 'k-notice' },
      el('div', {}, tr('Press Space as each line starts. {done} of {total}', { done: index + 1, total: lines.length })),
      el('div', { class: 'k-buttons' },
        el('button', { onClick: tap }, tr('Tap')),
        el('button', { onClick: stopTapping }, tr('Cancel')))));
}

function tap() {
  const session = state.tap;
  if (!session) return;
  session.lines[session.index].ms = Math.round(heardMs());
  session.index += 1;
  if (session.index < session.lines.length) { showTapLine(); return; }
  const custom = { source: 'You', custom: true, synced: true, byWord: false, offBy: 0, lines: session.lines.map((l) => ({ ...l, dur: 0, words: [] })) };
  save(state.track.urn, { custom, offset: 0 });
  state.offset = 0;
  stopTapping();
  use(custom);
}

function startTapping() {
  const lines = state.lyrics?.lines.filter((l) => l.text).map((l) => ({ ...l }));
  if (!lines?.length) return;
  state.tap = { lines, index: 0 };
  seekToMs(0);
  showTapLine();
}

function onKey(e) {
  if (['INPUT', 'TEXTAREA'].includes(e.target.tagName) || document.querySelector('.scrim')) return;
  if (state.tap) {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); tap(); }
    if (e.key === 'Escape') { e.stopPropagation(); stopTapping(); }
    return;
  }
  if (e.key === '[') nudge(-NUDGE_MS);
  if (e.key === ']') nudge(NUDGE_MS);
}

/* ---------- Dialogs ---------- */

function kindOf(lyrics) {
  if (lyrics.byWord) return tr('Word timed');
  return lyrics.synced ? tr('Line timed') : tr('Text only');
}

function resultRow(lyrics, close) {
  const off = lyrics.synced && lyrics.offBy ? ` (${lyrics.offBy > 0 ? '+' : ''}${lyrics.offBy}s)` : '';
  return el('div', { class: 'menu-item pick', onClick: () => close(lyrics) },
    el('span', { class: 'pick-name', title: `${lyrics.artist} - ${lyrics.title}` }, `${lyrics.artist} - ${lyrics.title}`),
    el('span', {}, `${kindOf(lyrics)}${off}`),
    el('span', {}, tr(lyrics.source)));
}

async function findDialog() {
  const track = state.track;
  if (!track) return;
  const chosen = await dialog(tr('Find Lyrics'), (close) => {
    const artist = el('input', { type: 'text', value: track.artist, spellcheck: false });
    const title = el('input', { type: 'text', value: track.title, spellcheck: false });
    const list = el('div', { class: 'pick-list sunken' });
    const search = async (request) => {
      clear(list, el('div', { class: 'note', style: 'padding:4px' }, tr('Searching...')));
      try {
        const results = await api.lyrics(request);
        clear(list, results.length ? results.map((r) => resultRow(r, close)) : el('div', { class: 'note', style: 'padding:4px' }, tr('Nothing found. Try a shorter title.')));
      } catch (e) {
        clear(list, el('div', { class: 'note', style: 'padding:4px' }, errorText(e)));
      }
    };
    const button = el('button', {
      class: 'default',
      onClick: () => search({ ...requestFor(track), artist: artist.value, title: title.value, exact: true, everything: true }),
    }, tr('Search'));
    search({ ...requestFor(track), everything: true });
    return {
      body: el('div', { style: 'display:grid;gap:6px' },
        el('div', { class: 'field' }, el('label', {}, tr('Artist:')), artist),
        el('div', { class: 'field' }, el('label', {}, tr('Title:')), title),
        list),
      buttons: [button, el('button', { onClick: () => close() }, tr('Cancel'))],
    };
  }, { width: 480 });
  if (chosen) {
    save(track.urn, { custom: null });
    use(chosen);
  }
}

async function pasteDialog() {
  const track = state.track;
  if (!track) return;
  const text = await dialog(tr('Paste Lyrics'), (close) => {
    const box = el('textarea', { class: 'paste', spellcheck: false, placeholder: tr('One line per line. [mm:ss.xx] stamps are kept.') });
    return {
      body: box,
      buttons: [
        el('button', { class: 'default', onClick: () => close(box.value) }, 'OK'),
        el('button', { onClick: () => close() }, tr('Cancel')),
      ],
    };
  }, { width: 420 });
  if (!text?.trim()) return;
  const custom = { source: 'You', custom: true, byWord: false, offBy: 0, ...parsePasted(text) };
  save(track.urn, { custom });
  use(custom);
}

const lyricsMenu = () => [
  { label: tr('Find Lyrics...'), disabled: !state.track, action: findDialog },
  { label: tr('Paste Lyrics...'), disabled: !state.track, action: pasteDialog },
  'sep',
  { label: tr('Tap to Sync'), disabled: !state.lyrics || !player.current, action: startTapping },
  {
    label: tr('Forget My Lyrics'),
    disabled: !state.track || !saved(state.track.urn).custom,
    action: () => { save(state.track.urn, { custom: null }); load(state.track); },
  },
];

const timingMenu = () => [
  { label: tr('Words Earlier'), accel: '[', action: () => nudge(-NUDGE_MS) },
  { label: tr('Words Later'), accel: ']', action: () => nudge(NUDGE_MS) },
  { label: tr('Reset'), disabled: !state.offset, action: () => nudge(0) },
];

function applySize(name) {
  stage.style.setProperty('--k-size', `${SIZES[name]}px`);
  try { localStorage.setItem(SIZE_KEY, name); } catch { /* optional */ }
}

const viewMenu = () => [
  ...Object.keys(SIZES).map((name) => ({ label: tr(`${name} Text`), checked: sizeNow() === name, action: () => applySize(name) })),
  'sep',
  { label: tr('Full Window'), checked: state.win?.maximized, action: () => state.win.toggleMaximize() },
];

/* ---------- Opening and closing ---------- */

export function toggleKaraoke() {
  if (state.win) { state.win.close(); return; }
  let bars = null;
  state.win = floatWindow({
    id: 'karaoke',
    title: tr('Karaoke'),
    iconName: 'mic',
    width: 620,
    height: 400,
    minWidth: 340,
    minHeight: 240,
    menus: { Lyrics: lyricsMenu, Timing: timingMenu, View: viewMenu },
    onClose: () => {
      cancelAnimationFrame(state.raf);
      document.removeEventListener('keydown', onKey, true);
      bars?.detach();
      state.win = null;
      state.tap = null;
      state.token += 1;
      toggleListeners.forEach((fn) => fn());
    },
  });
  clear(stage, linesBox, strip);
  applySize(sizeNow());
  state.win.setBody(stage);
  bars = attachVisual(strip, { pixel: 2 });
  document.addEventListener('keydown', onKey, true);
  load(player.current);
  loop();
  toggleListeners.forEach((fn) => fn());
}

/** Opens karaoke if it's closed. The window then follows whatever plays. */
export function showKaraoke() {
  if (!state.win) toggleKaraoke();
}

onPlayerChange(() => {
  if (state.win && player.current?.urn !== state.track?.urn) load(player.current);
});
