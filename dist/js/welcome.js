// The welcome you get once, the first time you're logged in: a hello, a choice of
// look with a preview of each, and a send-off. Picking a look applies it on the
// spot, so the welcome itself changes with it. A setup wizard in Classic, a card
// in Modern.

import { tr } from './i18n.js';
import { el } from './dom.js';
import { THEMES, applyTheme, savedTheme } from './themes.js';
import { crossfade, leave } from './motion.js';
import { syncModal } from './dialogs.js';

const DONE_KEY = 'sound95.welcomed';

export function welcomed() {
  try { return localStorage.getItem(DONE_KEY) === '1'; } catch { return true; }
}

function lookPreview(theme) {
  return el('span', { class: 'look-preview', dataset: { theme: theme.id, skin: theme.skin }, ariaHidden: 'true' },
    el('span', { class: 'lp-top' }), el('span', { class: 'lp-side' }),
    el('span', { class: 'lp-main' }, el('span', { class: 'lp-hero' })), el('span', { class: 'lp-bar' }, el('span', { class: 'lp-play' })));
}

const mark = () => document.querySelector('.brand-mark').cloneNode(true);

const lookName = (theme) => tr(theme.label);

/** Shows the welcome if it hasn't been shown yet. Resolves when it's done. */
export function welcomeIfNew(name) {
  if (welcomed()) return Promise.resolve();
  return new Promise((resolve) => {
    let step = 0;
    let chosen = savedTheme();
    const stage = el('div', { class: 'welcome-stage' });
    const dots = el('div', { class: 'welcome-dots', ariaHidden: 'true' }, [0, 1, 2].map(() => el('span')));
    const back = el('button', { class: 'welcome-back', onClick: () => go(step - 1) }, tr('< Back'));
    const next = el('button', { class: 'default welcome-next', onClick: () => (step === 2 ? finish() : go(step + 1)) });

    const cards = THEMES.map((theme) => el('button', {
      class: 'look-card',
      role: 'radio',
      dataset: { look: theme.id },
      title: lookName(theme),
      onClick: () => {
        chosen = theme.id;
        for (const card of cards) {
          const on = card.dataset.look === chosen;
          card.classList.toggle('selected', on);
          card.setAttribute('aria-checked', String(on));
        }
        crossfade(() => applyTheme(chosen));
      },
    }, lookPreview(theme), el('span', { class: 'look-name' }, lookName(theme))));
    for (const card of cards) {
      const on = card.dataset.look === chosen;
      card.classList.toggle('selected', on);
      card.setAttribute('aria-checked', String(on));
    }

    const steps = [
      () => el('div', { class: 'welcome-page' },
        el('div', { class: 'welcome-mark' }, mark()),
        el('h1', {}, name ? tr('Welcome to Sound95, {name}', { name }) : tr('Welcome to Sound95')),
        el('p', {}, tr('Your SoundCloud, with the look of 1995 or of today.')),
        el('p', {}, tr('Take a moment to choose how it looks. Click Continue to start.'))),
      () => el('div', { class: 'welcome-page' },
        el('h1', {}, tr('Choose a look')),
        el('p', {}, tr('Click one to try it. The whole app changes with it.')),
        el('div', { class: 'look-group' }, el('div', { class: 'look-title' }, 'Windows 95'),
          el('div', { class: 'looks', role: 'radiogroup' }, cards.filter((_, i) => THEMES[i].skin === 'classic'))),
        el('div', { class: 'look-group' }, el('div', { class: 'look-title' }, tr('Modern')),
          el('div', { class: 'looks', role: 'radiogroup' }, cards.filter((_, i) => THEMES[i].skin === 'modern')))),
      () => el('div', { class: 'welcome-page' },
        el('div', { class: 'welcome-mark' }, mark()),
        el('h1', {}, tr('You\'re all set')),
        el('p', {}, tr('Search for anything up top, or start from your Liked Tracks.')),
        el('p', { class: 'tiny' }, tr('You can change the look, add a background of your own and turn animations off in File > Settings.'))),
    ];

    function go(to) {
      step = Math.max(0, Math.min(2, to));
      stage.replaceChildren(steps[step]());
      back.disabled = step === 0;
      next.textContent = step === 2 ? tr('Get Started') : tr('Continue');
      [...dots.children].forEach((dot, i) => dot.classList.toggle('on', i === step));
      win.dataset.step = String(step);
      next.focus();
    }

    const win = el('div', { class: 'window welcome', role: 'dialog', ariaModal: 'true', ariaLabel: tr('Welcome to Sound95') },
      el('div', { class: 'titlebar' }, el('span', { class: 'titlebar-text' }, tr('Welcome to Sound95'))),
      el('div', { class: 'welcome-body' }, el('div', { class: 'welcome-art' }, mark()), stage),
      el('div', { class: 'welcome-foot' }, dots, el('div', { class: 'welcome-buttons' }, back, next)));
    const scrim = el('div', { class: 'scrim welcome-scrim' }, win);

    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); finish(); }
      if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.stopPropagation(); next.click(); }
    };
    function finish() {
      try { localStorage.setItem(DONE_KEY, '1'); } catch { /* optional */ }
      document.removeEventListener('keydown', onKey, true);
      leave(scrim);
      syncModal();
      resolve();
    }
    document.addEventListener('keydown', onKey, true);
    document.getElementById('overlays').append(scrim);
    syncModal();
    go(0);
  });
}
