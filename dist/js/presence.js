// Tells Discord what's playing, when that's switched on in Settings.

import { tr } from './i18n.js';
import { api } from './api.js';
import { durationMs, livePositionMs, onPlayerChange, player } from './player.js';

const STORE_KEY = 'sound95.discord';
const SAME_WITHIN_MS = 5000;

let last = null;

export function discordOn() {
  try { return localStorage.getItem(STORE_KEY) === '1'; } catch { return false; }
}

function playing() {
  const track = player.current;
  if (!track || !player.playing) return null;
  const startedAt = Date.now() - livePositionMs();
  const total = durationMs();
  return {
    title: track.title,
    artist: track.artist,
    link: track.link || '',
    artwork: track.artwork || '',
    listen: tr('Open on SoundCloud'),
    startedAt: Math.floor(startedAt / 1000),
    endsAt: total ? Math.floor((startedAt + total) / 1000) : null,
  };
}

function publish() {
  const enabled = discordOn();
  const now = enabled ? playing() : null;
  // The player reports far more often than anything worth telling Discord changes.
  const key = enabled && (now ? `${player.current.urn}:${Math.round((now.startedAt * 1000) / SAME_WITHIN_MS)}` : 'nothing');
  if (key === last) return;
  last = key;
  api.discordUpdate(enabled, now).catch(() => { last = null; });
}

export function setDiscordOn(on) {
  try { localStorage.setItem(STORE_KEY, on ? '1' : '0'); } catch { /* optional */ }
  publish();
}

onPlayerChange(publish);
