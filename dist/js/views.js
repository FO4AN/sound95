// Main-pane views and the back/forward history.

import {
  api, bigArt, idOf, normalizeFeedItem, normalizePlaylist, normalizeTrack, normalizeUser, page, paths, smallArt,
  trackDetails,
} from './api.js';
import { clear, el, errorText, fmtCount, fmtTime, setStatus, whileShown } from './dom.js';
import { icon } from './icons.js';
import { dialog, prompt, showMenu } from './dialogs.js';
import { emitChange, isLiked, onSessionChange, session, toggleLike } from './session.js';
import { enqueue, onPlayerChange, playList, player, togglePlay } from './player.js';
import { waveformView } from './waveform.js';
import { lyricsFor, showKaraoke } from './karaoke.js';

const DOUBLE_CLICK_MS = 220;

const content = document.getElementById('content');
const stack = [];
let cursor = -1;
let renderToken = 0;
const navListeners = new Set();
export const onNavigate = (fn) => navListeners.add(fn);
export const currentRoute = () => stack[cursor] || null;
export const canGoBack = () => cursor > 0;
export const canGoForward = () => cursor < stack.length - 1;

export function go(route) {
  stack.splice(cursor + 1);
  stack.push(route);
  cursor = stack.length - 1;
  render();
}
export function back() { if (canGoBack()) { cursor -= 1; render(); } }
export function forward() { if (canGoForward()) { cursor += 1; render(); } }
export function refresh() { if (currentRoute()) render(); }

async function render() {
  const token = ++renderToken;
  const route = currentRoute();
  navListeners.forEach((fn) => fn(route));
  content.scrollTop = 0;
  clear(content, el('div', { class: 'view note' }, 'Loading...'));
  rows.clear();
  try {
    const node = await VIEWS[route.name](route, () => token === renderToken);
    if (token === renderToken) {
      clear(content, node);
      syncRows();
    }
  } catch (e) {
    if (token === renderToken) clear(content, failure(e));
  }
}

function failure(e) {
  return el('div', { class: 'empty' },
    icon('warn'),
    el('div', {}, errorText(e)),
    el('button', { onClick: refresh }, 'Retry'));
}

function empty(text, iconName = 'note') {
  return el('div', { class: 'empty' }, icon(iconName), el('div', {}, text));
}

const rows = new Set();

/** Re-marks playing rows and hearts without rebuilding the list. */
export function syncRows() {
  const current = player.current?.urn;
  for (const row of rows) {
    const playing = row.track.urn === current;
    row.node.classList.toggle('playing', playing);
    clear(row.num, playing ? icon(player.playing ? 'play' : 'pause') : String(row.index + 1));
    clear(row.heart, isLiked(row.track) ? icon('heart-on') : null);
  }
}

function trackMenu(track, list, index, x, y) {
  const canUse = track.access !== 'blocked';
  const items = [
    { label: 'Track Page', action: () => openTrack(track, list, index) },
    'sep',
    { label: 'Play', disabled: !canUse, action: () => playList(list, index) },
    { label: 'Play Next', disabled: !canUse, action: () => enqueue(track, { nextUp: true }) },
    { label: 'Add to Up Next', disabled: !canUse, action: () => enqueue(track) },
    'sep',
    { label: isLiked(track) ? 'Remove from Liked Tracks' : 'Add to Liked Tracks', disabled: !session.user, action: () => toggleLike(track) },
    { label: 'Add to Playlist...', disabled: !session.user, action: () => addToPlaylist(track) },
    'sep',
    { label: 'Tracks Like This', action: () => go({ name: 'related', track }) },
    { label: 'Go to Uploader', disabled: !track.userUrn, action: () => go({ name: 'user', urn: track.userUrn }) },
    { label: 'Open on SoundCloud', disabled: !track.link, action: () => api.open(track.link) },
  ];
  showMenu(items, x, y);
}

export function openTrack(track, list, index) {
  go({ name: 'track', urn: track.urn, list, index });
}

function trackRow(track, list, index) {
  const num = el('span', { class: 'num' });
  const heart = el('span', { class: 'heart' });
  const blocked = track.access === 'blocked';
  // A double click still has to play, so a click waits to see if another follows.
  let opening;
  const openSoon = () => {
    clearTimeout(opening);
    opening = setTimeout(() => openTrack(track, list, index), DOUBLE_CLICK_MS);
  };
  const node = el('div', {
    class: `row${blocked ? ' blocked' : ''}`,
    onClick: (e) => {
      content.querySelectorAll('.row.selected').forEach((r) => r.classList.remove('selected'));
      node.classList.add('selected');
      if (e.target.closest('.heart')) toggleLike(track);
    },
    onDblclick: (e) => {
      clearTimeout(opening);
      if (!blocked && !e.target.closest('.heart')) playList(list, index);
    },
    onContextmenu: (e) => {
      e.preventDefault();
      node.click();
      trackMenu(track, list, index, e.clientX, e.clientY);
    },
  },
  num,
  heart,
  el('button', { class: 'link row-art', title: 'Open track page', onClick: openSoon },
    track.artwork ? el('img', { src: smallArt(track.artwork), alt: '', loading: 'lazy' }) : icon('note')),
  el('span', { class: 'title-wrap' },
    el('button', { class: 'link title', title: track.title, onClick: openSoon }, track.title),
    track.access === 'preview' ? el('span', { class: 'badge' }, 'Preview') : null,
    blocked ? el('span', { class: 'badge' }, 'Blocked') : null),
  el('button', {
    class: 'link artist',
    disabled: !track.userUrn,
    title: track.uploader,
    onClick: (e) => { e.stopPropagation(); go({ name: 'user', urn: track.userUrn }); },
  }, track.artist),
  el('span', { class: 'plays' }, fmtCount(track.plays)),
  el('span', { class: 'dur' }, fmtTime(track.duration)));
  rows.add({ node, track, index, num, heart });
  return node;
}

/** Details list with paging. Returns the node plus the live track array. */
function trackList(first, load) {
  const tracks = [...first.items];
  const body = el('div', {}, tracks.map((t, i) => trackRow(t, tracks, i)));
  const more = el('div', { class: 'more' });
  let nextHref = first.next;

  const addMoreButton = () => {
    clear(more, nextHref ? el('button', {
      onClick: async (e) => {
        e.target.disabled = true;
        try {
          const nextPage = await load(nextHref);
          nextHref = nextPage.next;
          const start = tracks.length;
          tracks.push(...nextPage.items);
          body.append(...nextPage.items.map((t, i) => trackRow(t, tracks, start + i)));
          syncRows();
          addMoreButton();
        } catch (err) {
          e.target.disabled = false;
          setStatus(errorText(err));
        }
      },
    }, 'More...') : null);
  };
  addMoreButton();

  const node = el('div', { class: 'list' },
    el('div', { class: 'list-head' },
      el('span', { class: 'num' }, '#'), el('span', {}), el('span', {}), el('span', {}, 'Title'),
      el('span', {}, 'Artist'), el('span', { class: 'plays' }, 'Plays'), el('span', { class: 'dur' }, 'Time')),
    body, more);
  return { node, tracks };
}

function tile({ art, fallback, name, sub, onOpen }) {
  return el('div', { class: 'tile', title: name, onClick: onOpen },
    art ? el('img', { class: 'tile-art', src: art, alt: '', loading: 'lazy' }) : el('span', { class: 'tile-art' }, icon(fallback)),
    el('span', { class: 'tile-name' }, name),
    sub ? el('span', { class: 'tile-sub' }, sub) : null);
}

const playlistTile = (p) => tile({
  art: bigArt(p.artwork),
  fallback: 'playlist',
  name: p.title,
  sub: p.count != null ? `${p.count} tracks` : p.owner,
  onOpen: () => go({ name: 'playlist', urn: p.urn }),
});

const userTile = (u) => tile({
  art: bigArt(u.avatar),
  fallback: 'user',
  name: u.name,
  sub: u.followers != null ? `${fmtCount(u.followers)} followers` : '',
  onOpen: () => go({ name: 'user', urn: u.urn }),
});

function hero({ kind, title, meta, art, fallback }) {
  return el('div', { class: 'hero' },
    art ? el('img', { class: 'hero-art', src: bigArt(art), alt: '' }) : el('span', { class: 'hero-art' }, icon(fallback)),
    el('div', { class: 'hero-text' },
      el('span', { class: 'hero-kind' }, kind),
      el('h1', { class: 'hero-title' }, title),
      el('span', { class: 'hero-meta' }, meta)));
}

function playButton(getTracks) {
  return el('button', {
    class: 'default',
    onClick: () => { const t = getTracks(); if (t.length) playList(t, 0); },
  }, icon('play'), 'Play');
}

function tabs(items, selected, onSelect) {
  return el('div', { class: 'tabs' }, items.map(([id, label]) => el('button', {
    class: `tab${id === selected ? ' selected' : ''}`,
    onClick: () => onSelect(id),
  }, label)));
}

async function pagedTrackView(target, normalize = normalizeTrack) {
  const load = (t) => page(t, normalize);
  return trackList(await load(target), load);
}

function logOnPrompt(text, iconName = 'keys') {
  return el('div', { class: 'empty' }, icon(iconName), el('div', {}, text),
    el('button', { class: 'default', onClick: () => window.dispatchEvent(new Event('sound95:logon')) }, 'Log In...'));
}

async function homeView(_route, alive) {
  if (!session.user) return logOnPrompt('Log in to SoundCloud to start listening.');
  const [feed, recent] = await Promise.allSettled([
    page(paths.feed(), normalizeFeedItem),
    page(paths.recent(), normalizeTrack),
  ]);
  if (!alive()) return el('div');
  const root = el('div', { class: 'view' }, el('h1', { class: 'greeting' }, `Welcome back, ${session.user.username}`));
  if (session.playlists.length) {
    root.append(el('div', { class: 'shelf-title' }, 'Your Playlists'),
      el('div', { class: 'tiles' }, session.playlists.slice(0, 12).map(playlistTile)));
  }
  if (recent.status === 'fulfilled' && recent.value.items.length) {
    root.append(el('div', { class: 'shelf-title' }, 'Recently Played'),
      trackList({ items: recent.value.items.slice(0, 8), next: null }, null).node);
  }
  if (feed.status === 'fulfilled' && feed.value.items.length) {
    const { node } = trackList(feed.value, (t) => page(t, normalizeFeedItem));
    root.append(el('div', { class: 'shelf-title' }, 'New from People You Follow'), node);
  } else if (feed.status === 'rejected') {
    root.append(el('div', { class: 'shelf-title' }, 'New from People You Follow'),
      el('div', { class: 'note' }, errorText(feed.reason)));
  }
  return root;
}

const GENRES = ['Hip-hop & Rap', 'Electronic', 'House', 'Techno', 'Pop', 'R&B & Soul', 'Rock', 'Indie', 'Ambient', 'Drum & Bass', 'Dubstep', 'Trap', 'Lo-fi', 'Metal', 'Jazz & Blues', 'Latin', 'Classical', 'Soundtrack'];

async function discoverView(_route, alive) {
  if (!session.user) return logOnPrompt('Log in to discover music.', 'search');
  const root = el('div', { class: 'view' },
    el('h1', { class: 'greeting' }, 'Discover'),
    el('div', { class: 'shelf-title' }, 'Browse by Genre'),
    el('div', { class: 'genres' }, GENRES.map((genre) => el('button', { onClick: () => go({ name: 'genre', genre }) }, genre))));
  // SoundCloud has no public recommendations feed, so this builds one from
  // what the user recently played, or failing that, liked.
  const [recent, likes] = await Promise.allSettled([page(paths.recent(), normalizeTrack), page(paths.likes(5), normalizeTrack)]);
  if (!alive()) return root;
  const seeds = [recent, likes].flatMap((r) => (r.status === 'fulfilled' ? r.value.items : []));
  const seed = seeds.find((t) => t.access !== 'blocked');
  if (seed) {
    const related = await page(paths.related(seed.urn), normalizeTrack).catch(() => ({ items: [], next: null }));
    if (related.items.length) {
      root.append(el('div', { class: 'shelf-title' }, `Because You Played "${seed.title}"`),
        trackList(related, (t) => page(t, normalizeTrack)).node);
    }
  }
  return root;
}

async function genreView(route) {
  const view = await pagedTrackView(paths.genre(route.genre));
  return el('div', {},
    hero({ kind: 'Genre', title: route.genre, meta: 'Tracks on SoundCloud', fallback: 'note' }),
    el('div', { class: 'hero-actions' }, playButton(() => view.tracks)),
    view.tracks.length ? view.node : empty(`SoundCloud returned no ${route.genre} tracks.`));
}

async function searchView(route) {
  if (!session.user) return logOnPrompt('Log in to search SoundCloud.', 'search');
  const tab = route.tab || 'tracks';
  const root = el('div', {});
  root.append(tabs([['tracks', 'Tracks'], ['playlists', 'Playlists'], ['people', 'People']], tab,
    (id) => { if (id !== tab) go({ ...route, tab: id }); }));
  if (!route.q) {
    root.append(empty('Type in the search box and press Enter.', 'search'));
    return root;
  }
  let body;
  if (tab === 'tracks') {
    const view = await pagedTrackView(paths.searchTracks(route.q));
    body = view.tracks.length ? view.node : empty(`No tracks found for "${route.q}".`, 'search');
  } else {
    const isPeople = tab === 'people';
    const result = await page(
      isPeople ? paths.searchUsers(route.q) : paths.searchPlaylists(route.q),
      isPeople ? normalizeUser : normalizePlaylist,
    );
    body = result.items.length
      ? el('div', { class: 'view' }, el('div', { class: 'tiles' }, result.items.map(isPeople ? userTile : playlistTile)))
      : empty(`No ${isPeople ? 'people' : 'playlists'} found for "${route.q}".`, 'search');
  }
  root.append(body);
  return root;
}

async function likedView() {
  if (!session.user) return empty('Log in to see your liked tracks.', 'heart');
  const view = await pagedTrackView(paths.likes());
  if (!view.tracks.length) return empty('Tracks you like will show up here.', 'heart');
  return el('div', {},
    hero({ kind: 'Library', title: 'Liked Tracks', meta: `${session.user.username}`, fallback: 'heart-on' }),
    el('div', { class: 'hero-actions' }, playButton(() => view.tracks)),
    view.node);
}

async function recentView() {
  if (!session.user) return empty('Log in to see what you played.', 'clock');
  const view = await pagedTrackView(paths.recent());
  if (!view.tracks.length) return empty('Nothing played yet.', 'clock');
  return el('div', {},
    hero({ kind: 'Library', title: 'Recently Played', meta: 'Your last 25 tracks', fallback: 'clock' }),
    el('div', { class: 'hero-actions' }, playButton(() => view.tracks)),
    view.node);
}

async function followingView() {
  if (!session.user) return empty('Log in to see who you follow.', 'users');
  const result = await page(paths.followings(), normalizeUser);
  if (!result.items.length) return empty('You are not following anyone yet.', 'users');
  return el('div', { class: 'view' },
    el('h1', { class: 'greeting' }, 'Following'),
    el('div', { class: 'tiles' }, result.items.map(userTile)));
}

async function playlistView(route) {
  const [raw, view] = await Promise.all([
    api.get(paths.playlist(route.urn)),
    pagedTrackView(paths.playlistTracks(route.urn)),
  ]);
  const p = normalizePlaylist(raw);
  const meta = [p.owner, p.count != null ? `${p.count} tracks` : null, p.duration ? fmtTime(p.duration) : null]
    .filter(Boolean).join(' - ');
  return el('div', {},
    hero({ kind: 'Playlist', title: p.title, meta, art: p.artwork, fallback: 'playlist' }),
    el('div', { class: 'hero-actions' },
      playButton(() => view.tracks),
      p.link ? el('button', { onClick: () => api.open(p.link) }, 'Open on SoundCloud') : null),
    view.tracks.length ? view.node : empty('This playlist is empty.', 'playlist'));
}

async function relatedView(route) {
  const view = await pagedTrackView(paths.related(route.track.urn));
  return el('div', {},
    hero({ kind: 'Tracks like', title: route.track.title, meta: route.track.artist, art: route.track.artwork, fallback: 'note' }),
    el('div', { class: 'hero-actions' }, playButton(() => view.tracks)),
    view.tracks.length ? view.node : empty('SoundCloud has no related tracks for this one.'));
}

function followButton(urn) {
  let following = false;
  const button = el('button', {
    disabled: true,
    onClick: async () => {
      button.disabled = true;
      try {
        await api.send(following ? 'DELETE' : 'POST', paths.follow(urn));
        following = !following;
        button.textContent = following ? 'Unfollow' : 'Follow';
      } catch (e) {
        setStatus(errorText(e));
      }
      button.disabled = false;
    },
  }, 'Follow');
  if (session.user && session.user.urn !== urn) {
    api.get(paths.followingIds())
      .then(({ collection }) => {
        following = collection.includes(Number(idOf(urn)));
        button.textContent = following ? 'Unfollow' : 'Follow';
      })
      .catch(() => {})
      .finally(() => { button.disabled = false; });
    return button;
  }
  return null;
}

async function userView(route) {
  const tab = route.tab || 'tracks';
  const user = normalizeUser(await api.get(paths.user(route.urn)));
  const meta = [
    user.followers != null ? `${fmtCount(user.followers)} followers` : null,
    user.tracks != null ? `${fmtCount(user.tracks)} tracks` : null,
    user.city,
  ].filter(Boolean).join(' - ');
  let tracks = [];
  let body;
  if (tab === 'playlists') {
    const result = await page(paths.userPlaylists(route.urn), normalizePlaylist);
    body = result.items.length
      ? el('div', { class: 'view' }, el('div', { class: 'tiles' }, result.items.map(playlistTile)))
      : empty('No public playlists.', 'playlist');
  } else {
    const view = await pagedTrackView(tab === 'likes' ? paths.userLikes(route.urn) : paths.userTracks(route.urn));
    tracks = view.tracks;
    body = view.tracks.length ? view.node : empty('No public tracks.');
  }
  return el('div', {},
    hero({ kind: 'Artist', title: user.name, meta, art: user.avatar, fallback: 'user' }),
    el('div', { class: 'hero-actions' },
      tab !== 'playlists' ? playButton(() => tracks) : null,
      followButton(route.urn),
      user.link ? el('button', { onClick: () => api.open(user.link) }, 'Open on SoundCloud') : null),
    tabs([['tracks', 'Tracks'], ['playlists', 'Playlists'], ['likes', 'Likes']], tab,
      (id) => { if (id !== tab) go({ ...route, tab: id }); }),
    body);
}

function property(name, value) {
  return value == null || value === '' ? null : [el('span', { class: 'prop-name' }, `${name}:`), el('span', { class: 'prop-value' }, value)];
}

function trackProperties(track) {
  const released = track.released ? new Date(track.released).toLocaleDateString() : '';
  const tags = (track.tags.match(/"[^"]+"|\S+/g) || []).map((t) => t.replaceAll('"', '')).join(', ');
  return el('div', { class: 'view' },
    el('fieldset', { class: 'props' },
      el('legend', {}, 'Properties'),
      property('Uploaded by', track.uploader),
      property('Length', fmtTime(track.fullDuration)),
      property('Released', released),
      property('Genre', track.genre),
      property('Tags', tags),
      property('Label', track.label),
      property('Plays', track.plays != null ? track.plays.toLocaleString() : null),
      property('Likes', track.likes != null ? track.likes.toLocaleString() : null),
      property('Reposts', track.reposts != null ? track.reposts.toLocaleString() : null),
      property('Comments', track.comments != null ? track.comments.toLocaleString() : null)),
    track.description ? el('div', { class: 'shelf-title' }, 'Description') : null,
    track.description ? el('div', { class: 'description sunken selectable-text' }, track.description) : null);
}

function trackLyrics(track) {
  const body = el('div', { class: 'view' }, el('div', { class: 'note' }, 'Searching for lyrics...'));
  lyricsFor(track).then(([best]) => {
    if (!best) {
      clear(body, empty('No lyrics found for this track.'));
      return;
    }
    clear(body,
      el('div', { class: 'description sunken selectable-text' }, best.lines.map((l) => el('div', { class: 'lyric-line' }, l.text))),
      el('div', { class: 'note' }, `Lyrics from ${best.source}: ${best.artist} - ${best.title}`));
  }, (e) => clear(body, el('div', { class: 'note' }, errorText(e))));
  return body;
}

async function trackView(route) {
  const tab = route.tab || 'details';
  const track = trackDetails(await api.get(paths.track(route.urn)));
  const blocked = track.access === 'blocked';
  const isCurrent = () => player.current?.urn === track.urn;
  const play = () => {
    const inList = route.list?.[route.index]?.urn === track.urn;
    playList(inList ? route.list : [track], inList ? route.index : 0);
  };

  const playToggle = el('button', {
    class: 'default',
    disabled: blocked,
    onClick: () => { if (isCurrent()) togglePlay(); else play(); },
  });
  const showPlay = () => {
    const pausing = isCurrent() && player.playing;
    clear(playToggle, icon(pausing ? 'pause' : 'play'), pausing ? 'Pause' : 'Play');
  };
  showPlay();
  whileShown(playToggle, onPlayerChange, showPlay);

  const like = el('button', { disabled: !session.user, onClick: () => toggleLike(track) });
  const showLike = () => clear(like, icon(isLiked(track) ? 'heart-on' : 'heart'), isLiked(track) ? 'Liked' : 'Like');
  showLike();
  whileShown(like, onSessionChange, showLike);

  const uploader = el('button', {
    class: 'link',
    disabled: !track.userUrn,
    onClick: () => go({ name: 'user', urn: track.userUrn }),
  }, track.artist);
  let body;
  if (tab === 'lyrics') body = trackLyrics(track);
  else if (tab === 'related') {
    const view = await pagedTrackView(paths.related(track.urn));
    body = view.tracks.length ? view.node : empty('SoundCloud has no related tracks for this one.');
  } else body = trackProperties(track);

  return el('div', {},
    hero({ kind: 'Track', title: track.title, meta: uploader, art: track.artwork, fallback: 'note' }),
    el('div', { class: 'hero-actions' },
      playToggle,
      like,
      el('button', { disabled: blocked, onClick: () => enqueue(track) }, 'Add to Up Next'),
      el('button', { disabled: !session.user, onClick: () => addToPlaylist(track) }, 'Add to Playlist...'),
      el('button', {
        disabled: blocked,
        onClick: () => {
          if (!isCurrent()) play();
          showKaraoke();
        },
      }, icon('mic'), 'Karaoke'),
      track.link ? el('button', { onClick: () => api.open(track.link) }, 'Open on SoundCloud') : null),
    track.waveform ? el('div', { class: 'wave-row' }, waveformView(track, { onPlay: play })) : null,
    tabs([['details', 'Details'], ['lyrics', 'Lyrics'], ['related', 'Related Tracks']], tab,
      (id) => { if (id !== tab) go({ ...route, tab: id }); }),
    body);
}

const VIEWS = {
  home: homeView,
  discover: discoverView,
  genre: genreView,
  search: searchView,
  liked: likedView,
  recent: recentView,
  following: followingView,
  playlist: playlistView,
  user: userView,
  related: relatedView,
  track: trackView,
};

export async function createPlaylist() {
  if (!session.user) return setStatus('Log in to create playlists.');
  const title = await prompt('New Playlist', 'Name:', { okText: 'Create' });
  if (!title) return undefined;
  try {
    const raw = await api.send('POST', '/playlists', { playlist: { title, sharing: 'private', tracks: [] } });
    const created = normalizePlaylist(raw);
    session.playlists.unshift(created);
    emitChange();
    setStatus(`Created "${title}"`);
    return created;
  } catch (e) {
    setStatus(errorText(e));
    return undefined;
  }
}

async function addToPlaylist(track) {
  const owned = session.playlists;
  const choice = await dialog('Add to Playlist', (close) => ({
    body: owned.length
      ? el('div', { class: 'sunken', style: 'max-height:220px;overflow:auto;padding:2px' },
        owned.map((p) => el('div', { class: 'menu-item', style: 'grid-template-columns:18px 1fr', onClick: () => close(p) },
          icon('playlist'), el('span', {}, p.title))))
      : el('p', {}, 'You have no playlists yet.'),
    buttons: [
      el('button', { onClick: () => close('new') }, 'New Playlist...'),
      el('button', { onClick: () => close() }, 'Cancel'),
    ],
  }));
  const target = choice === 'new' ? await createPlaylist() : choice;
  if (!target) return;
  try {
    setStatus(`Adding to "${target.title}"...`, { sticky: true });
    // PUT replaces the whole track list, so the existing tracks must be resent.
    const ids = (await api.get(paths.playlist(target.urn))).tracks.map((t) => t.id);
    const id = Number(idOf(track.urn));
    if (ids.includes(id)) return setStatus(`"${track.title}" is already in "${target.title}"`);
    await api.send('PUT', paths.playlist(target.urn), { playlist: { tracks: [...ids, id] } });
    setStatus(`Added "${track.title}" to "${target.title}"`);
  } catch (e) {
    setStatus(errorText(e));
  }
  return undefined;
}

