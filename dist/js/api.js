// Bridge to the Rust backend, which holds the session and talks to SoundCloud.
// Everything here speaks api-v2, the API SoundCloud's website uses, because that's
// the one a website login is good for. Views only see the normalised shapes.

import { tr } from './i18n.js';

const PAGE = 50;
const MAX_IDS = 5000;
const ACCESS = { BLOCK: 'blocked', SNIP: 'preview' };

let me = null;
export const setMe = (user) => { me = user?.id ?? null; };

// When a session can't be renewed, the backend has already logged out. The page is
// told once, so it stops showing you as logged in and can offer to log in again.
const invoke = (...args) => window.__TAURI__.core.invoke(...args).catch((e) => {
  if (me != null && e?.code === 'session_expired') {
    me = null;
    window.dispatchEvent(new CustomEvent('sound95:expired', { detail: e }));
  }
  throw e;
});

/** The numeric ID on the end of a URN, which is what api-v2 paths take. */
export const idOf = (urn) => String(urn).split(':').pop();

const urnOf = (kind, raw) => raw.urn || `soundcloud:${kind}:${raw.id}`;

export const trackUrn = (id) => `soundcloud:tracks:${id}`;

export function url(path, params = {}) {
  const query = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]),
  );
  return query.size ? `${path}?${query}` : path;
}

export const api = {
  status: () => invoke('status'),
  login: () => invoke('login'),
  cancelLogin: () => invoke('cancel_login'),
  logout: () => invoke('logout'),
  get: (target) => invoke('api_get', { target }),
  send: (method, path, body = null) => invoke('api_send', { method, path, body }),
  open: (link) => invoke('open_link', { url: link }),
  openTrackPage: (link) => invoke('open_track_page', { link }),
  trackPageOpen: () => invoke('track_page_open'),
  closeTrackPage: () => invoke('close_track_page'),
  lyrics: (request) => invoke('lyrics_search', { request }),
  waveform: (link) => invoke('waveform', { url: link }),
  visualStart: () => invoke('visual_start'),
  visualStop: () => invoke('visual_stop'),
  audioStatus: () => invoke('audio_status'),
  audioInstall: () => invoke('audio_install'),
  relaunch: () => invoke('relaunch'),
  quit: () => invoke('quit'),
  trayUpdate: (labels) => invoke('tray_update', { labels }),
  trayClosesTo: (closes) => invoke('tray_closes_to', { closes }),
  discordAvailable: () => invoke('discord_available'),
  discordUpdate: (enabled, playing) => invoke('discord_update', { enabled, playing }),
  version: () => window.__TAURI__.app.getVersion(),
  updateCheck: () => invoke('update_check'),
  updateInstall: () => invoke('update_install'),
};

export function normalizeTrack(raw) {
  // Likes and play history wrap the track.
  const track = raw?.track || raw;
  if (!track) return null;
  return {
    kind: 'track',
    urn: urnOf('tracks', track),
    title: track.title || tr('Untitled'),
    artist: track.publisher_metadata?.artist || track.user?.username || tr('Unknown artist'),
    uploader: track.user?.username || '',
    userUrn: track.user?.urn || null,
    duration: track.duration || 0,
    fullDuration: track.full_duration || track.duration || 0,
    plays: track.playback_count ?? null,
    artwork: track.artwork_url || track.user?.avatar_url || '',
    link: track.permalink_url || '',
    access: track.access || ACCESS[track.policy] || 'playable',
  };
}

/** Everything the track page shows. Kept apart so the saved queue stays small. */
export function trackDetails(raw) {
  return {
    ...normalizeTrack(raw),
    waveform: raw.waveform_url || '',
    description: raw.description || '',
    genre: raw.genre || '',
    tags: raw.tag_list || '',
    likes: raw.likes_count ?? null,
    reposts: raw.reposts_count ?? null,
    comments: raw.comment_count ?? null,
    released: raw.display_date || raw.created_at || '',
    label: raw.label_name || raw.publisher_metadata?.publisher || '',
  };
}

export function normalizePlaylist(raw) {
  const playlist = raw.playlist || raw;
  return {
    kind: 'playlist',
    urn: urnOf('playlists', playlist),
    title: playlist.title || tr('Untitled'),
    owner: playlist.user?.username || '',
    ownerUrn: playlist.user?.urn || null,
    count: playlist.track_count ?? null,
    artwork: playlist.artwork_url || playlist.user?.avatar_url || '',
    link: playlist.permalink_url || '',
    duration: playlist.duration || 0,
  };
}

export function normalizeUser(raw) {
  return {
    kind: 'user',
    urn: urnOf('users', raw),
    name: raw.username || tr('Unknown'),
    avatar: raw.avatar_url || '',
    followers: raw.followers_count ?? null,
    tracks: raw.track_count ?? null,
    city: raw.city || '',
    link: raw.permalink_url || '',
  };
}

export function bigArt(src) {
  return src ? src.replace('-large.', '-t300x300.') : '';
}

export function smallArt(src) {
  return src ? src.replace('-large.', '-small.') : '';
}

/**
 * Loads a playlist's tracks a page at a time. api-v2 only fills in a playlist's first
 * few tracks, so the rest come by ID. The IDs come from the playlist already fetched,
 * so paging doesn't fetch it again, and the pages can't shift if it changes meanwhile.
 */
export function playlistPages(raw) {
  const ids = (raw?.tracks || []).map((t) => t.id);
  return async (start = 0) => {
    const end = Number(start) + PAGE;
    const wanted = ids.slice(Number(start), end);
    const tracks = wanted.length ? await api.get(url('/tracks', { ids: wanted.join(',') })) : [];
    const byId = new Map(tracks.map((t) => [t.id, t]));
    return {
      items: wanted.map((i) => byId.get(i)).filter(Boolean).map(normalizeTrack).filter(Boolean),
      next: end < ids.length ? end : null, // never 0, so it reads as "more to load"
    };
  };
}

/** Page of a linked-partitioning collection, normalised. */
export async function page(target, normalize) {
  const data = await api.get(target);
  const items = Array.isArray(data) ? data : data?.collection || [];
  return { items: items.map(normalize).filter(Boolean), next: data?.next_href || null };
}

const paged = (path, params = {}) => url(path, { limit: PAGE, linked_partitioning: true, ...params });

export const paths = {
  feed: () => paged('/stream'),
  recent: (limit = PAGE) => paged('/me/play-history/tracks', { limit }),
  likes: (limit = PAGE) => paged(`/users/${me}/track_likes`, { limit }),
  likeIds: () => url('/me/track_likes/ids', { limit: MAX_IDS }),
  myPlaylists: () => paged(`/users/${me}/playlists_without_albums`),
  followings: () => paged(`/users/${me}/followings`),
  followingIds: () => url(`/users/${me}/followings/ids`, { limit: MAX_IDS }),
  follow: (urn) => `/me/followings/${idOf(urn)}`,
  searchTracks: (q) => paged('/search/tracks', { q }),
  // The filter only matches lowercase genres, and needs q to be present.
  genre: (genre) => paged('/search/tracks', { q: '', 'filter.genre_or_tag': genre.toLowerCase() }),
  searchPlaylists: (q) => paged('/search/playlists', { q }),
  searchUsers: (q) => paged('/search/users', { q }),
  playlist: (urn) => `/playlists/${idOf(urn)}`,
  user: (urn) => `/users/${idOf(urn)}`,
  userTracks: (urn) => paged(`/users/${idOf(urn)}/tracks`),
  userPlaylists: (urn) => paged(`/users/${idOf(urn)}/playlists_without_albums`),
  userLikes: (urn) => paged(`/users/${idOf(urn)}/track_likes`),
  track: (urn) => `/tracks/${idOf(urn)}`,
  related: (urn) => paged(`/tracks/${idOf(urn)}/related`),
};

/** Feed entries hold a `track` or a `playlist`. Only tracks are listed. */
export function normalizeFeedItem(item) {
  return item?.track ? normalizeTrack(item.track) : null;
}
