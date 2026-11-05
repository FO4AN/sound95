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

  // SoundCloud's script throws when a late message arrives from a Widget that was replaced.
  // Our own scripts report real details, so that's the only thing this wording can be.
  window.addEventListener('error', (e) => e.message !== 'Script error.' && fail(`js error: ${e.message} at ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => fail(`rejection: ${e.reason?.message || JSON.stringify(e.reason)}`));

  // This runs on someone's desktop, and a stray real click would change what's being tested.
  document.documentElement.style.pointerEvents = 'none';
  document.addEventListener('click', (e) => { if (e.isTrusted) log(`INFO real click on ${e.target.tagName}.${e.target.className}`); }, true);

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

    // The first time in, a welcome offers a choice of look, tried on the spot.
    const skin = () => document.documentElement.dataset.skin;
    await check(() => byText('.welcome h1', 'Welcome to Sound95, flint95'), 'the first logon shows a welcome');
    await log('SHOT welcome');
    await sleep(800);
    await clickText('.welcome button', 'Continue');
    await check(() => $$('.look-card').length === 10, 'the welcome offers every look');
    $('.look-card[data-look="modern"]').click();
    const branded = () => getComputedStyle($('.brand')).display !== 'none';
    await check(() => skin() === 'modern' && $('#tp-play svg.ic') && branded(), 'picking Modern restyles the app at once');
    await log('SHOT welcome-modern');
    await sleep(1000);
    $('.look-card[data-look="light"]').click();
    await check(() => skin() === 'classic' && $('#tp-play svg.px') && !branded(), 'picking a Windows look puts it back');
    await clickText('.welcome button', 'Continue');
    await clickText('.welcome button', 'Get Started');
    await check(() => !$('.welcome') && localStorage.getItem('sound95.welcomed') === '1', 'the welcome ends and is not shown again');

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
      const slot = getComputedStyle($('#widget-slot'));
      return $('#widget-slot iframe') && Number(slot.opacity) < 0.05 && slot.pointerEvents === 'none' && Number(slot.zIndex) < 0;
    }, 'SoundCloud player stays out of sight');
    await check(() => seconds() >= 3, 'real audio advances while hidden', 20000);
    await check(() => $('#tp-play').getAttribute('aria-label') === 'Pause', 'player bar shows playing');
    // WebKit throttles an off-screen player to one report a second, which breaks karaoke.
    let reports = 0;
    window.SC.Widget($('#widget-slot iframe')).bind(window.SC.Widget.Events.PLAY_PROGRESS, () => { reports += 1; });
    await sleep(2000);
    await check(() => reports >= 16, 'the player reports its position many times a second');
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

    // Karaoke follows whatever plays, and each track here gets a different kind of result.
    const stageText = () => $('.k-stage')?.innerText || '';
    const floatStatus = (name) => $$('.float').find((w) => w.querySelector('.titlebar-text').textContent === name)?.querySelector('.status-cell').textContent || '';
    const floatMenu = async (name, item) => {
      byText('.float .menu-title', name).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await clickText('.menu-item', item);
    };
    const sung = () => $$('.k-line.current .k-word').some((w) => parseFloat(w.style.getPropertyValue('--fill')) > 0);
    $('#karaoke-toggle').click();
    await check(() => floatStatus('Karaoke').startsWith('NetEase - timed word by word'), 'karaoke uses word timing when it exists', 15000);
    await log(`INFO ${floatStatus('Karaoke')}`);
    await check(() => $('.k-line.current') && sung(), 'karaoke wipes through the words', 15000);
    await log('SHOT karaoke');

    // Dragging, with events shaped like a real pointer's.
    const karaoke = () => $$('.float').find((w) => w.querySelector('.titlebar-text').textContent === 'Karaoke');
    const titleBar = () => karaoke().querySelector('.titlebar');
    const pointer = (type, x, y, buttons = 1) => new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons, clientX: x, clientY: y });
    const nextFrame = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const at = () => { const { left, top } = karaoke().getBoundingClientRect(); return [Math.round(left), Math.round(top)]; };
    const drag = async (x, y, end) => {
      const [left, top] = at();
      titleBar().dispatchEvent(pointer('pointerdown', left + 40, top + 8));
      for (let step = 1; step <= 5; step++) window.dispatchEvent(pointer('pointermove', left + 40 + (x * step) / 5, top + 8 + (y * step) / 5));
      await nextFrame();
      const moved = at();
      const ok = moved[0] === left + x && moved[1] === top + y;
      window.dispatchEvent(end);
      await nextFrame();
      return ok;
    };
    await check(() => drag(-30, 24, pointer('pointerup', 0, 0, 0)), 'the title bar drags the window, a frame later at most');
    const released = at();
    window.dispatchEvent(pointer('pointermove', released[0] + 90, released[1] + 90));
    await nextFrame();
    await check(() => at().join() === released.join(), 'letting go ends the drag');
    await check(() => drag(12, -9, pointer('pointercancel', 0, 0, 0)), 'a drag follows the pointer until it is cancelled');
    const cancelled = at();
    window.dispatchEvent(pointer('pointermove', cancelled[0] + 90, cancelled[1] + 90));
    await nextFrame();
    await check(() => at().join() === cancelled.join(), 'a cancelled drag stops following');
    // A release outside the window never arrives; the next move has no button held.
    await check(() => drag(-5, 5, pointer('pointermove', 400, 400, 0)), 'a drag follows the pointer again');
    const lost = at();
    window.dispatchEvent(pointer('pointermove', lost[0] + 90, lost[1] + 90));
    await nextFrame();
    await check(() => at().join() === lost.join(), 'a lost release cannot leave the window stuck to the pointer');
    const { width, height } = karaoke().getBoundingClientRect();
    karaoke().querySelector('.grip').dispatchEvent(pointer('pointerdown', 500, 500));
    window.dispatchEvent(pointer('pointermove', 520, 510));
    await nextFrame();
    window.dispatchEvent(pointer('pointerup', 520, 510, 0));
    await check(() => {
      const size = karaoke().getBoundingClientRect();
      return Math.round(size.width - width) === 20 && Math.round(size.height - height) === 10;
    }, 'the grip resizes by as much as the pointer moved');
    await sleep(1500);
    dbl($$('.row')[0]);
    await check(() => floatStatus('Karaoke').startsWith('LRCLIB - timed by line'), 'karaoke follows the next track, through a 503', 20000);
    await check(() => {
      const shown = /Timed line (\d+)/.exec($('.k-line.current')?.textContent || '');
      return shown && seconds() > 1 && Math.abs(Number(shown[1]) - (seconds() - 1) / 2) <= 1.5;
    }, 'the current line matches the playback position', 15000);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ']', bubbles: true }));
    await check(() => floatStatus('Karaoke').includes('+0.25s'), 'timing can be nudged');
    await floatMenu('Lyrics', 'Find Lyrics');
    await check(() => $$('.pick').length >= 1, 'Find Lyrics lists results');
    await clickText('.dialog button', 'Cancel');
    dbl($$('.row')[2]);
    await check(() => floatStatus('Karaoke').startsWith('Genius - estimated timing'), 'karaoke falls back to plain lyrics with guessed timing', 15000);
    await check(() => stageText().includes('Plain') || stageText().includes('♪'), 'plain lyrics show on stage');
    dbl($$('.row')[3]);
    await check(() => stageText().includes('No lyrics found'), 'a track with no lyrics says so', 15000);
    await clickText('.k-buttons button', 'Paste Lyrics');
    (await waitFor(() => $('textarea.paste'), 'paste box')).value = 'One\nTwo\nThree';
    await clickText('.dialog button', 'OK');
    await check(() => floatStatus('Karaoke').startsWith('You'), 'pasted lyrics are used');
    await floatMenu('Lyrics', 'Tap to Sync');
    for (const expected of ['One', 'Two', 'Three']) {
      await check(() => $('.k-tap')?.textContent === expected, `tap to sync shows "${expected}"`);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    }
    await check(() => floatStatus('Karaoke').includes('your timing'), 'tapped timing is kept');
    $('#karaoke-toggle').click();
    await check(() => !$$('.float').length && !$('#karaoke-toggle').classList.contains('on'), 'the karaoke window closes');

    // Real audio, quietly: a muted stream has nothing to analyse.
    $('#volume').value = 1;
    $('#volume').dispatchEvent(new Event('input'));
    await sleep(3000); // the mock's unplayable tracks finish skipping
    dbl($$('.row')[0]);
    // The Widget fetches it from SoundCloud, which a build machine sometimes waits on past
    // the player's start timeout, and the queue moves on. One more go before giving up.
    const realTrack = () => $('#np-title').textContent === 'Dial-Up Lullaby' && seconds() >= 2;
    if (!(await waitFor(realTrack, 'a real track playing', 20000).catch(() => false))) {
      await log(`INFO the real track did not start (${$('#status').textContent}), trying again`);
      dbl($$('.row')[0]);
      await waitFor(realTrack, 'a real track playing', 30000);
    }
    // Bars that follow the volume all but vanish at 1%; that's checked further down.
    const viz = await import('./js/visualizer.js');
    viz.setFollowsVolume(false);
    $('#viz-toggle').click();
    // A Windows build machine has no sound card, so it can only follow the loudness.
    const heard = navigator.userAgent.includes('Windows') ? /Live audio|Track loudness/ : /Live audio/;
    await check(() => heard.test(floatStatus('Visualizer')), 'the visualizer hears the real audio', 10000);
    const brightPixels = () => {
      const canvas = $('.viz-canvas');
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let bright = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 200) bright += 1;
      return bright;
    };
    // Lit green LEDs, not the white peak caps, and they have to change.
    const greens = () => {
      const canvas = $('.viz-canvas');
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      const lit = [];
      for (let i = 0; i < data.length; i += 4) if (data[i] === 0 && data[i + 1] === 255 && data[i + 2] === 0) lit.push(i);
      return lit;
    };
    await check(() => greens().length > 200, 'bars rise with the music', 15000);
    await log(`INFO ${floatStatus('Visualizer')}, ${greens().length} lit`);
    await log(`CPU-WINDOW-START`);
    const litBefore = greens().join();
    await sleep(600);
    await check(() => greens().join() !== litBefore, 'bars move with the music', 3000);
    // At 1% volume, bars that follow the volume stand much lower.
    const average = async () => { let sum = 0; for (let i = 0; i < 10; i++) { sum += greens().length; await sleep(150); } return sum / 10; };
    const filled = await average();
    viz.setFollowsVolume(true);
    await sleep(1500);
    const followed = await average();
    await log(`INFO bars ${Math.round(filled)} lit filling the display, ${Math.round(followed)} following the volume`);
    await check(() => followed < filled * 0.8, 'at a low volume the bars stand lower');
    await log('SHOT visualizer');
    await sleep(6000);
    await log(`CPU-WINDOW-END`);
    for (const mode of ['Oscilloscope', 'Mystify', 'Starfield', 'VU Meters', 'Waterfall', 'Sunburst', 'Plasma', '3D Pipes', 'Flying Windows', 'Marquee', 'Spectrum']) {
      await floatMenu('Mode', mode);
      await check(() => floatStatus('Visualizer').startsWith(mode) && brightPixels() > 0, `${mode} draws`, 6000);
      await log(`SHOT viz-${mode}`);
      await sleep(1000);
    }

    // Closing leaves it playing in the tray, with the menu standing in for the window.
    const appWindow = window.__TAURI__.window.getCurrentWindow();
    const tray = (action) => window.__TAURI__.event.emit('sound95:tray', action);
    await appWindow.close();
    await check(async () => !(await appWindow.isVisible()), 'closing hides the window');
    const hiddenAt = seconds();
    await check(() => seconds() >= hiddenAt + 2, 'music keeps playing with the window closed', 8000);
    await tray('toggle');
    await check(() => $('#tp-play').getAttribute('aria-label') === 'Play', 'the tray menu pauses');
    await tray('toggle');
    await check(() => $('#tp-play').getAttribute('aria-label') === 'Pause', 'the tray menu resumes');
    const playingBefore = $('#np-title').textContent;
    await tray('next');
    await check(() => $('#np-title').textContent !== playingBefore, 'the tray menu skips');
    // Straight after a skip, Previous goes back a track rather than to the start of this one.
    await tray('previous');
    await check(() => $('#np-title').textContent === playingBefore, 'the tray menu goes back');
    await appWindow.show();
    await check(() => appWindow.isVisible(), 'the window comes back');
    await sleep(300);
    $('#volume').value = 0;
    $('#volume').dispatchEvent(new Event('input'));
    $('#viz-toggle').click();

    // The track page, reached from a row, without leaving the app.
    const titleOf = (i) => $$('.row')[i].querySelector('.title');
    const secondTitle = titleOf(1);
    secondTitle.click();
    await check(() => $('.hero-kind')?.textContent === 'Track' && byText('.hero-title', 'Blue Screen Sunrise'), 'clicking a title opens its track page');
    await check(() => $('.wave-canvas') && byText('.prop-value', 'Ambient') && byText('.description', 'Recorded on a 486'), 'track page shows waveform and details');
    await log('SHOT track-page');
    await sleep(1500);
    await clickText('.tab', 'Lyrics');
    await check(() => byText('.lyric-line', 'Word timed 0'), 'track page shows lyrics', 15000);
    await clickText('.tab', 'Related Tracks');
    await check(() => $$('.row').length === 10, 'track page shows related tracks');
    $('#nav-back').click(); $('#nav-back').click(); $('#nav-back').click();
    await waitFor(() => $$('.row').length > 40, 'list after back');
    const first = titleOf(0);
    first.click(); first.click(); dbl(first);
    await sleep(500);
    await check(() => $('.hero-kind') === null && $('#np-title').textContent === 'Dial-Up Lullaby', 'double clicking a title plays instead of opening');
    $('#np-art').click();
    await check(() => byText('.hero-title', 'Dial-Up Lullaby'), 'clicking the player artwork opens the track page');
    $('#nav-back').click();
    await waitFor(() => $$('.row').length > 40, 'list after back');
    $$('.row')[1].querySelector('.row-art').click();
    await check(() => byText('.hero-title', 'Blue Screen Sunrise'), 'clicking row artwork opens the track page');
    $('#nav-back').click();
    await waitFor(() => $$('.row').length > 40, 'list after back');

    const seen = await invoke('api_get', { target: '/__log' });
    const elsewhere = seen.filter((r) => /^\/(lrclib|netease|genius|wave)/.test(r.path));
    await check(() => elsewhere.length && elsewhere.every((r) => !r.auth), 'the session never reaches lyrics or waveform hosts');

    // The heart opens the track's own page, and the like shows up once it reaches the account.
    const trackPageOpen = () => invoke('track_page_open');
    const row = $$('.row')[4];
    const liked = () => row.querySelector('.heart').innerHTML;
    const emptyHeart = liked();
    const clickLike = () => invoke('api_get', { target: `/__click-like?title=${encodeURIComponent(row.querySelector('.title').textContent)}` });
    row.querySelector('.heart').click();
    await check(trackPageOpen, 'the heart opens the track page');
    await check(() => byText('#status', 'Click Like'), 'it says what to do there');
    await check(async () => (await invoke('api_get', { target: '/__page-audio' })).silent === true, 'the page cannot start playing');
    await clickLike();
    await check(() => byText('#status', 'Added') && liked() !== emptyHeart, 'a like on the page reaches the heart', 8000);
    await check(async () => !(await trackPageOpen()), 'the page closes by itself after a like');
    row.querySelector('.heart').click();
    await check(trackPageOpen, 'the heart opens the page to unlike too');
    await clickLike();
    await check(() => byText('#status', 'Removed') && liked() === emptyHeart, 'an unlike on the page reaches the heart', 8000);
    row.querySelector('.heart').click();
    await check(trackPageOpen, 'the page opens again');
    await invoke('close_track_page');
    await check(() => byText('#status', 'Ready') && liked() === emptyHeart, 'closing the page changes nothing', 8000);

    context($$('.row')[30]);
    await clickText('.menu-item', 'Add to Playlist');
    await clickText('.dialog .menu-item', 'Boot Sector Ballads');
    await check(() => byText('#status', 'Added "'), 'add to playlist');

    await invoke('api_get', { target: '/__refuse-next' });
    const refused = await invoke('api_send', { method: 'POST', path: '/me/followings/1', body: null }).catch((e) => e);
    await check(() => refused?.code === 'forbidden', 'a refused change reports it');
    await log('REFUSAL');
    await check(async () => (await invoke('api_get', { target: '/__flaky' })).ok, 'a read that hits a bad moment is tried again');

    byText('.menu-title', 'Help').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await clickText('.menu-item', 'About Sound95');
    await check(() => byText('.dialog .titlebar-text', 'About'), 'about dialog from the Help menu');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await check(() => !$('.dialog'), 'Esc closes dialogs');

    // Theme and language, put back afterwards.
    const theme = () => document.documentElement.dataset.theme;
    const openSettings = async (file, item) => {
      await waitFor(() => !$('.scrim'), 'the last dialog to go');
      byText('#menubar .menu-title', file).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await clickText('.menu-item', item);
      await waitFor(() => $('.settings'), 'the settings window');
    };
    const page = (id) => $(`.dialog .tab[data-page="${id}"]`).click();
    const pick = (select, value) => {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const choose = (look, language) => {
      page('appearance');
      pick($('.settings select'), look);
      page('general');
      pick($('.settings select'), language);
    };
    await openSettings('File', 'Settings');
    await check(() => theme() === 'light' && $('.settings select').value === 'light', 'the light theme is the default');
    await check(() => $$('.settings select')[0].querySelectorAll('option').length === 10, 'every look is offered');
    page('general');
    await check(() => $$('.options input')[0].checked && !$$('.options input')[1].checked, 'closing to the tray is on and Discord is off by default');
    choose('dark', 'ru');
    page('appearance');
    await check(() => $('.monitor[data-theme="dark"]'), 'the monitor previews the theme');
    await log('SHOT settings');
    await sleep(1000);
    await clickText('.dialog button', 'Cancel');
    await check(() => theme() === 'light' && byText('#menubar .menu-title', 'File'), 'Cancel changes nothing');
    $('#karaoke-toggle').click();
    await waitFor(() => $('.float'), 'the karaoke window');
    await openSettings('File', 'Settings');
    choose('dark', 'ru');
    await clickText('.dialog button', 'OK');
    await check(() => theme() === 'dark' && getComputedStyle(document.body).color === 'rgb(230, 230, 230)', 'the dark theme applies');
    await check(() => $('#menubar .menu-title').textContent === 'Файл' && $('#queue-clear').textContent !== 'Clear' && $('#search-box').placeholder !== 'Tracks, playlists, people', 'the menus and page change language');
    await check(() => $('.float .titlebar-text').textContent !== 'Karaoke', 'open windows change language');
    await check(() => localStorage.getItem('sound95.language') === 'ru' && localStorage.getItem('sound95.theme') === 'dark', 'the choices are remembered');
    await log('SHOT dark');
    await sleep(1000);
    await openSettings('Файл', 'Настройка');
    const shownLook = $('.settings select').value;
    page('general');
    await check(() => $('.settings select').value === 'ru' && shownLook === 'dark', 'settings show the current choices');
    choose('light', 'en');
    await clickText('.dialog button', 'OK');
    await check(() => theme() === 'light' && byText('#menubar .menu-title', 'File') && $('.float .titlebar-text').textContent === 'Karaoke', 'theme and language go back');
    $('#karaoke-toggle').click();
    await waitFor(() => !$('.float'), 'the karaoke window to close');

    // Modern animates, unless the system asks for less motion, until that's turned off.
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    await log(`INFO the system ${reduced ? 'asks' : 'does not ask'} for reduced motion`);
    await openSettings('File', 'Settings');
    pick($('.settings select'), 'modern');
    await check(() => $('.settings .options input').checked === !reduced, 'animations start on unless the system asks for less motion');
    if (reduced) $('.settings .options input').click();
    await clickText('.dialog button', 'OK');
    await check(() => skin() === 'modern' && document.documentElement.dataset.motion === 'on', 'Modern animates');
    await openSettings('File', 'Settings');
    await check(() => getComputedStyle($('.scrim > .window')).animationName.includes('s95-pop-in'), 'its dialogs open with an animation');
    await log('SHOT modern-settings');
    await sleep(800);
    $('.settings .options input').click();
    pick($$('.settings select')[1], 'fast');
    await clickText('.dialog button', 'OK');
    await check(() => document.documentElement.dataset.motion === 'off' && !$('.scrim'), 'animations can be turned off, and dialogs close at once');
    await openSettings('File', 'Settings');
    await check(() => getComputedStyle($('.scrim > .window')).animationName === 'none' && $$('.settings select')[1].disabled, 'with them off nothing animates');
    $('.settings .options input').click();
    pick($('.settings select'), 'light');
    await clickText('.dialog button', 'OK');
    await check(() => skin() === 'classic' && localStorage.getItem('sound95.motionChoice') === '1' && localStorage.getItem('sound95.motionSpeed') === 'fast', 'the animation choices are kept');

    // A background of your own: a GIF that plays along with the music.
    const TEST_GIF = 'R0lGODlhCAAGAPAAAP8AAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAACAAGAAACBoSPqct9BQAh+QQACgAAACwAAAAACAAGAIAAAP8AAAACBoSPqct9BQA7';
    await openSettings('File', 'Settings');
    page('background');
    const picked = new DataTransfer();
    picked.items.add(new File([Uint8Array.from(atob(TEST_GIF), (c) => c.charCodeAt(0))], 'dance.gif', { type: 'image/gif' }));
    const chooser = $('.settings input[type="file"]');
    chooser.files = picked.files;
    chooser.dispatchEvent(new Event('change'));
    await check(() => $('.file-name').textContent === 'dance.gif' && $('.monitor-picture'), 'a picked background shows in the preview');
    $$('.settings .options input')[1].click();
    await clickText('.dialog button', 'OK');
    await check(() => document.documentElement.classList.contains('has-backdrop') && $('#backdrop canvas'), 'the background goes behind the app');
    if ($('#tp-play').getAttribute('aria-label') === 'Play') $('#tp-play').click();
    const shade = () => $('#backdrop canvas').getContext('2d').getImageData(0, 0, 1, 1).data[0];
    const firstShade = shade();
    await check(() => shade() !== firstShade, 'the GIF plays while the music does', 6000);
    $('#tp-play').click();
    await waitFor(() => $('#tp-play').getAttribute('aria-label') === 'Play', 'a pause');
    await sleep(500);
    const pausedShade = shade();
    await sleep(1500);
    await check(() => shade() === pausedShade, 'and stops when the music stops');
    $('#tp-play').click();
    await log('SHOT background');
    await sleep(800);
    await openSettings('File', 'Settings');
    page('background');
    await check(() => $('.file-name').textContent === 'dance.gif' && $$('.settings .options input')[1].checked, 'the background is remembered');
    await clickText('.file-buttons button', 'None');
    await clickText('.dialog button', 'OK');
    await check(() => !document.documentElement.classList.contains('has-backdrop') && !$('#backdrop').children.length, 'the background can be taken away');

    $('#start-button').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await check(() => $('.start-menu') && byText('.start-menu .menu-item', 'Log Off'), 'start menu');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(50);

    await clickText('.tree-item', 'Late Shift');
    await check(() => byText('.hero-title', 'Late Shift') && $$('.row').length === 12, 'playlist page');
    await clickText('.tree-item', 'Liked Tracks');
    await check(() => byText('.hero-title', 'Liked Tracks'), 'liked tracks page');
    (await waitFor(() => $('.row button.artist'), 'artist link')).click();
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

    // The mock always offers 9.9.9, with a signature that can't pass.
    await check(() => byText('.balloon p', 'Sound95 9.9.9'), 'a newer release shows a notice', 15000);
    await clickText('.balloon button', 'Details');
    await check(() => byText('.update-notes', 'Fixes everything'), 'the update shows what changed');
    await clickText('.dialog button', 'Later');
    await check(() => !$('.balloon') && !$('.dialog'), 'an update can wait');
    byText('.menu-title', 'Help').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await clickText('.menu-item', 'Check for Updates');
    await clickText('.dialog button', 'Update Now');
    await check(() => byText('.dialog p', 'The update could not'), 'a badly signed update is refused', 15000);
    await clickText('.dialog button', 'OK');

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
