// App shell: wires the window chrome, menus, player bar and session together.

import { onLanguageChange, tr, translatePage } from './i18n.js';
import { applyCloseToTray, applyTheme, settingsDialog } from './settings.js';
import { api } from './api.js';
import { clear, el, errorText, fmtTime, setStatus } from './dom.js';
import { icon, setIcon } from './icons.js';
import { checkForUpdates, watchForUpdates } from './updates.js';
import { aboutDialog, audioAskDialog, audioSetupDialog, closeMenu, logonDialog, message, showMenu } from './dialogs.js';
import { isLiked, loadSession, onSessionChange, session, toggleLike } from './session.js';
import {
  clearUpcoming, cycleRepeat, durationMs, getVolume, jumpTo, next, onPlayerChange, onProgress, player, positionMs,
  prev, restorePlayer, seekTo, setVolume, togglePlay, toggleShuffle,
} from './player.js';
import {
  back, canGoBack, canGoForward, createPlaylist, currentRoute, forward, go, onNavigate, openTrack, refresh, syncRows,
} from './views.js';
import { attachVisual, onVisualizerToggle, toggleVisualizer, visualizerOpen } from './visualizer.js';
import { karaokeOpen, onKaraokeToggle, toggleKaraoke } from './karaoke.js';
import { restoreBackdrop } from './backdrop.js';
import { welcomeIfNew } from './welcome.js';

const $ = (id) => document.getElementById(id);
const appWindow = () => window.__TAURI__.window.getCurrentWindow();

/* ---------- Static chrome ---------- */

setIcon($('title-icon'), 'note');
setIcon($('win-min'), 'min');
setIcon($('win-max'), 'max');
setIcon($('win-close'), 'close');
setIcon($('nav-back'), 'back');
setIcon($('nav-forward'), 'forward');
setIcon($('nav-home'), 'home');
setIcon($('tp-prev'), 'prev');
setIcon($('tp-next'), 'next');
setIcon($('tp-shuffle'), 'shuffle');
setIcon($('queue-toggle'), 'queue');
setIcon($('viz-toggle'), 'bars');
setIcon($('karaoke-toggle'), 'mic');
setIcon($('np-like'), 'heart');
setIcon($('tray-speaker'), 'speaker');
$('start-icon').append(icon('note'));

$('win-min').addEventListener('click', () => appWindow().minimize());
$('win-max').addEventListener('click', () => appWindow().toggleMaximize());
$('win-close').addEventListener('click', () => appWindow().close());
// Tauri maximizes on a double-click on a drag region by itself (the title, and
// Modern's top row), so doing it here too would undo it. Classic's menu bar and
// toolbar aren't drag regions, so their empty parts are handled here.
for (const node of [$('menubar'), document.querySelector('.toolbar')]) {
  node.addEventListener('dblclick', (e) => {
    if (e.target === node && !node.hasAttribute('data-tauri-drag-region')) appWindow().toggleMaximize();
  });
}
$('task-button').addEventListener('click', () => appWindow().minimize());

window.addEventListener('focus', () => $('titlebar').classList.remove('idle'));
window.addEventListener('blur', () => $('titlebar').classList.add('idle'));

/* ---------- Session actions ---------- */

async function logOn() {
  const result = await logonDialog();
  if (result !== 'logged-on') return;
  try {
    await loadSession();
    setStatus(tr('Logged in as {name}', { name: session.user?.username }));
  } catch (e) {
    setStatus(errorText(e));
  }
  go({ name: 'home' });
  if (session.user) await welcomeIfNew(session.user.username);
}
window.addEventListener('sound95:logon', logOn);

async function logOff() {
  await api.logout();
  await loadSession();
  setStatus(tr('Logged off'));
  go({ name: 'home' });
}

/* ---------- Menus ---------- */

const repeatLabel = () => tr('Repeat: {mode}', { mode: tr({ off: 'Off', all: 'All', one: 'One' }[player.repeat]) });

function menuDefinitions() {
  const route = currentRoute();
  return {
    File: [
      { label: tr('New Playlist...'), disabled: !session.user, action: createPlaylist },
      'sep',
      { label: tr('Settings...'), action: settingsDialog },
      'sep',
      session.user
        ? { label: tr('Log Off {name}...', { name: session.user.username }), action: logOff }
        : { label: tr('Log In...'), action: logOn },
      'sep',
      { label: tr('Exit'), action: () => api.quit() },
    ],
    View: [
      { label: tr('Home'), checked: route?.name === 'home', action: () => go({ name: 'home' }) },
      { label: tr('Discover'), checked: route?.name === 'discover', action: () => go({ name: 'discover' }) },
      { label: tr('Liked Tracks'), checked: route?.name === 'liked', action: () => go({ name: 'liked' }) },
      { label: tr('Following'), checked: route?.name === 'following', action: () => go({ name: 'following' }) },
      'sep',
      { label: tr('Up Next'), checked: !$('workspace').classList.contains('no-queue'), action: toggleQueue },
      { label: tr('Visualizer'), checked: visualizerOpen(), action: toggleVisualizer },
      { label: tr('Karaoke'), checked: karaokeOpen(), action: toggleKaraoke },
      { label: tr('Refresh'), accel: 'F5', action: refresh },
    ],
    Playback: [
      { label: player.playing ? tr('Pause') : tr('Play'), accel: 'Space', disabled: !player.current, action: togglePlay },
      { label: tr('Next'), accel: 'Ctrl+Right', disabled: !player.current, action: () => next() },
      { label: tr('Previous'), accel: 'Ctrl+Left', disabled: !player.current, action: prev },
      'sep',
      { label: tr('Shuffle'), checked: player.shuffle, action: toggleShuffle },
      { label: repeatLabel(), action: cycleRepeat },
    ],
    Help: [
      { label: tr('Check for Updates...'), action: checkForUpdates },
      'sep',
      { label: tr('About Sound95'), action: aboutDialog },
    ],
  };
}

function openBarMenu(title, node) {
  const rect = node.getBoundingClientRect();
  node.classList.add('open');
  showMenu(menuDefinitions()[title], rect.left, rect.bottom, { onClose: () => node.classList.remove('open') });
}

function renderMenubar() {
  clear($('menubar'), ['File', 'View', 'Playback', 'Help'].map((title) => {
    const node = el('div', {
      class: 'menu-title',
      onMousedown: (e) => {
        e.stopPropagation();
        if (node.classList.contains('open')) closeMenu();
        else openBarMenu(title, node);
      },
      onMouseenter: () => {
        const other = document.querySelector('.menu-title.open');
        if (other && other !== node) openBarMenu(title, node);
      },
    }, tr(title));
    return node;
  }));
}
renderMenubar();

function openStartMenu() {
  const button = $('start-button');
  if (button.classList.contains('pressed')) return closeMenu();
  button.classList.add('pressed');
  const rect = button.getBoundingClientRect();
  const items = [
    { label: tr('Home'), icon: 'home', action: () => go({ name: 'home' }) },
    { label: tr('Discover'), icon: 'search', action: () => go({ name: 'discover' }) },
    { label: tr('Liked Tracks'), icon: 'heart-on', action: () => go({ name: 'liked' }) },
    { label: tr('Following'), icon: 'users', action: () => go({ name: 'following' }) },
    { label: tr('Visualizer'), icon: 'bars', action: toggleVisualizer },
    { label: tr('Karaoke'), icon: 'mic', action: toggleKaraoke },
    { label: tr('Settings...'), icon: 'gear', action: settingsDialog },
    'sep',
    session.user
      ? { label: tr('Log Off {name}...', { name: session.user.username }), icon: 'user', action: logOff }
      : { label: tr('Log In...'), icon: 'user', action: logOn },
    { label: tr('Shut Down'), icon: 'close', action: () => api.quit() },
  ];
  showMenu(items, rect.left, 0, {
    below: rect.top,
    className: 'start-menu',
    header: el('div', { class: 'start-banner' }, el('b', {}, 'Sound'), '95'),
    onClose: () => setTimeout(() => button.classList.remove('pressed'), 0),
  });
  return undefined;
}
$('start-button').addEventListener('mousedown', (e) => { e.stopPropagation(); openStartMenu(); });

/* ---------- Sidebar ---------- */

function treeItem(iconName, label, route) {
  const current = currentRoute();
  const selected = current && route.name === current.name && route.urn === current.urn;
  return el('div', {
    class: `tree-item${selected ? ' selected' : ''}`,
    title: label,
    onClick: () => go(route),
    onContextmenu: (e) => e.preventDefault(),
  }, icon(iconName), el('span', {}, label));
}

function renderSidebar() {
  clear($('sidebar'),
    el('div', { class: 'tree-head' }, icon('note'), 'Sound95'),
    treeItem('home', tr('Home'), { name: 'home' }),
    treeItem('note', tr('Discover'), { name: 'discover' }),
    treeItem('search', tr('Search'), { name: 'search', q: $('search-box').value.trim() }),
    el('div', { class: 'tree-head' }, icon('folder'), tr('My Library')),
    session.user ? [
      treeItem('heart-on', tr('Liked Tracks'), { name: 'liked' }),
      treeItem('clock', tr('Recently Played'), { name: 'recent' }),
      treeItem('users', tr('Following'), { name: 'following' }),
    ] : el('div', { class: 'tree-empty' }, tr('Log in to see this')),
    el('div', { class: 'tree-head' }, icon('folder'), tr('Playlists')),
    session.user ? [
      el('div', { class: 'tree-item', onClick: createPlaylist }, icon('plus'), el('span', {}, tr('New Playlist...'))),
      session.playlists.map((p) => treeItem('playlist', p.title, { name: 'playlist', urn: p.urn })),
    ] : null);
}

function renderAccount() {
  const button = $('account-button');
  if (session.user) {
    clear(button,
      session.user.avatar_url ? el('img', { class: 'avatar', src: session.user.avatar_url, alt: '' }) : icon('user'),
      el('span', {}, session.user.username));
    button.title = tr('Account');
  } else {
    clear(button, icon('keys'), el('span', {}, tr('Log In...')));
    button.title = tr('Log in to SoundCloud');
  }
}

$('account-button').addEventListener('click', (e) => {
  if (!session.user) return logOn();
  const rect = e.currentTarget.getBoundingClientRect();
  showMenu([
    { label: tr('Open Profile'), action: () => go({ name: 'user', urn: session.user.urn }) },
    { label: tr('Open on SoundCloud'), disabled: !session.user.permalink_url, action: () => api.open(session.user.permalink_url) },
    'sep',
    { label: tr('Log Off'), action: logOff },
  ], rect.left, rect.bottom);
  return undefined;
});

/* ---------- Player bar ---------- */

let dragging = false;

/** Modern's sliders colour in the part before the thumb. */
const fill = (slider) => slider.style.setProperty('--fill', `${((slider.value - slider.min) / (slider.max - slider.min)) * 100}%`);

/** Changes an icon only when it's a different one, so it doesn't animate in again. */
function swapIcon(node, name) {
  if (node.firstElementChild?.dataset.icon !== name) setIcon(node, name);
}

function renderPlayer() {
  const track = player.current;
  const playing = player.playing;
  swapIcon($('tp-play'), playing ? 'pause' : 'play');
  $('tp-play').setAttribute('aria-label', playing ? tr('Pause') : tr('Play'));
  for (const id of ['tp-play', 'tp-next', 'tp-prev']) $(id).disabled = !track;
  $('seek').disabled = !track;
  $('tp-shuffle').classList.toggle('on', player.shuffle);
  $('tp-repeat').classList.toggle('on', player.repeat !== 'off');
  swapIcon($('tp-repeat'), player.repeat === 'one' ? 'repeat-one' : 'repeat');
  $('tp-repeat').title = repeatLabel();
  $('np-title').textContent = track ? track.title : tr('Nothing playing');
  $('np-title').disabled = !track;
  $('np-title').title = track ? tr('Open track page') : '';
  $('np-art').title = track ? tr('Open track page') : '';
  $('np-artist').textContent = track ? `${track.artist}${player.preview ? tr(' (preview)') : ''}` : '';
  $('np-artist').disabled = !track?.userUrn;
  $('np-like').disabled = !track || !session.user;
  swapIcon($('np-like'), isLiked(track) ? 'heart-on' : 'heart');
  const art = $('np-art');
  const src = track?.artwork || '';
  if (art.dataset.src !== src || !art.firstChild) {
    art.dataset.src = src;
    clear(art, src ? el('img', { src, alt: '' }) : icon('note'));
  }
  clear($('task-button'), icon('note'), el('span', {}, track ? `${track.artist} - ${track.title}` : 'Sound95'));
  const title = track ? `${track.title} - Sound95` : 'Sound95';
  $('title-text').textContent = title;
  renderQueue();
  syncRows();
  renderTime();
}

function renderTime() {
  const total = durationMs();
  const pos = positionMs();
  $('time-now').textContent = fmtTime(pos);
  $('time-total').textContent = fmtTime(total);
  if (!dragging) $('seek').value = total ? Math.round((pos / total) * 1000) : 0;
  fill($('seek'));
}

function queueRow(t, i) {
  return el('div', { class: 'q-item', title: `${t.artist} - ${t.title}`, onDblclick: () => jumpTo(i) },
    el('button', { class: 'link q-art', title: tr('Open track page'), onClick: () => openTrack(t, player.queue, i) },
      t.artwork ? el('img', { src: t.artwork, alt: '', loading: 'lazy' }) : el('span', { class: 'q-blank' }, icon('note'))),
    el('div', { class: 'q-text' }, el('div', {}, t.title), el('div', { class: 'q-artist' }, t.artist)));
}

// The queue is only ever replaced or grown, so most player events (play, pause,
// seek, the next track) leave its rows alone and just move the highlight.
let shownQueue = null;
let shownLength = 0;

function renderQueue() {
  const list = $('queue-list');
  const queue = player.queue;
  if (queue !== shownQueue || queue.length !== shownLength) {
    shownQueue = queue;
    shownLength = queue.length;
    if (queue.length) clear(list, queue.map(queueRow));
    else clear(list, el('div', { class: 'tree-empty', style: 'padding:6px' }, tr('Nothing queued.')));
  }
  if (!queue.length) return;
  [...list.children].forEach((row, i) => {
    row.classList.toggle('current', i === player.index);
    row.classList.toggle('past', i < player.index);
  });
}

function toggleQueue() {
  const hidden = $('workspace').classList.toggle('no-queue');
  $('queue-toggle').classList.toggle('on', !hidden);
  try { localStorage.setItem('sound95.queue', hidden ? '0' : '1'); } catch { /* optional */ }
}

$('tp-play').addEventListener('click', togglePlay);
$('tp-next').addEventListener('click', () => next());
$('tp-prev').addEventListener('click', prev);
$('tp-shuffle').addEventListener('click', toggleShuffle);
$('tp-repeat').addEventListener('click', cycleRepeat);
$('queue-toggle').addEventListener('click', toggleQueue);
$('queue-clear').addEventListener('click', clearUpcoming);
$('np-like').addEventListener('click', () => player.current && toggleLike(player.current));
const openCurrent = () => player.current && openTrack(player.current, player.queue, player.index);
$('np-title').addEventListener('click', openCurrent);
$('np-art').addEventListener('click', openCurrent);
$('viz-toggle').addEventListener('click', toggleVisualizer);
$('mini-viz').addEventListener('click', toggleVisualizer);
$('karaoke-toggle').addEventListener('click', toggleKaraoke);
onVisualizerToggle(() => $('viz-toggle').classList.toggle('on', visualizerOpen()));
onKaraokeToggle(() => $('karaoke-toggle').classList.toggle('on', karaokeOpen()));
$('np-artist').addEventListener('click', () => player.current?.userUrn && go({ name: 'user', urn: player.current.userUrn }));

$('seek').addEventListener('input', () => {
  dragging = true;
  fill($('seek'));
  $('time-now').textContent = fmtTime(durationMs() * ($('seek').value / 1000));
});
$('seek').addEventListener('change', () => {
  dragging = false;
  seekTo($('seek').value / 1000);
});

function renderVolume() {
  fill($('volume'));
  setIcon($('vol-icon'), getVolume() === 0 ? 'mute' : 'speaker');
  setIcon($('tray-speaker'), getVolume() === 0 ? 'mute' : 'speaker');
}
$('volume').addEventListener('input', () => {
  setVolume($('volume').value / 100);
  renderVolume();
});

onProgress(renderTime);

/* ---------- Toolbar + navigation ---------- */

function submitSearch() {
  const q = $('search-box').value.trim();
  const route = currentRoute();
  go({ name: 'search', q, tab: route?.name === 'search' ? route.tab : 'tracks' });
}

$('search-go').addEventListener('click', submitSearch);
$('search-box').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitSearch(); });
$('nav-back').addEventListener('click', back);
$('nav-forward').addEventListener('click', forward);
$('nav-home').addEventListener('click', () => go({ name: 'home' }));

onNavigate((route) => {
  $('nav-back').disabled = !canGoBack();
  $('nav-forward').disabled = !canGoForward();
  if (route.name === 'search') $('search-box').value = route.q || '';
  renderSidebar();
});

onSessionChange(() => {
  renderSidebar();
  renderAccount();
  renderPlayer();
});
onPlayerChange(renderPlayer);

/* ---------- Tray ---------- */

let trayShows = null;

function renderTray() {
  const track = player.current;
  const labels = {
    now: track ? `${track.artist} - ${track.title}` : tr('Nothing playing'),
    hasTrack: !!track,
    toggle: player.playing ? tr('Pause') : tr('Play'),
    next: tr('Next'),
    previous: tr('Previous'),
    show: tr('Show Sound95'),
    quit: tr('Quit'),
  };
  const shows = JSON.stringify(labels);
  if (shows === trayShows) return;
  trayShows = shows;
  api.trayUpdate(labels).catch(() => { trayShows = null; });
}
onPlayerChange(renderTray);

window.__TAURI__.event.listen('sound95:tray', ({ payload }) => {
  if (payload === 'toggle') togglePlay();
  if (payload === 'next') next();
  if (payload === 'previous') prev();
});

/* ---------- Keyboard, misc ---------- */

// A click leaves focus on what was clicked, and Space would then press that
// button again (or do nothing on a slider). Space only presses a button that
// was reached with Tab; otherwise it's play/pause. Pressing anything else keeps
// the last clicked button: a scrollbar or the title bar takes the press without
// moving focus off it.
let clicked = null;
document.addEventListener('pointerdown', (e) => { clicked = e.target.closest?.('button') || clicked; }, true);

document.addEventListener('keydown', (e) => {
  const { target } = e;
  // Text fields keep Ctrl+Arrow for moving and selecting by word, and Space.
  const editing = target.isContentEditable || target.tagName === 'TEXTAREA'
    || (target.tagName === 'INPUT' && !['range', 'checkbox', 'button', 'file'].includes(target.type));
  if (e.key === 'Tab') clicked = null;
  if (document.querySelector('.scrim:not(.leaving)')) return;
  if (e.key === 'F5') { e.preventDefault(); refresh(); }
  if (!editing && e.ctrlKey && e.key === 'ArrowRight') { e.preventDefault(); next(); }
  if (!editing && e.ctrlKey && e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
  if (e.ctrlKey && e.key === 'l') { e.preventDefault(); $('search-box').select(); }
  if (e.altKey && e.key === 'ArrowLeft') back();
  if (e.altKey && e.key === 'ArrowRight') forward();
  const tabbedTo = target.tagName === 'BUTTON' && target !== clicked;
  if (e.key === ' ' && !editing && !tabbedTo) { e.preventDefault(); if (!e.repeat) togglePlay(); }
});

document.addEventListener('contextmenu', (e) => {
  if (!['INPUT', 'TEXTAREA'].includes(e.target.tagName)) e.preventDefault();
});

function tick() {
  $('clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
tick();
setInterval(tick, 10_000);

const AUDIO_TRIED = 'sound95.audioTried';

async function ensureAudio() {
  const audioState = await api.audioStatus();
  if (audioState.ready) localStorage.removeItem(AUDIO_TRIED);
  if (audioState.ready) return;
  const showCommand = () => message('Sound95', tr('Sound95 could not install the audio plug-ins it needs.'), {
    kind: 'warn',
    extra: audioState.command ? el('div', { style: 'margin-top:8px;display:grid;gap:4px' },
      el('p', {}, tr('To install them yourself, run:')),
      el('div', { class: 'selectable' }, audioState.command)) : null,
  });
  // Installing didn't help last time, so asking for the password again would only loop.
  if (!audioState.can_install || localStorage.getItem(AUDIO_TRIED)) {
    await showCommand();
    return;
  }
  if (!await audioAskDialog()) {
    setStatus(tr('Audio plug-ins were not installed, so tracks will not play.'), { sticky: true });
    return;
  }
  const result = await audioSetupDialog();
  if (result.ok) {
    localStorage.setItem(AUDIO_TRIED, '1');
    await api.relaunch();
  } else if (result.error?.code === 'audio_declined') {
    setStatus(tr('Audio plug-ins were not installed, so tracks will not play.'), { sticky: true });
  } else {
    await message('Sound95', errorText(result.error), { kind: 'warn' });
    await showCommand();
  }
}

/* ---------- Boot ---------- */

// Windows and open pages are built in one language, so they get rebuilt in the new one.
onLanguageChange(() => {
  renderTray();
  renderMenubar();
  renderSidebar();
  renderAccount();
  shownQueue = null;
  renderPlayer();
  refresh();
  for (const [open, toggle] of [[visualizerOpen, toggleVisualizer], [karaokeOpen, toggleKaraoke]]) {
    if (open()) { toggle(); toggle(); }
  }
});

const RECONNECT_MS = 10_000;

/** Sound95 started without a connection: the session comes back when the network does. */
function reconnect(reason) {
  setStatus(errorText(reason), { sticky: true });
  setTimeout(async () => {
    try {
      await loadSession();
      setStatus(tr('Ready'));
      go({ name: 'home' });
    } catch (e) {
      if (e?.code === 'session_expired') await logOn();
      else reconnect(e);
    }
  }, RECONNECT_MS);
}

async function boot() {
  applyTheme();
  translatePage();
  restoreBackdrop().catch(() => {});
  applyCloseToTray().catch(() => {});
  renderTray();
  const savedQueue = localStorage.getItem('sound95.queue');
  const narrow = window.matchMedia('(max-width: 1000px)').matches;
  if (savedQueue === '0' || (narrow && savedQueue === null)) $('workspace').classList.add('no-queue');
  $('queue-toggle').classList.toggle('on', !$('workspace').classList.contains('no-queue'));
  // A tile too small for both shows the page, and the button can still swap them.
  const tiny = window.matchMedia('(max-width: 560px)');
  const pageFirst = () => {
    if (!tiny.matches) return;
    $('workspace').classList.add('no-queue');
    $('queue-toggle').classList.remove('on');
  };
  tiny.addEventListener('change', pageFirst);
  pageFirst();
  restorePlayer();
  watchForUpdates();
  attachVisual($('mini-viz'));
  $('volume').value = Math.round(getVolume() * 100);
  renderVolume();
  await ensureAudio().catch((e) => setStatus(errorText(e), { sticky: true }));
  try {
    const status = await loadSession();
    go({ name: 'home' });
    if (!status.logged_on) await logOn();
    else if (session.user) await welcomeIfNew(session.user.username);
  } catch (e) {
    go({ name: 'home' });
    if (e?.code === 'session_expired') await logOn();
    else reconnect(e);
  }
}

boot();
