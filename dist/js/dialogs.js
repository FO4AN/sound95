// Modal Win95 dialogs, plus the menus they share chrome with.

import { el, clear, errorText } from './dom.js';
import { icon } from './icons.js';
import { api } from './api.js';

const overlays = () => document.getElementById('overlays');

function chrome(title, { onClose } = {}) {
  const closeButton = el('button', { class: 'caption', ariaLabel: 'Close', onClick: onClose }, icon('close'));
  return el('div', { class: 'titlebar' },
    el('span', { class: 'titlebar-text' }, title),
    el('span', { class: 'titlebar-buttons' }, closeButton));
}

/** Shows a dialog; `build(close)` returns { body, buttons }. Resolves with the close value. */
export function dialog(title, build, { width } = {}) {
  return new Promise((resolve) => {
    const scrim = el('div', { class: 'scrim' });
    const close = (value) => {
      scrim.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const { body, buttons, onDismiss } = build(close);
    const dismiss = () => (onDismiss ? onDismiss() : close(undefined));
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); dismiss(); }
      if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
        e.stopPropagation();
        scrim.querySelector('button.default:not(:disabled)')?.click();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const win = el('div', { class: 'window dialog', role: 'dialog', ariaLabel: title },
      chrome(title, { onClose: dismiss }),
      el('div', { class: 'dialog-body' }, body),
      buttons?.length ? el('div', { class: 'dialog-buttons' }, buttons) : null);
    if (width) win.style.width = `${width}px`;
    scrim.append(win);
    overlays().append(scrim);
    (scrim.querySelector('input') || scrim.querySelector('button.default'))?.focus();
  });
}

export function message(title, text, { kind = 'info', extra } = {}) {
  return dialog(title, (close) => ({
    body: el('div', { class: 'dialog-row' },
      el('span', { class: 'dialog-icon' }, icon(kind)),
      el('div', {}, el('p', {}, text), extra)),
    buttons: [el('button', { class: 'default', onClick: () => close() }, 'OK')],
  }));
}

export function prompt(title, label, { placeholder = '', okText = 'OK' } = {}) {
  return dialog(title, (close) => {
    const input = el('input', { type: 'text', placeholder, spellcheck: false });
    return {
      body: el('div', { class: 'field' }, el('label', {}, label), input),
      buttons: [
        el('button', { class: 'default', onClick: () => close(input.value.trim() || undefined) }, okText),
        el('button', { onClick: () => close() }, 'Cancel'),
      ],
    };
  });
}

/** Resolves 'logged-on', or 'cancelled'. */
export function logonDialog() {
  return dialog('Log In to SoundCloud', (close) => {
    const body = el('div', { class: 'dialog-row' });
    const footer = [];

    const start = async () => {
      clear(body,
        el('span', { class: 'dialog-icon' }, icon('keys')),
        el('div', { style: 'display:grid;gap:10px' },
          el('p', {}, 'Sign in to SoundCloud in the window that just opened.'),
          el('div', { class: 'marquee sunken' })));
      footer.forEach((b) => { if (b !== cancel) b.disabled = true; });
      waiting = true;
      try {
        await api.login();
        close('logged-on');
      } catch (e) {
        waiting = false;
        if (e?.code === 'login_cancelled') return;
        idle(errorText(e));
      }
    };

    const idle = (note) => {
      footer.forEach((b) => { b.disabled = false; });
      clear(body,
        el('span', { class: 'dialog-icon' }, icon('keys')),
        el('div', { style: 'display:grid;gap:8px' },
          el('p', {}, 'Log in with your SoundCloud account. Your likes, playlists and follows come with you.'),
          el('p', {}, 'New to SoundCloud? Choose New Account and sign up for free on its site.'),
          note ? el('p', { class: 'tiny' }, note) : null));
    };

    let waiting = false;
    const dismiss = () => {
      if (waiting) { api.cancelLogin(); waiting = false; idle(); return; }
      close('cancelled');
    };
    const logOn = el('button', { class: 'default', onClick: start }, 'Log In');
    const create = el('button', { onClick: start }, 'New Account');
    const cancel = el('button', { onClick: dismiss }, 'Cancel');
    footer.push(logOn, create, cancel);
    idle();
    return { body, buttons: footer, onDismiss: dismiss };
  });
}

/** Installs the audio plug-ins. The system's password prompt is the approval. */
export function audioSetupDialog() {
  return dialog('Setting Up Audio', (close) => {
    api.audioInstall().then(() => close({ ok: true }), (error) => close({ ok: false, error }));
    return {
      body: el('div', { class: 'dialog-row' },
        el('span', { class: 'dialog-icon' }, icon('speaker')),
        el('div', { style: 'display:grid;gap:10px' },
          el('p', {}, 'Sound95 is installing the audio plug-ins it needs. Enter your password when your system asks. Sound95 will restart when this finishes.'),
          el('div', { class: 'marquee sunken' }))),
      onDismiss: () => {},
    };
  });
}

export function aboutDialog() {
  return dialog('About Sound95', (close) => ({
    body: el('div', { class: 'dialog-row' },
      el('span', { class: 'about-art' }, icon('note')),
      el('div', { style: 'display:grid;gap:6px' },
        el('p', {}, el('b', {}, 'Sound95'), ' version 0.2'),
        el('p', {}, 'A Windows 95 style client for SoundCloud.'),
        el('p', { class: 'tiny' }, 'All music streams from SoundCloud and belongs to its uploaders. Sound95 is not affiliated with SoundCloud or Microsoft. Nothing is saved for offline use.'),
        el('p', { class: 'tiny' }, 'Pixel font from 98.css (MIT).'))),
    buttons: [el('button', { class: 'default', onClick: () => close() }, 'OK')],
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

  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 2);
  const top = below != null ? below - rect.height : Math.min(y, window.innerHeight - rect.height - 2);
  menu.style.left = `${Math.max(0, left)}px`;
  menu.style.top = `${Math.max(0, top)}px`;

  const onDown = (e) => { if (!menu.contains(e.target)) closeMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') closeMenu(); };
  setTimeout(() => document.addEventListener('mousedown', onDown), 0);
  document.addEventListener('keydown', onKey);
  openMenu = () => {
    menu.remove();
    document.removeEventListener('mousedown', onDown);
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
}
