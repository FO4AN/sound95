// Stand-in for SoundCloud, for testing Sound95 without a real account. Copies the
// parts of api-v2 and the website that the app depends on, quirks included:
// playlists have no urn and only fill in their first five tracks, the genre filter
// only matches lowercase, and pages hand out sessions to whoever has the refresh
// cookie. Every API request must carry "Authorization: OAuth <token>".
//
//   node tools/mock-soundcloud.mjs            # port 17996
//   SOUND95_API_BASE=http://127.0.0.1:17996 SOUND95_SIGNIN_URL=http://127.0.0.1:17996/signin \
//     SOUND95_RENEW_URL=http://127.0.0.1:17996/ cargo run     # debug builds only

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 17996);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const log = [];
const access = new Set();
const refresh = new Set();
const signIn = { ipc: null, leftover: null }; // what the last sign-in page saw
const likes = new Set();
const follows = new Set([2]);

const user = (id, name, extra = {}) => ({
  id, urn: `soundcloud:users:${id}`, kind: 'user', username: name, avatar_url: '',
  followers_count: id * 1234, track_count: id * 3, city: 'Tallinn',
  permalink_url: `https://soundcloud.com/${name.toLowerCase().replaceAll(' ', '-')}`, ...extra,
});
const USERS = [user(1, 'Night Modem'), user(2, 'Tape Deck Tuesday'), user(3, 'Cassandra Vale'), user(4, 'DJ Floppy')];
const ME = { ...user(9, 'flint95'), plan: 'Free' };

const TITLES = [
  'Dial-Up Lullaby', 'Blue Screen Sunrise', 'Defrag (Slow Version)', 'Screensaver Pipes',
  'A Very Long Title That Should Be Truncated Politely By The Details List Without Overflowing Anything At All',
  'Clippy Was Right', 'Hard Drive Heartbeat', 'Recycle Bin Blues', 'Start Me Up (Tape Rip Mood)', 'Minesweeper Nights',
  'Solitaire Cascade', 'CRT Glow', 'Paintbrush', 'Autoexec', 'Sound Recorder 60s Limit', 'Pinball Table',
];
// The first two are real public tracks, so the real Widget player can load them.
const REAL_IDS = [2408461857, 1192797721];
const track = (i) => {
  const id = REAL_IDS[i] ?? i + 1;
  return {
    id, urn: `soundcloud:tracks:${id}`, kind: 'track', title: TITLES[i % TITLES.length],
    duration: 120000 + i * 17000, user: USERS[i % USERS.length], artwork_url: '',
    playback_count: 500 + i * i * 3127, access: null, policy: i === 6 ? 'SNIP' : i === 7 ? 'BLOCK' : 'ALLOW',
    permalink_url: `https://soundcloud.com/mock/track-${i + 1}`,
  };
};
const TRACKS = Array.from({ length: 80 }, (_, i) => track(i));
likes.add(TRACKS[0].id).add(TRACKS[2].id);
const playlists = [
  { id: 1, title: 'Late Shift', ids: TRACKS.slice(0, 12).map((t) => t.id), duration: 4000000, link: 'late-shift' },
  { id: 2, title: 'Boot Sector Ballads', ids: TRACKS.slice(20, 25).map((t) => t.id), duration: 900000, link: 'boot' },
];
const playlistJson = (p) => ({
  id: p.id, kind: 'playlist', title: p.title, user: ME, track_count: p.ids.length, duration: p.duration, artwork_url: '',
  permalink_url: `https://soundcloud.com/mock/sets/${p.link}`,
  tracks: p.ids.map((id, i) => (i < 5 ? TRACKS.find((t) => t.id === id) : { id, kind: 'track' })),
});

function collection(items, url, limit = 50) {
  const offset = Number(url.searchParams.get('offset') || 0);
  const size = Number(url.searchParams.get('limit') || limit);
  const slice = items.slice(offset, offset + size);
  let next_href = null;
  if (offset + size < items.length) {
    const nextUrl = new URL(url, ORIGIN);
    nextUrl.searchParams.set('offset', offset + size);
    next_href = nextUrl.href;
  }
  return { collection: slice, next_href, query_urn: null };
}

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const html = (res, body, headers = {}) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
};
const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString()));
});
const secret = (prefix) => `${prefix}_${randomBytes(8).toString('hex')}`;
const cookie = (req, name) => (req.headers.cookie || '').split('; ').find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);

function sessionCookies() {
  const token = secret('at');
  const renewal = secret('rt');
  access.add(token);
  refresh.add(renewal);
  return [`oauth_token=${token}; Path=/`, `oauth_refresh_token=${renewal}; Path=/; HttpOnly`];
}

// The real page waits for a person. This one waits just long enough to be
// cancelled, and tries to reach the app the way a hostile page would.
const SIGN_IN_PAGE = `<!doctype html><title>Sign in</title><p>Signing in...</p><script>
setTimeout(async () => {
  let ipc = 'refused';
  try { await window.__TAURI_INTERNALS__.invoke('status'); ipc = 'allowed'; } catch {}
  location.href = '/signin/done?ipc=' + ipc;
}, 1200);
</script>`;

function bearer(req) {
  const match = /^OAuth (.+)$/.exec(req.headers.authorization || '');
  return match ? access.has(match[1]) : false;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const path = decodeURIComponent(url.pathname);
  const raw = await readBody(req);
  log.push({ method: req.method, path, auth: (req.headers.authorization || '').split(' ')[0], body: raw.slice(0, 300) });

  if (path === '/__log') return json(res, 200, log);
  if (path === '/__report') { console.log('E2E', url.searchParams.get('m')); return json(res, 200, {}); }
  if (path === '/__expire') { access.clear(); return json(res, 200, { ok: true }); }
  if (path === '/__revoke') { access.clear(); refresh.clear(); return json(res, 200, { ok: true }); }
  if (path === '/__signin') return json(res, 200, signIn);

  if (path === '/signin') {
    signIn.leftover = !!cookie(req, 'oauth_token') || !!cookie(req, 'oauth_refresh_token');
    return html(res, SIGN_IN_PAGE);
  }
  if (path === '/signin/done') {
    signIn.ipc = url.searchParams.get('ipc');
    return html(res, '<!doctype html><p>Signed in</p>', { 'Set-Cookie': sessionCookies() });
  }
  // Any website page renews a session, and only for a visitor without one.
  if (path === '/') {
    const renewal = cookie(req, 'oauth_refresh_token');
    if (!cookie(req, 'oauth_token') && refresh.delete(renewal)) {
      return html(res, '<!doctype html><p>Home</p>', { 'Set-Cookie': sessionCookies() });
    }
    return html(res, '<!doctype html><p>Home</p>');
  }

  if (!bearer(req)) return json(res, 401, { error: 'unauthorized' });

  const m = (re) => re.exec(path);
  const others = (id) => (Number(id) === ME.id ? USERS : TRACKS);
  let match;

  if (req.method === 'GET') {
    if (path === '/me') return json(res, 200, ME);
    if (path === '/stream') {
      const items = TRACKS.slice(10, 40).map((t, i) => (i % 2 ? { type: 'track-repost', track: t } : { type: 'track', track: t }));
      return json(res, 200, collection([{ type: 'playlist', playlist: playlistJson(playlists[0]) }, ...items], url));
    }
    if (path === '/me/play-history/tracks') return json(res, 200, collection(TRACKS.slice(2, 12).map((t) => ({ played_at: 1, track: t, track_id: t.id })), url));
    if (path === '/me/track_likes/ids') return json(res, 200, collection([...likes], url));
    if (path === '/tracks') {
      const ids = (url.searchParams.get('ids') || '').split(',').map(Number);
      if (ids.length > 50) return json(res, 400, { error: 'too many ids' });
      return json(res, 200, TRACKS.filter((t) => ids.includes(t.id)).reverse());
    }
    if (path === '/search/tracks') {
      if (!url.searchParams.has('q')) return json(res, 200, collection([], url));
      const genre = url.searchParams.get('filter.genre_or_tag');
      if (genre && genre !== genre.toLowerCase()) return json(res, 200, collection([], url));
      return json(res, 200, collection(url.searchParams.get('q') === 'nothing' ? [] : TRACKS, url));
    }
    if (path === '/search/playlists') return json(res, 200, collection(playlists.map(playlistJson), url));
    if (path === '/search/users') return json(res, 200, collection(USERS, url));
    if ((match = m(/^\/tracks\/(\d+)\/related$/))) return json(res, 200, collection(TRACKS.slice(30, 40), url));
    if ((match = m(/^\/playlists\/(\d+)$/))) {
      const p = playlists.find((x) => x.id === Number(match[1]));
      return p ? json(res, 200, playlistJson(p)) : json(res, 404, {});
    }
    if ((match = m(/^\/users\/(\d+)\/track_likes$/))) {
      const liked = Number(match[1]) === ME.id ? TRACKS.filter((t) => likes.has(t.id)) : TRACKS.slice(0, 7);
      return json(res, 200, collection(liked.map((t) => ({ created_at: '2026/11/02', kind: 'like', track: t })), url));
    }
    if ((match = m(/^\/users\/(\d+)\/tracks$/))) return json(res, 200, collection(TRACKS.slice(0, 7), url));
    if ((match = m(/^\/users\/(\d+)\/playlists_without_albums$/))) return json(res, 200, collection(playlists.map(playlistJson), url));
    if ((match = m(/^\/users\/(\d+)\/followings\/ids$/))) return json(res, 200, collection([...follows], url));
    if ((match = m(/^\/users\/(\d+)\/followings$/))) return json(res, 200, collection(others(match[1]).filter((u) => follows.has(u.id)), url));
    if ((match = m(/^\/users\/(\d+)$/))) {
      const u = USERS.find((x) => x.id === Number(match[1])) || (Number(match[1]) === ME.id ? ME : null);
      return u ? json(res, 200, u) : json(res, 404, {});
    }
  }

  if ((match = m(/^\/users\/(\d+)\/track_likes\/(\d+)$/))) {
    if (Number(match[1]) !== ME.id) return json(res, 403, {});
    if (req.method === 'PUT') likes.add(Number(match[2]));
    else if (req.method === 'DELETE') likes.delete(Number(match[2]));
    else return json(res, 405, {});
    return json(res, 200, { status: 'ok' });
  }
  if ((match = m(/^\/me\/followings\/(\d+)$/))) {
    if (req.method === 'POST') follows.add(Number(match[1]));
    else if (req.method === 'DELETE') follows.delete(Number(match[1]));
    else return json(res, 405, {});
    return json(res, 200, USERS[0]);
  }
  if (path === '/playlists' && req.method === 'POST') {
    const body = JSON.parse(raw || '{}').playlist || {};
    const created = { id: playlists.length + 1, title: body.title, ids: body.tracks || [], duration: 0, link: 'new' };
    playlists.push(created);
    return json(res, 201, playlistJson(created));
  }
  if ((match = m(/^\/playlists\/(\d+)$/)) && req.method === 'PUT') {
    const p = playlists.find((x) => x.id === Number(match[1]));
    if (!p) return json(res, 404, {});
    const body = JSON.parse(raw || '{}').playlist || {};
    if (body.tracks) {
      if (!body.tracks.every(Number.isInteger)) return json(res, 400, { error: 'tracks must be ids' });
      p.ids = body.tracks;
    }
    return json(res, 200, playlistJson(p));
  }

  return json(res, 404, { error: 'mock has no such route', path });
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock SoundCloud on ${ORIGIN}`));
