// Tells you when a newer Sound95 is out, and installs it when you say so.

import { clear, el, errorText } from './dom.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { dialog, message } from './dialogs.js';

const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const MB = 1024 * 1024;

let balloon = null;
let declined = null; // the version you said Later to, until the next launch

function closeBalloon() {
  balloon?.remove();
  balloon = null;
}

function showBalloon(update) {
  closeBalloon();
  const later = () => { declined = update.version; closeBalloon(); };
  balloon = el('div', { class: 'balloon', role: 'status' },
    el('button', { class: 'caption', ariaLabel: 'Close', onClick: later }, icon('close')),
    el('b', {}, 'Update available'),
    el('p', {}, `Sound95 ${update.version} is ready to install.`),
    el('div', { class: 'balloon-buttons' },
      el('button', { class: 'default', onClick: () => { closeBalloon(); updateDialog(update); } }, 'Details...'),
      el('button', { onClick: later }, 'Later')));
  document.getElementById('overlays').append(balloon);
}

function updateDialog(update) {
  return dialog('Update Sound95', (close) => {
    let busy = false;
    const body = el('div', { class: 'dialog-row' });
    const buttons = [];
    const later = () => { declined = update.version; close(); };

    const fail = (error, footer) => {
      busy = false;
      clear(body, el('span', { class: 'dialog-icon' }, icon('warn')),
        el('div', {}, el('p', {}, 'The update could not be installed. Your version still works.'),
          el('p', { class: 'tiny' }, errorText(error))));
      clear(footer, el('button', { class: 'default', onClick: () => close() }, 'OK'));
    };

    const install = async () => {
      busy = true;
      const label = el('p', {}, `Downloading Sound95 ${update.version}...`);
      const fill = el('div', { class: 'progress-fill' });
      clear(body, el('span', { class: 'dialog-icon' }, icon('info')),
        el('div', { class: 'update-progress' }, label, el('div', { class: 'progress sunken' }, fill)));
      const footer = buttons[0].parentNode;
      clear(footer);
      const stop = await window.__TAURI__.event.listen('sound95:update', ({ payload: { received, total } }) => {
        if (total) fill.style.width = `${Math.min(100, (received / total) * 100)}%`;
        label.textContent = total
          ? `Downloading: ${(received / MB).toFixed(1)} of ${(total / MB).toFixed(1)} MB`
          : `Downloading: ${(received / MB).toFixed(1)} MB`;
        if (total && received >= total) label.textContent = 'Installing. Sound95 will restart by itself.';
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
        el('p', {}, el('b', {}, `Sound95 ${update.version}`), ' is available. Installing it restarts the app.'),
        update.notes ? el('div', { class: 'update-notes sunken' }, update.notes) : null));
    buttons.push(el('button', { class: 'default', onClick: install }, 'Update Now'),
      el('button', { onClick: later }, 'Later'));
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
    else await message('Check for Updates', `You have the latest version of Sound95 (${await api.version()}).`);
  } catch (error) {
    await message('Check for Updates', `Could not check for updates. ${errorText(error)}`, { kind: 'warn' });
  }
}
