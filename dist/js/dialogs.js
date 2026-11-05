// Modal Win95 dialogs, plus the menus they share chrome with.

import { tr } from './i18n.js';
import { el, clear, errorText } from './dom.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { leave } from './motion.js';

const overlays = () => document.getElementById('overlays');

/**
 * Leaves only the topmost dialog usable: the app, its floating windows and any
 * dialog underneath go inert, so Tab and Space can't reach what's behind the
 * scrim. Menus and notices stay usable. Call it when a scrim opens or closes.
 */
export function syncModal() {
  const open = [...overlays().querySelectorAll(':scope > .scrim:not(.leaving)')];
  const top = open.at(-1);
  for (const id of ['app', 'floats']) document.getElementById(id).inert = !!top;
  for (const scrim of open) scrim.inert = scrim !== top;
}

function chrome(title, { onClose } = {}) {
  const closeButton = el('button', { class: 'caption', ariaLabel: tr('Close'), onClick: onClose }, icon('close'));
  return el('div', { class: 'titlebar' },
    el('span', { class: 'titlebar-text' }, title),
    el('span', { class: 'titlebar-buttons' }, closeButton));
}

/** Shows a dialog; `build(close)` returns { body, buttons }. Resolves with the close value. */
export function dialog(title, build, { width } = {}) {
  return new Promise((resolve) => {
    const scrim = el('div', { class: 'scrim' });
    const close = (value) => {
      leave(scrim);
      syncModal();
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const { body, buttons, onDismiss } = build(close);
    const dismiss = () => (onDismiss ? onDismiss() : close(undefined));
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); dismiss(); }
      // Enter in a text box starts a new line; Ctrl+Enter sends it.
      const newLine = e.target.tagName === 'TEXTAREA' && !e.ctrlKey && !e.metaKey;
      if (e.key === 'Enter' && e.target.tagName !== 'BUTTON' && !newLine) {
        e.stopPropagation();
        e.preventDefault();
        scrim.querySelector('button.default:not(:disabled)')?.click();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const win = el('div', { class: 'window dialog', role: 'dialog', ariaModal: 'true', ariaLabel: title },
      chrome(title, { onClose: dismiss }),
      el('div', { class: 'dialog-body' }, body),
      buttons?.length ? el('div', { class: 'dialog-buttons' }, buttons) : null);
    if (width) win.style.width = `${width}px`;
    scrim.append(win);
    overlays().append(scrim);
    syncModal();
    (scrim.querySelector('input, textarea') || scrim.querySelector('button.default'))?.focus();
  });
}

export function message(title, text, { kind = 'info', extra } = {}) {
  return dialog(title, (close) => ({
    body: el('div', { class: 'dialog-row' },
      el('span', { class: 'dialog-icon' }, icon(kind)),
      el('div', {}, el('p', {}, text), extra)),
    buttons: [el('button', { class: 'default', onClick: () => close() }, tr('OK'))],
  }));
}

export function prompt(title, label, { placeholder = '', okText = tr('OK') } = {}) {
  return dialog(title, (close) => {
    const input = el('input', { type: 'text', placeholder, spellcheck: false });
    return {
      body: el('div', { class: 'field' }, el('label', {}, label), input),
      buttons: [
        el('button', { class: 'default', onClick: () => close(input.value.trim() || undefined) }, okText),
        el('button', { onClick: () => close() }, tr('Cancel')),
      ],
    };
  });
}

/** Resolves 'logged-on', or 'cancelled'. */
export function logonDialog() {
  return dialog(tr('Log In to SoundCloud'), (close) => {
    const body = el('div', { class: 'dialog-row' });
    const footer = [];

    let attempt = 0;
    const start = async () => {
      const mine = ++attempt;
      clear(body,
        el('span', { class: 'dialog-icon' }, icon('keys')),
        el('div', { style: 'display:grid;gap:10px' },
          el('p', {}, tr('Sign in to SoundCloud in the window that just opened.')),
          el('div', { class: 'marquee sunken' })));
      footer.forEach((b) => { if (b !== cancel) b.disabled = true; });
      waiting = true;
      try {
        await api.login();
        close('logged-on');
      } catch (e) {
        // Cancel here already went back to the start, or a newer try owns the dialog.
        if (mine !== attempt || !waiting) return;
        waiting = false;
        // Closing the sign-in window is a cancel too, so it needs no note.
        idle(e?.code === 'login_cancelled' ? undefined : errorText(e));
      }
    };

    const idle = (note) => {
      footer.forEach((b) => { b.disabled = false; });
      clear(body,
        el('span', { class: 'dialog-icon' }, icon('keys')),
        el('div', { style: 'display:grid;gap:8px' },
          el('p', {}, tr('Log in with your SoundCloud account. Your likes, playlists and follows come with you.')),
          el('p', {}, tr('New to SoundCloud? Choose New Account and sign up for free on its site.')),
          note ? el('p', { class: 'tiny' }, note) : null));
    };

    let waiting = false;
    const dismiss = () => {
      if (waiting) { api.cancelLogin(); waiting = false; idle(); return; }
      close('cancelled');
    };
    const logOn = el('button', { class: 'default', onClick: start }, tr('Log In'));
    const create = el('button', { onClick: start }, tr('New Account'));
    const cancel = el('button', { onClick: dismiss }, tr('Cancel'));
    footer.push(logOn, create, cancel);
    idle();
    return { body, buttons: footer, onDismiss: dismiss };
  });
}

/** Resolves true if you want the plug-ins, which is what opens a password prompt. */
export function audioAskDialog() {
  return dialog(tr('Audio Plug-ins Needed'), (close) => ({
    body: el('div', { class: 'dialog-row' },
      el('span', { class: 'dialog-icon' }, icon('speaker')),
      el('p', {}, tr('Sound95 needs a few audio plug-ins to play music. Installing them asks for your password.'))),
    buttons: [
      el('button', { class: 'default', onClick: () => close(true) }, tr('Install')),
      el('button', { onClick: () => close(false) }, tr('Not Now')),
    ],
    onDismiss: () => close(false),
  }));
}

/** Installs the audio plug-ins. */
export function audioSetupDialog() {
  return dialog(tr('Setting Up Audio'), (close) => {
    api.audioInstall().then(() => close({ ok: true }), (error) => close({ ok: false, error }));
    return {
      body: el('div', { class: 'dialog-row' },
        el('span', { class: 'dialog-icon' }, icon('speaker')),
        el('div', { style: 'display:grid;gap:10px' },
          el('p', {}, tr('Sound95 is installing the audio plug-ins it needs. Enter your password when your system asks. Sound95 will restart when this finishes.')),
          el('div', { class: 'marquee sunken' }))),
      onDismiss: () => {},
    };
  });
}

export async function aboutDialog() {
  const version = await api.version();
  return dialog(tr('About Sound95'), (close) => ({
    body: el('div', { class: 'dialog-row' },
      el('span', { class: 'about-art' }, icon('note')),
      el('div', { style: 'display:grid;gap:6px' },
        el('p', {}, el('b', {}, 'Sound95'), ` ${tr('version {version}', { version })}`),
        el('p', {}, tr('A Windows 95 style client for SoundCloud.')),
        el('p', { class: 'tiny' }, tr('All music streams from SoundCloud and belongs to its uploaders. Sound95 is not affiliated with SoundCloud or Microsoft. Nothing is saved for offline use.')),
        el('p', { class: 'tiny' }, tr('Lyrics come from LRCLIB, NetEase and Genius, and belong to their writers.')),
        el('p', { class: 'tiny' }, tr('Pixel font from 98.css (MIT).')))),
    buttons: [el('button', { class: 'default', onClick: () => close() }, tr('OK'))],
  }), { width: 360 });
}

/* Menus: items are { label, accel?, icon?, checked?, disabled?, action } or 'sep'. */

let openMenu = null;

export function closeMenu() {
  openMenu?.();
  openMenu = null;
}

export function showMenu(items, x, y, { below, className, onClose, header } = {}) {
  closeMenu();
  const rows = items.map((item) => {
    if (item === 'sep') return el('div', { class: 'menu-sep' });
    return el('div', {
      class: `menu-item${item.disabled ? ' disabled' : ''}`,
      role: 'menuitem',
      onClick: () => {
        if (item.disabled) return;
        closeMenu();
        item.action();
      },
    },
    el('span', {}, item.icon ? icon(item.icon) : item.checked ? icon('check') : null),
    el('span', {}, item.label),
    className ? null : el('span', { class: 'accel' }, item.accel || ''));
  });
  const menu = el('div', { class: `menu ${className || ''}`, role: 'menu' });
  if (header) menu.append(header, el('div', {}, rows));
  else menu.append(...rows);
  overlays().append(menu);

  // Layout size: Modern's opening animation starts the menu smaller than it ends up.
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const left = Math.min(x, window.innerWidth - w - 2);
  const top = below != null ? below - h : Math.min(y, window.innerHeight - h - 2);
  menu.style.left = `${Math.max(0, left)}px`;
  menu.style.top = `${Math.max(0, top)}px`;

  const onDown = (e) => { if (!menu.contains(e.target)) closeMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') closeMenu(); };
  // A menu closed before this runs mustn't leave it behind to close every later menu.
  const listen = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
  document.addEventListener('keydown', onKey);
  openMenu = () => {
    leave(menu);
    clearTimeout(listen);
    document.removeEventListener('mousedown', onDown);
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
}
