// App shell: wires the window chrome, menus, player bar and session together.

import { api } from './api.js';
import { clear, el, errorText, fmtTime, setStatus } from './dom.js';
import { icon, setIcon } from './icons.js';
import { aboutDialog, audioSetupDialog, closeMenu, logonDialog, message, showMenu } from './dialogs.js';
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
$('title-text').addEventListener('dblclick', () => appWindow().toggleMaximize());
$('task-button').addEventListener('click', () => appWindow().minimize());

window.addEventListener('focus', () => $('titlebar').classList.remove('idle'));
window.addEventListener('blur', () => $('titlebar').classList.add('idle'));

/* ---------- Session actions ---------- */

async function logOn() {
  const result = await logonDialog();
  if (result !== 'logged-on') return;
  try {
    await loadSession();
    setStatus(`Logged in as ${session.user?.username}`);
  } catch (e) {
    setStatus(errorText(e));
  }
  go({ name: 'home' });
}
window.addEventListener('sound95:logon', logOn);

async function logOff() {
  await api.logout();
  await loadSession();
  setStatus('Logged off');
  go({ name: 'home' });
}

/* ---------- Menus ---------- */

function menuDefinitions() {
  const route = currentRoute();
  return {
    File: [
      { label: 'New Playlist...', disabled: !session.user, action: createPlaylist },
      'sep',
      session.user
        ? { label: `Log Off ${session.user.username}...`, action: logOff }
        : { label: 'Log In...', action: logOn },
      'sep',
      { label: 'Exit', action: () => appWindow().close() },
    ],
    View: [
      { label: 'Home', checked: route?.name === 'home', action: () => go({ name: 'home' }) },
      { label: 'Discover', checked: route?.name === 'discover', action: () => go({ name: 'discover' }) },
      { label: 'Liked Tracks', checked: route?.name === 'liked', action: () => go({ name: 'liked' }) },
      { label: 'Following', checked: route?.name === 'following', action: () => go({ name: 'following' }) },
      'sep',
      { label: 'Up Next', checked: !$('workspace').classList.contains('no-queue'), action: toggleQueue },
      { label: 'Visualizer', checked: visualizerOpen(), action: toggleVisualizer },
      { label: 'Karaoke', checked: karaokeOpen(), action: toggleKaraoke },
      { label: 'Refresh', accel: 'F5', action: refresh },
    ],
    Playback: [
      { label: player.playing ? 'Pause' : 'Play', accel: 'Space', disabled: !player.current, action: togglePlay },
      { label: 'Next', accel: 'Ctrl+Right', disabled: !player.current, action: () => next() },
      { label: 'Previous', accel: 'Ctrl+Left', disabled: !player.current, action: prev },
      'sep',
      { label: 'Shuffle', checked: player.shuffle, action: toggleShuffle },
      { label: `Repeat: ${{ off: 'Off', all: 'All', one: 'One' }[player.repeat]}`, action: cycleRepeat },
    ],
    Help: [
      { label: 'About Sound95', action: aboutDialog },
    ],
  };
}

function openBarMenu(title, node) {
  const rect = node.getBoundingClientRect();
  node.classList.add('open');
  showMenu(menuDefinitions()[title], rect.left, rect.bottom, { onClose: () => node.classList.remove('open') });
}

for (const title of ['File', 'View', 'Playback', 'Help']) {
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
  }, title);
  $('menubar').append(node);
}

function openStartMenu() {
  const button = $('start-button');
  if (button.classList.contains('pressed')) return closeMenu();
  button.classList.add('pressed');
  const rect = button.getBoundingClientRect();
  const items = [
    { label: 'Home', icon: 'home', action: () => go({ name: 'home' }) },
    { label: 'Discover', icon: 'search', action: () => go({ name: 'discover' }) },
    { label: 'Liked Tracks', icon: 'heart-on', action: () => go({ name: 'liked' }) },
    { label: 'Following', icon: 'users', action: () => go({ name: 'following' }) },
    { label: 'Visualizer', icon: 'bars', action: toggleVisualizer },
    { label: 'Karaoke', icon: 'mic', action: toggleKaraoke },
    'sep',
    session.user
      ? { label: `Log Off ${session.user.username}...`, icon: 'user', action: logOff }
      : { label: 'Log In...', icon: 'user', action: logOn },
    { label: 'Shut Down', icon: 'close', action: () => appWindow().close() },
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
    onClick: () => go(route),
    onContextmenu: (e) => e.preventDefault(),
  }, icon(iconName), el('span', { title: label }, label));
}

function renderSidebar() {
  clear($('sidebar'),
    el('div', { class: 'tree-head' }, icon('note'), 'Sound95'),
    treeItem('home', 'Home', { name: 'home' }),
    treeItem('note', 'Discover', { name: 'discover' }),
    treeItem('search', 'Search', { name: 'search', q: $('search-box').value.trim() }),
    el('div', { class: 'tree-head' }, icon('folder'), 'My Library'),
    session.user ? [
      treeItem('heart-on', 'Liked Tracks', { name: 'liked' }),
      treeItem('clock', 'Recently Played', { name: 'recent' }),
      treeItem('users', 'Following', { name: 'following' }),
    ] : el('div', { class: 'tree-empty' }, 'Log in to see this'),
    el('div', { class: 'tree-head' }, icon('folder'), 'Playlists'),
    session.user ? [
      el('div', { class: 'tree-item', onClick: createPlaylist }, icon('plus'), el('span', {}, 'New Playlist...')),
      session.playlists.map((p) => treeItem('playlist', p.title, { name: 'playlist', urn: p.urn })),
    ] : null);
}

function renderAccount() {
  const button = $('account-button');
  if (session.user) {
    clear(button,
      session.user.avatar_url ? el('img', { class: 'avatar', src: session.user.avatar_url, alt: '' }) : icon('user'),
      el('span', {}, session.user.username));
    button.title = 'Account';
  } else {
    clear(button, icon('keys'), el('span', {}, 'Log In...'));
    button.title = 'Log in to SoundCloud';
  }
}

$('account-button').addEventListener('click', (e) => {
  if (!session.user) return logOn();
  const rect = e.currentTarget.getBoundingClientRect();
  showMenu([
    { label: 'Open Profile', action: () => go({ name: 'user', urn: session.user.urn }) },
    { label: 'Open on SoundCloud', disabled: !session.user.permalink_url, action: () => api.open(session.user.permalink_url) },
    'sep',
    { label: 'Log Off', action: logOff },
  ], rect.left, rect.bottom);
  return undefined;
});

/* ---------- Player bar ---------- */

let dragging = false;

function renderPlayer() {
  const track = player.current;
  const playing = player.playing;
  setIcon($('tp-play'), playing ? 'pause' : 'play');
  $('tp-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  for (const id of ['tp-play', 'tp-next', 'tp-prev']) $(id).disabled = !track;
  $('seek').disabled = !track;
  $('tp-shuffle').classList.toggle('on', player.shuffle);
  $('tp-repeat').classList.toggle('on', player.repeat !== 'off');
  setIcon($('tp-repeat'), player.repeat === 'one' ? 'repeat-one' : 'repeat');
  $('tp-repeat').title = `Repeat: ${player.repeat}`;
  $('np-title').textContent = track ? track.title : 'Nothing playing';
  $('np-title').disabled = !track;
  $('np-title').title = track ? 'Open track page' : '';
  $('np-art').title = track ? 'Open track page' : '';
  $('np-artist').textContent = track ? `${track.artist}${player.preview ? ' (preview)' : ''}` : '';
  $('np-artist').disabled = !track?.userUrn;
  $('np-like').disabled = !track || !session.user;
  setIcon($('np-like'), isLiked(track) ? 'heart-on' : 'heart');
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
}

function renderQueue() {
  const list = $('queue-list');
  if (!player.queue.length) {
    clear(list, el('div', { class: 'tree-empty', style: 'padding:6px' }, 'Nothing queued.'));
    return;
  }
  clear(list, player.queue.map((t, i) => el('div', {
    class: `q-item${i === player.index ? ' current' : ''}${i < player.index ? ' past' : ''}`,
    title: `${t.artist} - ${t.title}`,
    onDblclick: () => jumpTo(i),
  },
  el('button', { class: 'link q-art', title: 'Open track page', onClick: () => openTrack(t, player.queue, i) },
    t.artwork ? el('img', { src: t.artwork, alt: '', loading: 'lazy' }) : el('span', { class: 'q-blank' }, icon('note'))),
  el('div', { class: 'q-text' }, el('div', {}, t.title), el('div', { class: 'q-artist' }, t.artist)))));
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
  $('time-now').textContent = fmtTime(durationMs() * ($('seek').value / 1000));
});
$('seek').addEventListener('change', () => {
  dragging = false;
  seekTo($('seek').value / 1000);
});

function renderVolume() {
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

/* ---------- Keyboard, misc ---------- */

document.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'TEXTAREA'].includes(e.target.tagName);
  if (document.querySelector('.scrim')) return;
  if (e.key === 'F5') { e.preventDefault(); refresh(); }
  if (e.ctrlKey && e.key === 'ArrowRight') { e.preventDefault(); next(); }
  if (e.ctrlKey && e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
  if (e.ctrlKey && e.key === 'l') { e.preventDefault(); $('search-box').select(); }
  if (e.altKey && e.key === 'ArrowLeft') back();
  if (e.altKey && e.key === 'ArrowRight') forward();
  if (e.key === ' ' && !typing && e.target.tagName !== 'BUTTON') { e.preventDefault(); togglePlay(); }
});

document.addEventListener('contextmenu', (e) => {
  if (!['INPUT', 'TEXTAREA'].includes(e.target.tagName)) e.preventDefault();
});

function tick() {
  $('clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
tick();
setInterval(tick, 10_000);

async function ensureAudio() {
  const audioState = await api.audioStatus();
  if (audioState.ready) return;
  const showCommand = () => message('Sound95', 'Sound95 could not install the audio plug-ins it needs.', {
    kind: 'warn',
    extra: audioState.command ? el('div', { style: 'margin-top:8px;display:grid;gap:4px' },
      el('p', {}, 'To install them yourself, run:'),
      el('div', { class: 'selectable' }, audioState.command)) : null,
  });
  if (!audioState.can_install) {
    await showCommand();
    return;
  }
  const result = await audioSetupDialog();
  if (result.ok) {
    await api.relaunch();
  } else if (result.error?.code === 'audio_declined') {
    setStatus('Audio plug-ins were not installed, so tracks will not play.', { sticky: true });
  } else {
    await message('Sound95', errorText(result.error), { kind: 'warn' });
    await showCommand();
  }
}

/* ---------- Boot ---------- */

async function boot() {
  const savedQueue = localStorage.getItem('sound95.queue');
  const narrow = window.matchMedia('(max-width: 1000px)').matches;
  if (savedQueue === '0' || (narrow && savedQueue === null)) $('workspace').classList.add('no-queue');
  $('queue-toggle').classList.toggle('on', !$('workspace').classList.contains('no-queue'));
  restorePlayer();
  attachVisual($('mini-viz'));
  $('volume').value = Math.round(getVolume() * 100);
  renderVolume();
  await ensureAudio().catch((e) => setStatus(errorText(e), { sticky: true }));
  try {
    const status = await loadSession();
    go({ name: 'home' });
    if (!status.logged_on) await logOn();
  } catch (e) {
    go({ name: 'home' });
    if (e?.code === 'session_expired') await logOn();
    else setStatus(errorText(e), { sticky: true });
  }
}

boot();
