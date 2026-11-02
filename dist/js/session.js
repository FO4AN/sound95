// Who is logged in, plus the likes and playlists that many views need.

import { api, normalizePlaylist, page, paths, setMe, trackUrn } from './api.js';
import { errorText, setStatus } from './dom.js';

export const session = {
  user: null,
  liked: new Set(),
  unliked: new Set(),
  playlists: [],
};

const listeners = new Set();
export function onSessionChange(fn) { listeners.add(fn); }
export function emitChange() { listeners.forEach((fn) => fn()); }

export async function loadSession() {
  const status = await api.status();
  session.user = null;
  session.liked = new Set();
  session.unliked = new Set();
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
  if (!track) return false;
  if (session.unliked.has(track.urn)) return false;
  return session.liked.has(track.urn);
}

export async function toggleLike(track) {
  if (!session.user) {
    setStatus('Log in to like tracks.');
    return;
  }
  const was = isLiked(track);
  const apply = (liked) => {
    if (liked) { session.liked.add(track.urn); session.unliked.delete(track.urn); }
    else { session.liked.delete(track.urn); session.unliked.add(track.urn); }
    emitChange();
  };
  apply(!was);
  try {
    await api.send(was ? 'DELETE' : 'PUT', paths.like(track.urn));
    setStatus(was ? `Removed "${track.title}" from Liked Tracks` : `Added "${track.title}" to Liked Tracks`);
  } catch (e) {
    apply(was);
    setStatus(errorText(e));
  }
}
