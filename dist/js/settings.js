// The Settings dialog, styled after Windows 95's Display Properties.

import { tr, currentLanguage, LANGUAGES, setLanguage } from './i18n.js';
import { el } from './dom.js';
import { dialog } from './dialogs.js';

const THEME_KEY = 'sound95.theme';

function savedTheme() {
  try { return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}

export function applyTheme(theme = savedTheme()) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* optional */ }
}

export function settingsDialog() {
  let theme = savedTheme();
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
    return {
      body: el('div', { class: 'settings' },
        el('fieldset', { class: 'group' }, el('legend', {}, tr('Theme')),
          el('div', { class: 'theme-row' }, monitor,
            el('div', { class: 'theme-options' }, option('light', tr('Light')), option('dark', tr('Dark'))))),
        el('fieldset', { class: 'group' }, el('legend', {}, tr('Language')), language)),
      buttons: [
        el('button', { class: 'default', onClick: () => { applyTheme(theme); setLanguage(language.value); close(); } }, tr('OK')),
        el('button', { onClick: () => close() }, tr('Cancel')),
      ],
    };
  }, { width: 300 });
}
