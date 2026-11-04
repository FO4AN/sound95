// Floating Win95 windows inside the app, for things that stay up while you browse.
// Dragged by the title bar, sized by the corner grip, and remembered between runs.

import { tr } from './i18n.js';
import { el, clear } from './dom.js';
import { icon, setIcon } from './icons.js';
import { closeMenu, showMenu } from './dialogs.js';
import { leave } from './motion.js';

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
  const closeButton = el('button', { class: 'caption', ariaLabel: tr('Close') }, icon('close'));
  const maxButton = el('button', { class: 'caption', ariaLabel: tr('Maximize') }, icon('max'));
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
      Object.assign(node.style, { transform: `translate(${area.left}px, ${area.top}px)`, width: `${area.width}px`, height: `${area.height}px` });
      return;
    }
    place.w = Math.min(Math.max(minWidth, place.w), window.innerWidth);
    place.h = Math.min(Math.max(minHeight, place.h), window.innerHeight);
    place.x = Math.max(EDGE - place.w, Math.min(place.x, window.innerWidth - EDGE));
    place.y = Math.max(0, Math.min(place.y, window.innerHeight - EDGE));
    // A transform moves the finished window, where left and top would lay out and
    // repaint it each time, which makes a busy one like karaoke stutter.
    Object.assign(node.style, { transform: `translate(${Math.round(place.x)}px, ${Math.round(place.y)}px)`, width: `${place.w}px`, height: `${place.h}px` });
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
    const handle = down.currentTarget;
    const from = { ...place };
    let latest = null;
    let frame = 0;
    const paint = () => {
      frame = 0;
      if (!latest) return;
      move(latest.clientX - down.clientX, latest.clientY - down.clientY, from);
      latest = null;
      apply();
    };
    const finish = () => {
      for (const name of ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
        window.removeEventListener(name, name === 'pointermove' ? onMove : finish);
      }
      cancelAnimationFrame(frame);
      paint();
      done();
    };
    const onMove = (e) => {
      // A button let go outside the app never reports it, so don't stay stuck to the pointer.
      if (!e.buttons) { finish(); return; }
      latest = e;
      frame ||= requestAnimationFrame(paint);
    };
    // Keeps the drag going past the edge of the app, where the window would lose it.
    try { handle.setPointerCapture(down.pointerId); } catch { /* not a real pointer */ }
    window.addEventListener('pointermove', onMove);
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) window.addEventListener(name, finish);
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
      leave(node);
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
    }, tr(name));
    menubar.append(titleNode);
  }

  window.addEventListener('resize', fit);
  open.add(win);
  document.getElementById('floats').append(node);
  fit();
  focus(win);
  return win;
}
