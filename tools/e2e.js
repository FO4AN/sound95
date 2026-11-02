// End-to-end run inside the real webview, against the mock SoundCloud server.
// Audio comes from the real SoundCloud Widget, muted.
// Injected by debug builds when SOUND95_E2E points at this file; see tools/e2e.sh.
(async () => {
  const invoke = window.__TAURI__.core.invoke;
  // Reports go through the API bridge, which needs a logged-on session.
  const pending = [];
  const log = async (m) => {
    try {
      await invoke('api_get', { target: `/__report?m=${encodeURIComponent(m)}` });
    } catch {
      pending.push(m);
    }
  };
  let failures = 0;
  const pass = (m) => log(`PASS ${m}`);
  const fail = (m) => { failures += 1; return log(`FAIL ${m}`); };

  window.addEventListener('error', (e) => fail(`js error: ${e.message} at ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => fail(`rejection: ${e.reason?.message || JSON.stringify(e.reason)}`));

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, what, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(50);
    }
  };
  const check = async (fn, name, ms) => {
    try { await waitFor(fn, name, ms); await pass(name); } catch (e) { await fail(e.message); }
  };
  const byText = (sel, text) => $$(sel).find((n) => n.textContent.trim().startsWith(text));
  const clickText = async (sel, text) => (await waitFor(() => byText(sel, text), `"${text}"`)).click();
  const dbl = (n) => n.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const context = (n) => n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }));
  const overflow = () => { const c = $('#content'); return c.scrollWidth > c.clientWidth + 1; };
  const search = async (q) => { $('#search-box').value = q; $('#search-go').click(); };
  const seconds = () => { const [m, s] = $('#time-now').textContent.split(':').map(Number); return m * 60 + s; };
  const flush = async () => { for (const m of pending.splice(0)) await log(m); };

  try {
    // Muted before anything can play.
    $('#volume').value = 0;
    $('#volume').dispatchEvent(new Event('input'));

    await waitFor(() => $('.dialog'), 'first dialog', 15000);
    await check(() => byText('.dialog .titlebar-text', 'Log In'), 'first launch goes straight to logon, with no setup');

    await clickText('.dialog button', 'Cancel');
    await check(() => !$('.dialog') && byText('.empty', 'Log in to SoundCloud'), 'cancelling shows a log in prompt');
    await search('modem');
    await check(() => byText('.empty', 'Log in to search'), 'search asks for logon when logged off');

    await clickText('.empty button', 'Log In');
    await clickText('.dialog button', 'Log In');
    await waitFor(() => $('.marquee'), 'waiting state');
    await clickText('.dialog button', 'Cancel');
    await check(() => !$('.marquee') && byText('.dialog p', 'Log in with'), 'cancelling mid-logon returns to the dialog');
    await sleep(300);
    await clickText('.dialog button', 'Log In');
    await check(() => $('#account-button').textContent.includes('flint95'), 'signing in on the SoundCloud page logs in', 15000);
    await flush();
    await check(() => byText('.tree-item', 'Late Shift'), 'playlists sync into the sidebar');
    await check(() => byText('.greeting', 'Welcome back, flint95'), 'home greets the user');
    await check(() => byText('.shelf-title', 'New from People You Follow') && $$('.row').length > 8, 'home shows the feed');

    await clickText('.tree-item', 'Discover');
    await check(() => byText('.genres button', 'House'), 'discover lists genres');
    await check(() => byText('.shelf-title', 'Because You Played') && $$('.row').length >= 10, 'discover recommends from history');
    await log('SHOT discover');
    await sleep(1500);
    await clickText('.genres button', 'House');
    await check(() => byText('.hero-title', 'House') && $$('.row').length, 'genre page');

    await search('modem');
    await waitFor(() => $$('.row').length === 50, 'search rows');
    await clickText('.more button', 'More');
    await check(() => $$('.row').length === 80, 'More loads the next page through next_href');
    await check(() => !overflow(), 'long title does not overflow the pane');
    await check(() => $$('.badge').some((b) => b.textContent === 'Preview') && $$('.badge').some((b) => b.textContent === 'Blocked'), 'preview and blocked tracks are labelled');

    await clickText('.tab', 'People');
    await check(() => byText('.tile-name', 'Night Modem'), 'people tab');
    await clickText('.tab', 'Playlists');
    await check(() => byText('.tile-name', 'Late Shift'), 'playlists tab');
    $('#nav-back').click();
    await check(() => byText('.tile-name', 'Night Modem'), 'back button restores people');
    $('#nav-back').click();
    await waitFor(() => $$('.row').length, 'rows after back');

    // Real playback through the hidden Widget.
    dbl($$('.row')[0]);
    await check(() => $('#np-title').textContent === 'Dial-Up Lullaby', 'double click loads the now-playing bar');
    await check(() => {
      const box = $('#widget-slot iframe')?.getBoundingClientRect();
      return box && box.right <= 0;
    }, 'SoundCloud player stays out of sight');
    await check(() => seconds() >= 3, 'real audio advances while hidden', 20000);
    await check(() => $('#tp-play').getAttribute('aria-label') === 'Pause', 'player bar shows playing');
    await log('SHOT playing');
    await sleep(1500);
    $('#seek').value = 500;
    $('#seek').dispatchEvent(new Event('input'));
    $('#seek').dispatchEvent(new Event('change'));
    await check(() => seconds() > 60, 'seek bar jumps within the track', 10000);
    $('#tp-play').click();
    await check(() => $('#tp-play').getAttribute('aria-label') === 'Play', 'pause', 5000);
    $('#tp-play').click();
    await check(() => $('#tp-play').getAttribute('aria-label') === 'Pause', 'resume', 5000);
    $('#tp-next').click();
    await check(() => $('#np-title').textContent === 'Blue Screen Sunrise', 'next track');
    await check(() => $('#tp-play').getAttribute('aria-label') === 'Pause' && seconds() < 30, 'next track plays', 15000);
    await check(() => $$('.q-item').length === 49 && $('.q-item.current'), 'Up Next excludes the blocked track and marks current');

    $('#tp-repeat').click();
    await check(() => $('#tp-repeat').classList.contains('on'), 'repeat toggles');
    $('#tp-shuffle').click();
    await check(() => $('#tp-shuffle').classList.contains('on') && $('.q-item.current') === $('.q-item'), 'shuffle keeps the current track first');
    $('#tp-shuffle').click();
    $('#tp-repeat').click();
    $('#tp-repeat').click();

    const row = $$('.row')[4];
    row.querySelector('.heart').click();
    await check(() => row.querySelector('.heart svg'), 'like shows a heart');
    await check(() => byText('#status', 'Added'), 'like reaches SoundCloud', 6000);

    context($$('.row')[30]);
    await clickText('.menu-item', 'Add to Playlist');
    await clickText('.dialog .menu-item', 'Boot Sector Ballads');
    await check(() => byText('#status', 'Added "'), 'add to playlist');

    byText('.menu-title', 'Help').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await clickText('.menu-item', 'About Sound95');
    await check(() => byText('.dialog .titlebar-text', 'About'), 'about dialog from the Help menu');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await check(() => !$('.dialog'), 'Esc closes dialogs');
    $('#start-button').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await check(() => $('.start-menu') && byText('.start-menu .menu-item', 'Log Off'), 'start menu');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(50);

    await clickText('.tree-item', 'Late Shift');
    await check(() => byText('.hero-title', 'Late Shift') && $$('.row').length === 12, 'playlist page');
    await clickText('.tree-item', 'Liked Tracks');
    await check(() => byText('.hero-title', 'Liked Tracks'), 'liked tracks page');
    (await waitFor(() => $('.row button.link'), 'artist link')).click();
    await check(() => $('.hero-kind')?.textContent === 'Artist', 'artist page');
    const follow = await waitFor(() => {
      const b = byText('.hero-actions button', 'Follow') || byText('.hero-actions button', 'Unfollow');
      return b && !b.disabled && b;
    }, 'follow button');
    const before = follow.textContent;
    follow.click();
    await check(() => follow.textContent !== before, 'follow toggles');
    await clickText('.tree-item', 'Following');
    await check(() => $$('.tile').length > 0, 'following page');
    await search('nothing');
    await check(() => byText('.empty', 'No tracks found'), 'empty search state');

    // Sessions last about a day, so an expired one must renew without a prompt,
    // even when several requests hit it at once.
    await invoke('api_get', { target: '/__expire' });
    const renewed = await Promise.all([1, 2, 3].map(() => invoke('api_get', { target: '/me' }).catch((e) => e)));
    await check(() => renewed.every((r) => r.username === 'flint95'), 'an expired session renews silently');
    await check(() => !$$('.dialog').length, 'renewing shows no prompt');

    // When SoundCloud won't renew it, the login ends instead of failing quietly.
    await invoke('api_get', { target: '/__revoke' });
    const rejected = await invoke('api_get', { target: '/me' }).catch((e) => e.code);
    const afterRejection = await invoke('status');
    await check(() => rejected === 'session_expired' && !afterRejection.logged_on, 'a revoked session is forgotten');

    // Log off, then log back on so the results can be reported.
    byText('.menu-title', 'File').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await clickText('.menu-item', 'Log Off');
    await check(() => $('#account-button').textContent.includes('Log In'), 'log off returns to the logged-off state');
    await check(() => byText('.empty', 'Log in to SoundCloud'), 'logged-off home prompts to log in');
    $('#account-button').click();
    await clickText('.dialog button', 'Log In');
    await check(() => $('#account-button').textContent.includes('flint95'), 'can log back on', 15000);
    await flush();
    const signIn = await invoke('api_get', { target: '/__signin' });
    await check(() => signIn.ipc === 'refused', 'the sign-in page cannot call the app');
    await check(() => signIn.leftover === false, 'logging off clears the SoundCloud session');
    await log(`RESULT failures=${failures}`);
  } catch (e) {
    await fail(`aborted: ${e.message}`);
    await log(`DOM ${document.body.innerText.slice(0, 300)}`);
    await log(`RESULT failures=${failures}`);
  }
})();
