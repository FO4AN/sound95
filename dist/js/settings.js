// The Settings dialog, styled after Windows 95's Display Properties.

import { tr, currentLanguage, LANGUAGES, setLanguage } from './i18n.js';
import { api } from './api.js';
import { el, errorText, setStatus } from './dom.js';
import { dialog } from './dialogs.js';
import { discordOn, setDiscordOn } from './presence.js';
import { THEMES, applyTheme, savedTheme } from './themes.js';
import { backdropBlur, backdropMoves, backdropName, currentBackdrop, kindOf, refusal, setBackdrop } from './backdrop.js';
import { followsVolume, setFollowsVolume } from './visualizer.js';
import { SPEEDS, applyMotion, crossfade, motionOn, motionSpeed } from './motion.js';

export { applyTheme };

const TRAY_KEY = 'sound95.closeToTray';

function closesToTray() {
  try { return localStorage.getItem(TRAY_KEY) !== '0'; } catch { return true; }
}

export function applyCloseToTray(closes = closesToTray()) {
  try { localStorage.setItem(TRAY_KEY, closes ? '1' : '0'); } catch { /* optional */ }
  return api.trayClosesTo(closes);
}

const checkbox = (checked, disabled = false) => {
  const input = el('input', { type: 'checkbox', disabled });
  input.checked = checked;
  return input;
};

export async function settingsDialog() {
  const discordReady = await api.discordAvailable().catch(() => false);
  let theme = savedTheme();
  // undefined keeps the background there is, null removes it, a File replaces it.
  let picked;
  let pickedUrl = null;

  return dialog(tr('Settings'), (close) => {
    const monitors = [];
    const monitor = () => {
      const screen = el('div', { class: 'monitor-screen' }, el('div', { class: 'monitor-window' }));
      const node = el('div', { class: 'monitor' }, screen);
      monitors.push({ node, screen });
      return node;
    };
    const preview = () => {
      const skin = THEMES.find((t) => t.id === theme).skin;
      const shown = picked === undefined ? currentBackdrop() : picked && { kind: kindOf(picked), url: pickedUrl };
      for (const { node, screen } of monitors) {
        node.dataset.theme = theme;
        node.dataset.skin = skin;
        node.classList.toggle('has-picture', !!shown);
        screen.querySelector('.monitor-picture')?.remove();
        if (shown) {
          const picture = shown.kind === 'video'
            ? el('video', { class: 'monitor-picture', src: shown.url, muted: true, autoplay: true, loop: true })
            : el('img', { class: 'monitor-picture', src: shown.url, alt: '' });
          screen.prepend(picture);
        }
      }
      fileName.textContent = picked === undefined ? backdropName() || tr('(None)') : picked?.name || tr('(None)');
      remove.disabled = picked === null || (picked === undefined && !backdropName());
    };

    /* Appearance */
    const scheme = el('select', { class: 'dropdown', ariaLabel: tr('Theme') },
      el('optgroup', { label: 'Windows 95' }, THEMES.filter((t) => t.skin === 'classic').map((t) => el('option', { value: t.id }, tr(t.label)))),
      el('optgroup', { label: tr('Modern') }, THEMES.filter((t) => t.skin === 'modern').map((t) => el('option', { value: t.id }, tr(t.label)))));
    scheme.value = theme;
    scheme.addEventListener('change', () => { theme = scheme.value; preview(); });
    const follow = checkbox(followsVolume());
    const motion = checkbox(motionOn());
    const speed = el('select', { class: 'dropdown', ariaLabel: tr('Speed') },
      Object.keys(SPEEDS).map((id) => el('option', { value: id }, tr({ slow: 'Slow', normal: 'Normal', fast: 'Fast' }[id]))));
    speed.value = motionSpeed();
    const speedRow = el('label', { class: 'speed-row' }, el('span', {}, tr('Speed')), speed);
    const syncSpeed = () => { speed.disabled = !motion.checked; speedRow.classList.toggle('off', !motion.checked); };
    motion.addEventListener('change', syncSpeed);
    syncSpeed();

    /* Background */
    const fileName = el('div', { class: 'file-name' });
    const chooser = el('input', { type: 'file', accept: 'image/*,video/*', class: 'file-input', ariaLabel: tr('Browse...') });
    chooser.addEventListener('change', () => {
      const file = chooser.files?.[0];
      chooser.value = '';
      if (!file) return;
      const why = refusal(file);
      if (why) { problem.textContent = why; return; }
      problem.textContent = '';
      if (pickedUrl) URL.revokeObjectURL(pickedUrl);
      picked = file;
      pickedUrl = URL.createObjectURL(file);
      preview();
    });
    const browse = el('button', { onClick: () => chooser.click() }, tr('Browse...'));
    const remove = el('button', { onClick: () => { picked = null; problem.textContent = ''; preview(); } }, tr('None'));
    const problem = el('div', { class: 'tiny problem', role: 'alert' });
    const blur = checkbox(backdropBlur());
    const moves = checkbox(backdropMoves());

    /* General */
    const language = el('select', { class: 'dropdown', ariaLabel: tr('Language') },
      Object.entries(LANGUAGES).map(([code, { name }]) => el('option', { value: code }, name)));
    language.value = currentLanguage();
    const tray = checkbox(closesToTray());
    const discord = checkbox(discordOn(), !discordReady);

    const pages = {
      appearance: el('div', { class: 'settings' },
        el('fieldset', { class: 'group' }, el('legend', {}, tr('Theme')),
          el('div', { class: 'theme-row' }, monitor(), el('div', { class: 'theme-options' }, scheme))),
        el('fieldset', { class: 'group options' }, el('legend', {}, tr('Animations')),
          el('label', {}, motion, tr('Smooth animations in the Modern themes')),
          speedRow),
        el('fieldset', { class: 'group options' }, el('legend', {}, tr('Visualizers')),
          el('label', {}, follow, tr('Bars rise and fall with how loud the music plays')))),
      background: el('div', { class: 'settings' },
        el('fieldset', { class: 'group' }, el('legend', {}, tr('Background')),
          el('div', { class: 'theme-row' }, monitor(),
            el('div', { class: 'theme-options' }, fileName, el('div', { class: 'file-buttons' }, browse, remove), chooser)),
          problem),
        el('fieldset', { class: 'group options' }, el('legend', {}, tr('Effects')),
          el('label', {}, blur, tr('Blur the background')),
          el('label', {}, moves, tr('Move with the music')),
          el('div', { class: 'tiny' }, tr('Pictures, GIFs and videos all work. GIFs and videos play faster when the music is loud.')))),
      general: el('div', { class: 'settings' },
        el('fieldset', { class: 'group' }, el('legend', {}, tr('Language')), language),
        el('fieldset', { class: 'group options' }, el('legend', {}, tr('Options')),
          el('label', {}, tray, tr('Keep running in the tray when I close the window')),
          el('label', {}, discord, tr('Show what I am listening to in Discord')),
          discordReady ? null : el('div', { class: 'tiny' }, tr('Not available in this version.')))),
    };
    const panel = el('div', { class: 'tab-panel' });
    const tabBar = el('div', { class: 'tabs', role: 'tablist' });
    const show = (id) => {
      panel.replaceChildren(pages[id]);
      for (const tab of tabBar.children) tab.classList.toggle('selected', tab.dataset.page === id);
    };
    tabBar.append(...[['appearance', tr('Appearance')], ['background', tr('Background')], ['general', tr('General')]]
      .map(([id, label]) => el('button', { class: 'tab', role: 'tab', 'data-page': id, onClick: () => show(id) }, label)));
    show('appearance');
    preview();

    const finish = (value) => {
      if (pickedUrl) URL.revokeObjectURL(pickedUrl);
      close(value);
    };
    // The dialog stays up while the background is saved and set up, which takes a
    // while for a big GIF, and a second OK then would set it up twice over.
    let saving = false;
    return {
      body: el('div', { class: 'settings-tabs' }, tabBar, panel),
      onDismiss: () => finish(),
      buttons: [
        el('button', { class: 'default', onClick: async () => {
            if (saving) return;
            saving = true;
            applyMotion({ on: motion.checked, speed: speed.value });
            crossfade(() => applyTheme(theme));
            setFollowsVolume(follow.checked);
            applyCloseToTray(tray.checked);
            setDiscordOn(discord.checked);
            setLanguage(language.value);
            try {
              await setBackdrop({ file: picked, blur: blur.checked, moves: moves.checked });
            } catch (e) {
              setStatus(`${tr('Could not save the background.')} ${errorText(e)}`);
            }
            finish();
          } }, tr('OK')),
        el('button', { onClick: () => finish() }, tr('Cancel')),
      ],
    };
  }, { width: 400 });
}
