// Who is logged in, plus the likes and playlists that many views need.

import { tr } from './i18n.js';
import { api, normalizePlaylist, page, paths, setMe, trackUrn } from './api.js';
import { errorText, setStatus } from './dom.js';

export const session = {
  user: null,
  liked: new Set(),
  playlists: [],
};

const WATCH_EVERY_MS = 3000;

const listeners = new Set();
let watching = 0; // only the newest like window is watched
export function onSessionChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emitChange() { listeners.forEach((fn) => fn()); }

export async function loadSession() {
  const status = await api.status();
  session.user = null;
  session.liked = new Set();
  session.playlists = [];
  setMe(null);
  try {
    if (status.logged_on) {
      session.user = await api.get('/me');
      setMe(session.user);
      const [likes, playlists] = await Promise.allSettled([
        api.get(paths.likeIds()),
        page(paths.myPlaylists(), normalizePlaylist),
      ]);
      if (likes.status === 'fulfilled') session.liked = new Set(likes.value.collection.map(trackUrn));
      if (playlists.status === 'fulfilled') session.playlists = playlists.value.items;
    }
  } finally {
    emitChange();
  }
  return status;
}

export function isLiked(track) {
  return !!track && session.liked.has(track.urn);
}

const fetchLiked = async () => new Set((await api.get(paths.likeIds())).collection.map(trackUrn));

/**
 * SoundCloud's bot check turns away likes sent by an app, so the heart opens the track's
 * own page for you to click Like on, and this watches for that to reach your account.
 */
export async function toggleLike(track) {
  if (!session.user) {
    setStatus(tr('Log in to like tracks.'));
    return;
  }
  const mine = ++watching;
  const was = isLiked(track);
  try {
    await api.openTrackPage(track.link);
    setStatus(tr('Click Like on the SoundCloud page.'), { sticky: true });
    let open = true;
    while (open && mine === watching && isLiked(track) === was) {
      await new Promise((done) => { setTimeout(done, WATCH_EVERY_MS); });
      open = await api.trackPageOpen();
      if (mine !== watching) return;
      session.liked = await fetchLiked().catch(() => session.liked);
    }
    if (mine !== watching) return;
    await api.closeTrackPage();
    emitChange();
    if (isLiked(track) === was) setStatus(tr('Ready'));
    else setStatus(was ? tr('Removed "{title}" from Liked Tracks', { title: track.title }) : tr('Added "{title}" to Liked Tracks', { title: track.title }));
  } catch (e) {
    setStatus(errorText(e));
  }
}
