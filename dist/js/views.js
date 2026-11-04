// Main-pane views and the back/forward history.

import { tr } from './i18n.js';
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
  clear(content, el('div', { class: 'view note' }, tr('Loading...')));
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
    el('button', { onClick: refresh }, tr('Retry')));
}

function empty(text, iconName = 'note') {
  return el('div', { class: 'empty' }, icon(iconName), el('div', {}, text));
}

// Each track row's parts, found from its node. Rows are looked up on the page, so
// rows from a page that was replaced, or never shown, cost nothing.
const rows = new WeakMap();

/**
 * Re-marks playing rows and hearts without rebuilding the list. This runs on every
 * player and session event, so only rows whose state changed are redrawn.
 */
export function syncRows() {
  const current = player.current?.urn;
  for (const node of content.querySelectorAll('.row')) {
    const row = rows.get(node);
    if (!row) continue;
    const playing = row.track.urn === current;
    const num = playing ? (player.playing ? 'play' : 'pause') : '';
    if (row.drawnNum !== num) {
      row.drawnNum = num;
      node.classList.toggle('playing', playing);
      clear(row.num, num ? icon(num) : String(row.index + 1));
    }
    const liked = isLiked(row.track);
    if (row.drawnLiked !== liked) {
      row.drawnLiked = liked;
      clear(row.heart, liked ? icon('heart-on') : null);
    }
  }
}

function trackMenu(track, list, index, x, y) {
  const canUse = track.access !== 'blocked';
  const items = [
    { label: tr('Track Page'), action: () => openTrack(track, list, index) },
    'sep',
    { label: tr('Play'), disabled: !canUse, action: () => playList(list, index) },
    { label: tr('Play Next'), disabled: !canUse, action: () => enqueue(track, { nextUp: true }) },
    { label: tr('Add to Up Next'), disabled: !canUse, action: () => enqueue(track) },
    'sep',
    { label: isLiked(track) ? tr('Remove from Liked Tracks') : tr('Add to Liked Tracks'), disabled: !session.user, action: () => toggleLike(track) },
    { label: tr('Add to Playlist...'), disabled: !session.user, action: () => addToPlaylist(track) },
    'sep',
    { label: tr('Tracks Like This'), action: () => go({ name: 'related', track }) },
    { label: tr('Go to Uploader'), disabled: !track.userUrn, action: () => go({ name: 'user', urn: track.userUrn }) },
    { label: tr('Open on SoundCloud'), disabled: !track.link, action: () => api.open(track.link) },
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
  el('button', { class: 'link row-art', title: tr('Open track page'), onClick: openSoon },
    track.artwork ? el('img', { src: smallArt(track.artwork), alt: '', loading: 'lazy' }) : icon('note')),
  el('span', { class: 'title-wrap' },
    el('button', { class: 'link title', title: track.title, onClick: openSoon }, track.title),
    track.access === 'preview' ? el('span', { class: 'badge' }, tr('Preview')) : null,
    blocked ? el('span', { class: 'badge' }, tr('Blocked')) : null),
  el('button', {
    class: 'link artist',
    disabled: !track.userUrn,
    title: track.uploader,
    onClick: (e) => { e.stopPropagation(); go({ name: 'user', urn: track.userUrn }); },
  }, track.artist),
  el('span', { class: 'plays' }, fmtCount(track.plays)),
  el('span', { class: 'dur' }, fmtTime(track.duration)));
  rows.set(node, { track, index, num, heart });
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
    }, tr('More...')) : null);
  };
  addMoreButton();

  const node = el('div', { class: 'list' },
    el('div', { class: 'list-head' },
      el('span', { class: 'num' }, '#'), el('span', {}), el('span', {}), el('span', {}, tr('Title')),
      el('span', {}, tr('Artist')), el('span', { class: 'plays' }, tr('Plays')), el('span', { class: 'dur' }, tr('Time'))),
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
  sub: p.count != null ? tr('{count} tracks', { count: p.count }) : p.owner,
  onOpen: () => go({ name: 'playlist', urn: p.urn }),
});

const userTile = (u) => tile({
  art: bigArt(u.avatar),
  fallback: 'user',
  name: u.name,
  sub: u.followers != null ? tr('{count} followers', { count: fmtCount(u.followers) }) : '',
  onOpen: () => go({ name: 'user', urn: u.urn }),
});

/** Tiles with paging, like trackList. Returns the grid and its More... button. */
function tileList(first, load, toTile) {
  const grid = el('div', { class: 'tiles' }, first.items.map(toTile));
  // Outside the grid, so the button doesn't take a tile's place.
  const more = el('div', { class: 'more' });
  let nextHref = first.next;
  const addMoreButton = () => {
    if (!nextHref) {
      more.remove();
      return;
    }
    clear(more, el('button', {
      onClick: async (e) => {
        e.target.disabled = true;
        try {
          const nextPage = await load(nextHref);
          nextHref = nextPage.next;
          grid.append(...nextPage.items.map(toTile));
          addMoreButton();
        } catch (err) {
          e.target.disabled = false;
          setStatus(errorText(err));
        }
      },
    }, tr('More...')));
  };
  addMoreButton();
  return [grid, first.next ? more : null];
}

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
    onClick: () => {
      // The player drops blocked tracks, so a list of only those must not reach it.
      const t = getTracks().filter((x) => x.access !== 'blocked');
      if (t.length) playList(t, 0);
    },
  }, icon('play'), tr('Play'));
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
    el('button', { class: 'default', onClick: () => window.dispatchEvent(new Event('sound95:logon')) }, tr('Log In...')));
}

async function homeView(_route, alive) {
  if (!session.user) return logOnPrompt(tr('Log in to SoundCloud to start listening.'));
  const [feed, recent] = await Promise.allSettled([
    page(paths.feed(), normalizeFeedItem),
    page(paths.recent(), normalizeTrack),
  ]);
  if (!alive()) return el('div');
  const root = el('div', { class: 'view' }, el('h1', { class: 'greeting' }, tr('Welcome back, {name}', { name: session.user.username })));
  if (session.playlists.length) {
    root.append(el('div', { class: 'shelf-title' }, tr('Your Playlists')),
      el('div', { class: 'tiles' }, session.playlists.slice(0, 12).map(playlistTile)));
  }
  if (recent.status === 'fulfilled' && recent.value.items.length) {
    root.append(el('div', { class: 'shelf-title' }, tr('Recently Played')),
      trackList({ items: recent.value.items.slice(0, 8), next: null }, null).node);
  }
  if (feed.status === 'fulfilled' && feed.value.items.length) {
    const { node } = trackList(feed.value, (t) => page(t, normalizeFeedItem));
    root.append(el('div', { class: 'shelf-title' }, tr('New from People You Follow')), node);
  } else if (feed.status === 'rejected') {
    root.append(el('div', { class: 'shelf-title' }, tr('New from People You Follow')),
      el('div', { class: 'note' }, errorText(feed.reason)));
  }
  return root;
}

const GENRES = ['Hip-hop & Rap', 'Electronic', 'House', 'Techno', 'Pop', 'R&B & Soul', 'Rock', 'Indie', 'Ambient', 'Drum & Bass', 'Dubstep', 'Trap', 'Lo-fi', 'Metal', 'Jazz & Blues', 'Latin', 'Classical', 'Soundtrack'];

async function discoverView(_route, alive) {
  if (!session.user) return logOnPrompt(tr('Log in to discover music.'), 'search');
  const root = el('div', { class: 'view' },
    el('h1', { class: 'greeting' }, tr('Discover')),
    el('div', { class: 'shelf-title' }, tr('Browse by Genre')),
    el('div', { class: 'genres' }, GENRES.map((genre) => el('button', { onClick: () => go({ name: 'genre', genre }) }, tr(genre)))));
  // SoundCloud has no public recommendations feed, so this builds one from
  // what the user recently played, or failing that, liked.
  const [recent, likes] = await Promise.allSettled([page(paths.recent(), normalizeTrack), page(paths.likes(5), normalizeTrack)]);
  if (!alive()) return root;
  const seeds = [recent, likes].flatMap((r) => (r.status === 'fulfilled' ? r.value.items : []));
  const seed = seeds.find((t) => t.access !== 'blocked');
  if (seed) {
    const related = await page(paths.related(seed.urn), normalizeTrack).catch(() => ({ items: [], next: null }));
    if (related.items.length) {
      root.append(el('div', { class: 'shelf-title' }, tr('Because You Played "{title}"', { title: seed.title })),
        trackList(related, (t) => page(t, normalizeTrack)).node);
    }
  }
  return root;
}

async function genreView(route) {
  const view = await pagedTrackView(paths.genre(route.genre));
  return el('div', {},
    hero({ kind: tr('Genre'), title: tr(route.genre), meta: tr('Tracks on SoundCloud'), fallback: 'note' }),
    el('div', { class: 'hero-actions' }, playButton(() => view.tracks)),
    view.tracks.length ? view.node : empty(tr('SoundCloud returned no {genre} tracks.', { genre: tr(route.genre) })));
}

async function searchView(route) {
  if (!session.user) return logOnPrompt(tr('Log in to search SoundCloud.'), 'search');
  const tab = route.tab || 'tracks';
  const root = el('div', {});
  root.append(tabs([['tracks', tr('Tracks')], ['playlists', tr('Playlists')], ['people', tr('People')]], tab,
    (id) => { if (id !== tab) go({ ...route, tab: id }); }));
  if (!route.q) {
    root.append(empty(tr('Type in the search box and press Enter.'), 'search'));
    return root;
  }
  let body;
  if (tab === 'tracks') {
    const view = await pagedTrackView(paths.searchTracks(route.q));
    body = view.tracks.length ? view.node : empty(tr('No tracks found for "{query}".', { query: route.q }), 'search');
  } else {
    const isPeople = tab === 'people';
    const load = (t) => page(t, isPeople ? normalizeUser : normalizePlaylist);
    const result = await load(isPeople ? paths.searchUsers(route.q) : paths.searchPlaylists(route.q));
    body = result.items.length
      ? el('div', { class: 'view' }, tileList(result, load, isPeople ? userTile : playlistTile))
      : empty(tr(isPeople ? 'No people found for "{query}".' : 'No playlists found for "{query}".', { query: route.q }), 'search');
  }
  root.append(body);
  return root;
}

async function likedView() {
  if (!session.user) return empty(tr('Log in to see your liked tracks.'), 'heart');
  const view = await pagedTrackView(paths.likes());
  if (!view.tracks.length) return empty(tr('Tracks you like will show up here.'), 'heart');
  return el('div', {},
    hero({ kind: tr('Library'), title: tr('Liked Tracks'), meta: `${session.user.username}`, fallback: 'heart-on' }),
    el('div', { class: 'hero-actions' }, playButton(() => view.tracks)),
    view.node);
}

async function recentView() {
  if (!session.user) return empty(tr('Log in to see what you played.'), 'clock');
  const view = await pagedTrackView(paths.recent());
  if (!view.tracks.length) return empty(tr('Nothing played yet.'), 'clock');
  return el('div', {},
    hero({ kind: tr('Library'), title: tr('Recently Played'), meta: tr('Your last 25 tracks'), fallback: 'clock' }),
    el('div', { class: 'hero-actions' }, playButton(() => view.tracks)),
    view.node);
}

async function followingView() {
  if (!session.user) return empty(tr('Log in to see who you follow.'), 'users');
  const load = (t) => page(t, normalizeUser);
  const result = await load(paths.followings());
  if (!result.items.length) return empty(tr('You are not following anyone yet.'), 'users');
  return el('div', { class: 'view' },
    el('h1', { class: 'greeting' }, tr('Following')),
    tileList(result, load, userTile));
}

async function playlistView(route) {
  const [raw, view] = await Promise.all([
    api.get(paths.playlist(route.urn)),
    pagedTrackView(paths.playlistTracks(route.urn)),
  ]);
  const p = normalizePlaylist(raw);
  const meta = [p.owner, p.count != null ? tr('{count} tracks', { count: p.count }) : null, p.duration ? fmtTime(p.duration) : null]
    .filter(Boolean).join(' - ');
  return el('div', {},
    hero({ kind: tr('Playlist'), title: p.title, meta, art: p.artwork, fallback: 'playlist' }),
    el('div', { class: 'hero-actions' },
      playButton(() => view.tracks),
      p.link ? el('button', { onClick: () => api.open(p.link) }, tr('Open on SoundCloud')) : null),
    view.tracks.length ? view.node : empty(tr('This playlist is empty.'), 'playlist'));
}

async function relatedView(route) {
  const view = await pagedTrackView(paths.related(route.track.urn));
  return el('div', {},
    hero({ kind: tr('Tracks like'), title: route.track.title, meta: route.track.artist, art: route.track.artwork, fallback: 'note' }),
    el('div', { class: 'hero-actions' }, playButton(() => view.tracks)),
    view.tracks.length ? view.node : empty(tr('SoundCloud has no related tracks for this one.')));
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
        button.textContent = following ? tr('Unfollow') : tr('Follow');
      } catch (e) {
        setStatus(errorText(e));
      }
      button.disabled = false;
    },
  }, tr('Follow'));
  if (session.user && session.user.urn !== urn) {
    api.get(paths.followingIds())
      .then(({ collection }) => {
        following = collection.includes(Number(idOf(urn)));
        button.textContent = following ? tr('Unfollow') : tr('Follow');
      })
      .catch(() => {})
      .finally(() => { button.disabled = false; });
    return button;
  }
  return null;
}

async function userView(route) {
  const tab = route.tab || 'tracks';
  // Everything here needs only the URN, so the requests all go out at once.
  const follow = followButton(route.urn);
  const loadPlaylists = (t) => page(t, normalizePlaylist);
  const [raw, result] = await Promise.all([
    api.get(paths.user(route.urn)),
    tab === 'playlists'
      ? loadPlaylists(paths.userPlaylists(route.urn))
      : pagedTrackView(tab === 'likes' ? paths.userLikes(route.urn) : paths.userTracks(route.urn)),
  ]);
  const user = normalizeUser(raw);
  const meta = [
    user.followers != null ? tr('{count} followers', { count: fmtCount(user.followers) }) : null,
    user.tracks != null ? tr('{count} tracks', { count: fmtCount(user.tracks) }) : null,
    user.city,
  ].filter(Boolean).join(' - ');
  let tracks = [];
  let body;
  if (tab === 'playlists') {
    body = result.items.length
      ? el('div', { class: 'view' }, tileList(result, loadPlaylists, playlistTile))
      : empty(tr('No public playlists.'), 'playlist');
  } else {
    tracks = result.tracks;
    body = result.tracks.length ? result.node : empty(tr('No public tracks.'));
  }
  return el('div', {},
    hero({ kind: tr('Artist'), title: user.name, meta, art: user.avatar, fallback: 'user' }),
    el('div', { class: 'hero-actions' },
      tab !== 'playlists' ? playButton(() => tracks) : null,
      follow,
      user.link ? el('button', { onClick: () => api.open(user.link) }, tr('Open on SoundCloud')) : null),
    tabs([['tracks', tr('Tracks')], ['playlists', tr('Playlists')], ['likes', tr('Likes')]], tab,
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
      el('legend', {}, tr('Properties')),
      property(tr('Uploaded by'), track.uploader),
      property(tr('Length'), fmtTime(track.fullDuration)),
      property(tr('Released'), released),
      property(tr('Genre'), track.genre),
      property(tr('Tags'), tags),
      property(tr('Label'), track.label),
      property(tr('Plays'), track.plays != null ? track.plays.toLocaleString() : null),
      property(tr('Likes'), track.likes != null ? track.likes.toLocaleString() : null),
      property(tr('Reposts'), track.reposts != null ? track.reposts.toLocaleString() : null),
      property(tr('Comments'), track.comments != null ? track.comments.toLocaleString() : null)),
    track.description ? el('div', { class: 'shelf-title' }, tr('Description')) : null,
    track.description ? el('div', { class: 'description sunken selectable-text' }, track.description) : null);
}

function trackLyrics(track) {
  const body = el('div', { class: 'view' }, el('div', { class: 'note' }, tr('Searching for lyrics...')));
  lyricsFor(track).then(([best]) => {
    if (!best) {
      clear(body, empty(tr('No lyrics found for this track.')));
      return;
    }
    clear(body,
      el('div', { class: 'description sunken selectable-text' }, best.lines.map((l) => el('div', { class: 'lyric-line' }, l.text))),
      el('div', { class: 'note' }, tr('Lyrics from {source}: {track}', { source: best.source, track: `${best.artist} - ${best.title}` })));
  }, (e) => clear(body, el('div', { class: 'note' }, errorText(e))));
  return body;
}

async function trackView(route, alive) {
  const tab = route.tab || 'details';
  // Related tracks need only the URN, so they load alongside the track.
  const [raw, related] = await Promise.all([
    api.get(paths.track(route.urn)),
    tab === 'related' ? pagedTrackView(paths.related(route.urn)) : null,
  ]);
  // A page left before it loaded would only subscribe to events and fetch for nothing.
  if (!alive()) return el('div');
  const track = trackDetails(raw);
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
    clear(playToggle, icon(pausing ? 'pause' : 'play'), pausing ? tr('Pause') : tr('Play'));
  };
  showPlay();
  whileShown(playToggle, onPlayerChange, showPlay, alive);

  const like = el('button', { disabled: !session.user, onClick: () => toggleLike(track) });
  const showLike = () => clear(like, icon(isLiked(track) ? 'heart-on' : 'heart'), isLiked(track) ? tr('Liked') : tr('Like'));
  showLike();
  whileShown(like, onSessionChange, showLike, alive);

  const uploader = el('button', {
    class: 'link',
    disabled: !track.userUrn,
    onClick: () => go({ name: 'user', urn: track.userUrn }),
  }, track.artist);
  let body;
  if (tab === 'lyrics') body = trackLyrics(track);
  else if (tab === 'related') {
    body = related.tracks.length ? related.node : empty(tr('SoundCloud has no related tracks for this one.'));
  } else body = trackProperties(track);

  return el('div', {},
    hero({ kind: tr('Track'), title: track.title, meta: uploader, art: track.artwork, fallback: 'note' }),
    el('div', { class: 'hero-actions' },
      playToggle,
      like,
      el('button', { disabled: blocked, onClick: () => enqueue(track) }, tr('Add to Up Next')),
      el('button', { disabled: !session.user, onClick: () => addToPlaylist(track) }, tr('Add to Playlist...')),
      el('button', {
        disabled: blocked,
        onClick: () => {
          if (!isCurrent()) play();
          showKaraoke();
        },
      }, icon('mic'), tr('Karaoke')),
      track.link ? el('button', { onClick: () => api.open(track.link) }, tr('Open on SoundCloud')) : null),
    // A blocked track can't play, so clicking its waveform does nothing.
    track.waveform ? el('div', { class: 'wave-row' }, waveformView(track, { onPlay: blocked ? () => {} : play })) : null,
    tabs([['details', tr('Details')], ['lyrics', tr('Lyrics')], ['related', tr('Related Tracks')]], tab,
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
  if (!session.user) return setStatus(tr('Log in to create playlists.'));
  const title = await prompt('New Playlist', tr('Name:'), { okText: tr('Create') });
  if (!title) return undefined;
  try {
    const raw = await api.send('POST', '/playlists', { playlist: { title, sharing: 'private', tracks: [] } });
    const created = normalizePlaylist(raw);
    session.playlists.unshift(created);
    emitChange();
    setStatus(tr('Created "{title}"', { title }));
    return created;
  } catch (e) {
    setStatus(errorText(e));
    return undefined;
  }
}

async function addToPlaylist(track) {
  const owned = session.playlists;
  const choice = await dialog(tr('Add to Playlist'), (close) => ({
    body: owned.length
      ? el('div', { class: 'sunken', style: 'max-height:220px;overflow:auto;padding:2px' },
        owned.map((p) => el('div', { class: 'menu-item', style: 'grid-template-columns:18px 1fr', onClick: () => close(p) },
          icon('playlist'), el('span', {}, p.title))))
      : el('p', {}, tr('You have no playlists yet.')),
    buttons: [
      el('button', { onClick: () => close('new') }, tr('New Playlist...')),
      el('button', { onClick: () => close() }, tr('Cancel')),
    ],
  }));
  const target = choice === 'new' ? await createPlaylist() : choice;
  if (!target) return;
  try {
    setStatus(tr('Adding to "{title}"...', { title: target.title }), { sticky: true });
    // PUT replaces the whole track list, so the existing tracks must be resent.
    const ids = (await api.get(paths.playlist(target.urn))).tracks.map((t) => t.id);
    const id = Number(idOf(track.urn));
    if (ids.includes(id)) return setStatus(tr('"{title}" is already in "{playlist}"', { title: track.title, playlist: target.title }));
    await api.send('PUT', paths.playlist(target.urn), { playlist: { tracks: [...ids, id] } });
    setStatus(tr('Added "{title}" to "{playlist}"', { title: track.title, playlist: target.title }));
  } catch (e) {
    setStatus(errorText(e));
  }
  return undefined;
}

