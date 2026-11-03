// The Settings dialog, styled after Windows 95's Display Properties.

import { tr, currentLanguage, LANGUAGES, setLanguage } from './i18n.js';
import { api } from './api.js';
import { el } from './dom.js';
import { dialog } from './dialogs.js';
import { discordOn, setDiscordOn } from './presence.js';

const THEME_KEY = 'sound95.theme';
const TRAY_KEY = 'sound95.closeToTray';

function savedTheme() {
  try { return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}

export function applyTheme(theme = savedTheme()) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* optional */ }
}

function closesToTray() {
  try { return localStorage.getItem(TRAY_KEY) !== '0'; } catch { return true; }
}

export function applyCloseToTray(closes = closesToTray()) {
  try { localStorage.setItem(TRAY_KEY, closes ? '1' : '0'); } catch { /* optional */ }
  return api.trayClosesTo(closes);
}

export async function settingsDialog() {
  let theme = savedTheme();
  const discordReady = await api.discordAvailable().catch(() => false);
  return dialog(tr('Settings'), (close) => {
    const monitor = el('div', { class: `monitor ${theme}` },
      el('div', { class: 'monitor-screen' }, el('div', { class: 'monitor-window' })));
    const option = (value, label) => {
      const input = el('input', { type: 'radio', name: 'theme' });
      input.checked = value === theme;
      input.addEventListener('change', () => { theme = value; monitor.className = `monitor ${value}`; });
      return el('label', {}, input, label);
    };
    const language = el('select', { class: 'dropdown', ariaLabel: tr('Language') },
      Object.entries(LANGUAGES).map(([code, { name }]) => el('option', { value: code }, name)));
    language.value = currentLanguage();
    const checkbox = (checked, disabled) => {
      const input = el('input', { type: 'checkbox', disabled });
      input.checked = checked;
      return input;
    };
    const tray = checkbox(closesToTray(), false);
    const discord = checkbox(discordOn(), !discordReady);
    return {
      body: el('div', { class: 'settings' },
        el('fieldset', { class: 'group' }, el('legend', {}, tr('Theme')),
          el('div', { class: 'theme-row' }, monitor,
            el('div', { class: 'theme-options' }, option('light', tr('Light')), option('dark', tr('Dark'))))),
        el('fieldset', { class: 'group' }, el('legend', {}, tr('Language')), language),
        el('fieldset', { class: 'group options' }, el('legend', {}, tr('Options')),
          el('label', {}, tray, tr('Keep running in the tray when I close the window')),
          el('label', {}, discord, tr('Show what I am listening to in Discord')),
          discordReady ? null : el('div', { class: 'tiny' }, tr('Not available in this version.')))),
      buttons: [
        el('button', { class: 'default', onClick: () => {
            applyTheme(theme);
            applyCloseToTray(tray.checked);
            setDiscordOn(discord.checked);
            setLanguage(language.value);
            close();
          } }, tr('OK')),
        el('button', { onClick: () => close() }, tr('Cancel')),
      ],
    };
  }, { width: 330 });
}
