// Holds the SoundCloud client secret so it never ships in the app. SoundCloud
// requires the secret on token requests, so the app sends those here and this
// adds it. It only completes the logins and refreshes Sound95 itself makes.

const SOUNDCLOUD_AUTH = 'https://secure.soundcloud.com';
const REDIRECT_URI = 'http://127.0.0.1:17995/callback';
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

function buildTokenForm(input, env) {
  const form = new URLSearchParams({
    client_id: env.SOUND95_CLIENT_ID,
    client_secret: env.SOUND95_CLIENT_SECRET,
  });
  const grant = input.get('grant_type');
  form.set('grant_type', grant);
  if (grant === 'authorization_code') {
    if (!input.get('code') || !input.get('code_verifier') || input.get('redirect_uri') !== REDIRECT_URI) return null;
    form.set('code', input.get('code'));
    form.set('code_verifier', input.get('code_verifier'));
    form.set('redirect_uri', REDIRECT_URI);
    return form;
  }
  if (grant === 'refresh_token' && input.get('refresh_token')) {
    form.set('refresh_token', input.get('refresh_token'));
    return form;
  }
  return null;
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname === '/config') {
      return reply(200, { client_id: env.SOUND95_CLIENT_ID });
    }
    if (request.method === 'POST' && pathname === '/token') {
      const input = new URLSearchParams(await request.text());
      const form = buildTokenForm(input, env);
      if (!form) return reply(400, { error: 'invalid_request' });
      const upstream = await fetch(`${env.AUTH_BASE || SOUNDCLOUD_AUTH}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json; charset=utf-8' },
        body: form,
      });
      return new Response(await upstream.text(), { status: upstream.status, headers: JSON_HEADERS });
    }
    return reply(404, { error: 'not_found' });
  },
};
