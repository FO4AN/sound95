// Tells you when a newer Sound95 is out, and installs it when you say so.

import { onLanguageChange, tr } from './i18n.js';
import { clear, el, errorText } from './dom.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { dialog, message } from './dialogs.js';
import { leave } from './motion.js';

const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const MB = 1024 * 1024;

let balloon = null;
let offered = null; // the update the balloon shows
let declined = null; // the version you said Later to, until the next launch

function closeBalloon() {
  leave(balloon);
  balloon = null;
  offered = null;
}

function showBalloon(update) {
  closeBalloon();
  const later = () => { declined = update.version; closeBalloon(); };
  balloon = el('div', { class: 'balloon', role: 'status' },
    el('button', { class: 'caption', ariaLabel: tr('Close'), onClick: later }, icon('close')),
    el('b', {}, tr('Update available')),
    el('p', {}, tr('Sound95 {version} is ready to install.', { version: update.version })),
    el('div', { class: 'balloon-buttons' },
      el('button', { class: 'default', onClick: () => { closeBalloon(); updateDialog(update); } }, tr('Details...')),
      el('button', { onClick: later }, tr('Later'))));
  document.getElementById('overlays').append(balloon);
  offered = update;
}

onLanguageChange(() => { if (offered) showBalloon(offered); });

function updateDialog(update) {
  return dialog(tr('Update Sound95'), (close) => {
    let busy = false;
    const body = el('div', { class: 'dialog-row' });
    const buttons = [];
    const later = () => { declined = update.version; close(); };

    const fail = (error, footer) => {
      busy = false;
      clear(body, el('span', { class: 'dialog-icon' }, icon('warn')),
        el('div', {}, el('p', {}, tr('The update could not be installed. Your version still works.')),
          el('p', { class: 'tiny' }, errorText(error))));
      clear(footer, el('button', { class: 'default', onClick: () => close() }, tr('OK')));
    };

    const install = async () => {
      busy = true;
      const label = el('p', {}, tr('Downloading Sound95 {version}...', { version: update.version }));
      const fill = el('div', { class: 'progress-fill' });
      clear(body, el('span', { class: 'dialog-icon' }, icon('info')),
        el('div', { class: 'update-progress' }, label, el('div', { class: 'progress sunken' }, fill)));
      const footer = buttons[0].parentNode;
      clear(footer);
      const stop = await window.__TAURI__.event.listen('sound95:update', ({ payload: { received, total } }) => {
        if (total) fill.style.width = `${Math.min(100, (received / total) * 100)}%`;
        label.textContent = total
          ? tr('Downloading: {done} of {total} MB', { done: (received / MB).toFixed(1), total: (total / MB).toFixed(1) })
          : tr('Downloading: {done} MB', { done: (received / MB).toFixed(1) });
        if (total && received >= total) label.textContent = tr('Installing. Sound95 will restart by itself.');
      });
      try {
        await api.updateInstall();
      } catch (error) {
        fail(error, footer);
      } finally {
        stop();
      }
    };

    clear(body, el('span', { class: 'dialog-icon' }, icon('info')),
      el('div', { style: 'display:grid;gap:6px;min-width:0' },
        el('p', {}, tr('Sound95 {version} is available. Installing it restarts the app.', { version: update.version })),
        update.notes ? el('div', { class: 'update-notes sunken' }, update.notes) : null));
    buttons.push(el('button', { class: 'default', onClick: install }, tr('Update Now')),
      el('button', { onClick: later }, tr('Later')));
    return { body, buttons, onDismiss: () => { if (!busy) later(); } };
  }, { width: 400 });
}

async function look() {
  let update;
  try {
    update = await api.updateCheck();
  } catch {
    return; // offline, or GitHub is down: there's always the next check
  }
  if (update && update.version !== declined) showBalloon(update);
}

export function watchForUpdates() {
  setTimeout(look, FIRST_CHECK_MS);
  setInterval(look, CHECK_EVERY_MS);
}

export async function checkForUpdates() {
  closeBalloon();
  try {
    const update = await api.updateCheck();
    if (update) await updateDialog(update);
    else await message(tr('Check for Updates'), tr('You have the latest version of Sound95 ({version}).', { version: await api.version() }));
  } catch (error) {
    await message(tr('Check for Updates'), tr('Could not check for updates. {reason}', { reason: errorText(error) }), { kind: 'warn' });
  }
}
