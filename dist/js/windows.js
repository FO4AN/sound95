// Floating Win95 windows inside the app, for things that stay up while you browse.
// Dragged by the title bar, sized by the corner grip, and remembered between runs.

import { el, clear } from './dom.js';
import { icon, setIcon } from './icons.js';
import { closeMenu, showMenu } from './dialogs.js';

const STORE_KEY = 'sound95.windows';
const FIRST_Z = 10;
const LAST_Z = 35; // dialogs start at 40
const EDGE = 40; // how much of a window has to stay on screen

let nextZ = FIRST_Z;
const open = new Set();

function readPlaces() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { return {}; }
}

function savePlace(id, place) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ ...readPlaces(), [id]: place })); } catch { /* optional */ }
}

function focus(win) {
  if (nextZ > LAST_Z) {
    nextZ = FIRST_Z;
    [...open].sort((a, b) => a.node.style.zIndex - b.node.style.zIndex).forEach((w) => { w.node.style.zIndex = nextZ++; });
  }
  win.node.style.zIndex = nextZ++;
  for (const other of open) other.bar.classList.toggle('idle', other !== win);
}

/** `menus` maps a menu title to a function returning its items. */
export function floatWindow({ id, title, iconName, width, height, minWidth = 280, minHeight = 200, menus = {}, onClose }) {
  const closeButton = el('button', { class: 'caption', ariaLabel: 'Close' }, icon('close'));
  const maxButton = el('button', { class: 'caption', ariaLabel: 'Maximize' }, icon('max'));
  const bar = el('div', { class: 'titlebar' },
    el('span', { class: 'float-icon' }, icon(iconName)),
    el('span', { class: 'titlebar-text' }, title),
    el('span', { class: 'titlebar-buttons' }, maxButton, closeButton));
  const menubar = el('div', { class: 'menubar' });
  const body = el('div', { class: 'float-body' });
  const status = el('span', { class: 'status-cell grow' }, '');
  const grip = el('span', { class: 'grip' });
  const node = el('div', { class: 'window float', role: 'dialog', ariaLabel: title },
    bar, Object.keys(menus).length ? menubar : null, body,
    el('div', { class: 'statusbar' }, status, grip));

  const place = { x: 80 + open.size * 28, y: 60 + open.size * 28, w: width, h: height, ...readPlaces()[id] };
  let maximized = false;

  const apply = () => {
    if (maximized) {
      const area = document.getElementById('workspace').getBoundingClientRect();
      Object.assign(node.style, { left: `${area.left}px`, top: `${area.top}px`, width: `${area.width}px`, height: `${area.height}px` });
      return;
    }
    place.w = Math.min(Math.max(minWidth, place.w), window.innerWidth);
    place.h = Math.min(Math.max(minHeight, place.h), window.innerHeight);
    place.x = Math.max(EDGE - place.w, Math.min(place.x, window.innerWidth - EDGE));
    place.y = Math.max(0, Math.min(place.y, window.innerHeight - EDGE));
    Object.assign(node.style, { left: `${place.x}px`, top: `${place.y}px`, width: `${place.w}px`, height: `${place.h}px` });
  };

  /** Brings the whole window back in after the app has shrunk around it. */
  const fit = () => {
    apply();
    place.x = Math.max(0, Math.min(place.x, window.innerWidth - place.w));
    place.y = Math.max(0, Math.min(place.y, window.innerHeight - place.h));
    apply();
  };

  const tracked = (move, done) => (down) => {
    if (down.button !== 0 || maximized) return;
    down.preventDefault();
    const from = { x: down.clientX, y: down.clientY, ...place };
    const onMove = (e) => { move(e.clientX - from.x, e.clientY - from.y, from); apply(); };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      done();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  const remember = () => savePlace(id, { x: place.x, y: place.y, w: place.w, h: place.h });

  const dragStart = tracked((dx, dy, from) => { place.x = from.x + dx; place.y = from.y + dy; }, remember);
  bar.addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) dragStart(e); });
  grip.addEventListener('pointerdown', tracked((dx, dy, from) => { place.w = from.w + dx; place.h = from.h + dy; }, remember));

  const toggleMaximize = () => {
    maximized = !maximized;
    node.classList.toggle('maximized', maximized);
    setIcon(maxButton, maximized ? 'restore' : 'max');
    apply();
  };
  maxButton.addEventListener('click', toggleMaximize);
  bar.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) toggleMaximize(); });

  const win = {
    node,
    bar,
    body,
    get maximized() { return maximized; },
    toggleMaximize,
    setStatus(text) { status.textContent = text; },
    setBody(...children) { clear(body, ...children); },
    close() {
      if (!open.delete(win)) return;
      closeMenu();
      node.remove();
      window.removeEventListener('resize', fit);
      onClose?.();
    },
  };
  closeButton.addEventListener('click', win.close);
  node.addEventListener('pointerdown', () => focus(win), true);

  for (const [name, items] of Object.entries(menus)) {
    const titleNode = el('div', {
      class: 'menu-title',
      onMousedown: (e) => {
        e.stopPropagation();
        if (titleNode.classList.contains('open')) { closeMenu(); return; }
        const rect = titleNode.getBoundingClientRect();
        titleNode.classList.add('open');
        showMenu(items(), rect.left, rect.bottom, { onClose: () => titleNode.classList.remove('open') });
      },
    }, name);
    menubar.append(titleNode);
  }

  window.addEventListener('resize', fit);
  open.add(win);
  document.getElementById('floats').append(node);
  fit();
  focus(win);
  return win;
}
