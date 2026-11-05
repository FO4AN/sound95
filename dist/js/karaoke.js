// Karaoke. Finds lyrics for whatever is playing and wipes through them in time with
// the music. Timed lyrics are used when anyone has them; otherwise the words are laid
// out over the track as a guess, and Tap to Sync lets you time them properly.

import { tr } from './i18n.js';
import { api } from './api.js';
import { clear, el, errorText, fmtTime } from './dom.js';
import { dialog } from './dialogs.js';
import { durationMs, livePositionMs, onPlayerChange, player, seekToMs, steadyPositionMs } from './player.js';
import { attachVisual, outputDelayMs } from './visualizer.js';
import { floatWindow } from './windows.js';

const STORE_KEY = 'sound95.karaoke';
const SIZE_KEY = 'sound95.karaoke.size';
const NUDGE_MS = 250;
const SIZES = { Small: 22, Medium: 33, Large: 44 };
const REST_MS = 4000; // a gap this long gets a break screen
const COUNT_IN_MS = 3000;
const LINE_TAIL_MS = 300;
const LAST_WORD_MS = 400; // a last word with no end of its own fills at least this long
const RETRY_MS = 3000; // lyrics sites often fail once and then answer
const SEARCH_TIMEOUT_MS = 60000; // past every site's own limit, so only a lost answer waits this long
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
    // An answer that never comes would otherwise keep "Searching..." up all session.
    const lost = new Promise((_, fail) => setTimeout(() => fail({ code: 'network', message: 'A lyrics site did not answer. Try again in a moment.' }), SEARCH_TIMEOUT_MS));
    const search = Promise.race([api.lyrics(requestFor(track)), lost]);
    searches.set(track.urn, search);
    search.catch(() => searches.delete(track.urn));
  }
  return searches.get(track.urn);
}

/** What karaoke shows for a track: lyrics you chose, pasted or tapped, or else the best found. */
export function chosenLyricsFor(track) {
  const mine = saved(track.urn).custom;
  return mine ? Promise.resolve(mine) : lyricsFor(track).then(([best]) => best || null);
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

// Han, kana and hangul run without spaces, about a syllable a character.
const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
const CJK_CHARS = new RegExp(`[${CJK}]`, 'gu');
const PIECES = new RegExp(`[${CJK}]\\s*|[^\\s${CJK}]+\\s*`, 'gu');
const CJK_WEIGHT = 2; // letters' worth of singing in one character

/** Rough singing time for a line that has no end time of its own. */
function singMs(text) {
  const syllables = (text.match(CJK_CHARS) || []).length;
  const words = text.replace(CJK_CHARS, ' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return 600 + 420 * words + 300 * syllables;
}

/** Shares a line's time out over its words, or its characters where they run together. */
function spreadWords(text, start, end) {
  const pieces = text.match(PIECES) || [];
  const weight = (piece) => {
    const core = piece.trim();
    return core.match(CJK_CHARS) ? CJK_WEIGHT : core.length;
  };
  const total = pieces.reduce((sum, p) => sum + weight(p), 0) || 1;
  let at = start;
  return pieces.map((piece) => {
    const dur = ((end - start) * weight(piece)) / total;
    const word = { ms: at, dur, text: piece };
    at += dur;
    return word;
  });
}

/**
 * Gives each word an end, and splits off its spaces: they stay outside the wipe, so the
 * letters fill over exactly the word's time. A word with no length runs to the next one,
 * or to the end of the line.
 */
function timeWords(words, end) {
  return words.map((word, k) => {
    const following = words[k + 1]?.ms;
    const stop = word.dur > 0 ? word.ms + word.dur
      : following > word.ms ? following
        : Math.max(end, word.ms + LAST_WORD_MS);
    const [, lead, core, tail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(word.text);
    return { ms: word.ms, end: stop, lead, core, tail };
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
  // Pasted and tapped lines can be out of order, and finding the line needs them sorted.
  const lines = lyrics.synced ? [...lyrics.lines].sort((a, b) => a.ms - b.ms) : guessTimes(lyrics.lines, total);
  const cues = [];
  lines.forEach((line, i) => {
    if (!line.text) return;
    const after = lines[i + 1];
    const next = after?.ms ?? line.ms + 5000;
    const gap = Math.max(300, next - line.ms);
    // A blank line marks where the singing stops. Otherwise singers finish before the
    // next line starts, so don't drag the wipe out to it.
    const guess = after && !after.text ? gap : Math.min(gap * 0.92, singMs(line.text));
    let end = line.ms + (line.dur || guess);
    const words = timeWords(line.words?.length ? line.words : spreadWords(line.text, line.ms, end), end);
    end = Math.max(end, words[words.length - 1]?.end ?? end);
    cues.push({ ms: line.ms, end, text: line.text, words });
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

const STAMP = /^\[(\d+):(\d+(?:[.:]\d+)?)\]/;
const WORD_STAMP = /<(\d+):(\d+(?:[.:]\d+)?)>/;
const stampMs = (minutes, seconds) => Math.round(Number(minutes) * 60000 + Number(seconds.replace(':', '.')) * 1000);

/** `<mm:ss.xx>word <mm:ss.xx>word`, or null if the text has no word stamps. */
function wordStamps(text, start) {
  if (!WORD_STAMP.test(text)) return null;
  const parts = text.split(new RegExp(WORD_STAMP.source));
  const words = parts[0] ? [{ ms: start, dur: 0, text: parts[0] }] : [];
  for (let k = 1; k < parts.length; k += 3) words.push({ ms: stampMs(parts[k], parts[k + 1]), dur: 0, text: parts[k + 2] });
  return words;
}

/** Drops leading blank lines and runs of them, as the lyrics sites' lines come. */
function tidyLines(lines) {
  return lines.filter((line, i) => line.text || (i > 0 && lines[i - 1].text));
}

/**
 * Pasted lyrics, read the way lyrics.rs reads LRC from the sites: several stamps on a
 * repeated line, mm:ss:xx stamps, [offset:], word stamps, and tags that aren't lines.
 * Plain lines if the text isn't timed.
 */
function parsePasted(text) {
  const rows = text.split('\n').map((l) => l.trim());
  const offset = Number(/^\[offset:\s*\+?(-?\d+)\s*\]$/i.exec(rows.find((r) => /^\[offset:/i.test(r)) || '')?.[1] || 0);
  const shift = (ms) => Math.max(0, ms - offset);
  const timed = [];
  for (const row of rows) {
    let rest = row;
    const stamps = [];
    for (let m = STAMP.exec(rest); m; m = STAMP.exec(rest)) {
      stamps.push(stampMs(m[1], m[2]));
      rest = rest.slice(m[0].length);
    }
    rest = rest.trim();
    // Word stamps are written for the line's first time; a repeat moves them along.
    const first = Math.min(...stamps);
    const words = wordStamps(rest, first);
    const line = words ? words.map((w) => w.text).join('').trim() : rest;
    for (const ms of stamps) {
      const moved = (words || []).map((w) => ({ ...w, ms: shift(w.ms + ms - first) }));
      timed.push({ ms: shift(ms), dur: 0, text: line, words: moved });
    }
  }
  timed.sort((a, b) => a.ms - b.ms);
  if (timed.filter((l) => l.text).length >= 3 && timed.some((l) => l.ms > 0)) {
    return { synced: true, byWord: timed.some((l) => l.words.length), lines: tidyLines(timed) };
  }
  // "[Chorus]" and the like aren't sung.
  const plain = tidyLines(rows.filter((r) => !/^\[.*\]$/.test(r)).map((t) => ({ ms: 0, dur: 0, text: t, words: [] })));
  while (plain.length && !plain[plain.length - 1].text) plain.pop();
  return { synced: false, lines: plain };
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
  rowsKey: -1,
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
  // The player's clock already counts the delay; the strip's bars wait for it.
  if (outputDelayMs() >= 30) parts.push(tr('{ms} ms speaker delay fixed', { ms: outputDelayMs() }));
  win.setStatus(parts.join(' - '));
}

function showNotice(text, ...buttons) {
  state.rowsKey = -1;
  state.cues = [];
  state.lyrics = null;
  clear(linesBox, el('div', { class: 'k-notice' }, el('div', {}, text), buttons.length ? el('div', { class: 'k-buttons' }, buttons) : null));
  describe();
}

function use(lyrics) {
  state.lyrics = lyrics;
  state.cues = toCues(lyrics, state.track?.fullDuration || durationMs());
  state.rowsKey = -1;
  describe();
}

/** Looks up the next track's lyrics while this one plays, so they're there from its start. */
function prefetchNext() {
  const next = player.queue[player.index + 1];
  if (state.win && next && next.access !== 'blocked') lyricsFor(next).catch(() => { /* it tries again when it plays */ });
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
    prefetchNext();
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
    showNotice(errorText(e), el('button', { onClick: () => load(track) }, tr('Retry')), findButton(), pasteButton());
  }
  prefetchNext();
}

function setRows(rows) {
  state.activeWords = [];
  clear(linesBox, rows.map(({ cue, role }) => {
    if (cue.marker) return el('div', { class: `k-line ${role} k-marker` }, cue.marker);
    const words = cue.words.map((word) => {
      const span = el('span', { class: 'k-word' }, word.core);
      if (role === 'current') state.activeWords.push({ span, word, fill: 0 });
      return [word.lead || null, span, word.tail || null];
    });
    return el('div', { class: `k-line ${role}`, title: fmtTime(cue.ms), onClick: () => seekToMs(cue.ms + state.offset) }, words);
  }));
}

/** One style write per frame at most: only the word being sung changes. */
function paintWords(t) {
  for (const entry of state.activeWords) {
    const { word } = entry;
    const share = (t - word.ms) / (word.end - word.ms);
    const fill = Math.round(Math.min(1, Math.max(0, share)) * 1000) / 10;
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
  const key = (index + 1) * 16 + (resting ? 8 : 0) + count;
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

const frame = { ms: 1000 / 60, last: 0 };

function loop(ts = performance.now()) {
  if (!state.win) return;
  // What's drawn now shows about a frame later, so the words aim for then. The player's
  // position is the sound at your ears already: on Linux WebKit asks the sound server,
  // which counts the speaker's delay, Bluetooth's included, so nothing comes off it here.
  if (frame.last && ts > frame.last) frame.ms += (Math.min(40, Math.max(6, ts - frame.last)) - frame.ms) * 0.1;
  frame.last = ts;
  if (state.shownDelay !== outputDelayMs()) {
    state.shownDelay = outputDelayMs();
    describe();
  }
  if (!state.tap && state.cues.length) renderCues(steadyPositionMs(ts + frame.ms) - state.offset);
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
  state.rowsKey = -1;
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

function tap(e) {
  const session = state.tap;
  // Holding Space down repeats it, which isn't a line starting.
  if (!session || e?.repeat) return;
  // The press is the moment to time, not whenever this got to run.
  const now = performance.now();
  const at = e?.timeStamp > now - 1000 && e.timeStamp <= now ? e.timeStamp : now;
  session.lines[session.index].ms = Math.round(livePositionMs(at));
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
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); tap(e); }
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
    // The search started on opening can answer after one you asked for since.
    let latest = 0;
    const search = async (request) => {
      const mine = ++latest;
      clear(list, el('div', { class: 'note', style: 'padding:4px' }, tr('Searching...')));
      try {
        const results = await api.lyrics(request);
        if (mine !== latest) return;
        clear(list, results.length ? results.map((r) => resultRow(r, close)) : el('div', { class: 'note', style: 'padding:4px' }, tr('Nothing found. Try a shorter title.')));
      } catch (e) {
        if (mine !== latest) return;
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
  if (chosen) keep(track, chosen);
}

/**
 * Remembers lyrics you chose for a track, so they come back next time. An offset set
 * for other lyrics doesn't fit them. The track may have changed while you chose.
 */
function keep(track, lyrics) {
  save(track.urn, { custom: lyrics, offset: 0 });
  if (state.track?.urn !== track.urn) return;
  state.token += 1; // a search still running for this track mustn't replace them
  state.offset = 0;
  use(lyrics);
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
  keep(track, { source: 'You', custom: true, byWord: false, offBy: 0, ...parsePasted(text) });
}

const lyricsMenu = () => [
  { label: tr('Find Lyrics...'), disabled: !state.track, action: findDialog },
  { label: tr('Paste Lyrics...'), disabled: !state.track, action: pasteDialog },
  'sep',
  { label: tr('Tap to Sync'), disabled: !state.lyrics || !player.current, action: startTapping },
  {
    label: tr('Forget My Lyrics'),
    disabled: !state.track || !saved(state.track.urn).custom,
    action: () => { save(state.track.urn, { custom: null, offset: 0 }); load(state.track); },
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
  frame.last = 0;
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
