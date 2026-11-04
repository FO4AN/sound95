// A picture, GIF or video of your own behind the app. It can be blurred, and it can
// move with the music: GIFs and videos play faster when it's loud and stop when it
// stops, and everything pulses with the bass. The file is kept in IndexedDB, since
// localStorage is too small for most GIFs.

import { tr } from './i18n.js';
import { setStatus } from './dom.js';
import { gifFrames, parseGif } from './gif.js';
import { onAudio } from './visualizer.js';

const DB = 'sound95';
const STORE = 'files';
const KEY = 'background';
const BLUR_KEY = 'sound95.backdropBlur';
const MOVE_KEY = 'sound95.backdropMove';
export const MAX_BYTES = 200 * 1024 * 1024;

const SLOWEST = 0.25;
const FASTEST = 2;
const PULSE = 0.06;

/* ---------- Storage ---------- */

function store(mode, work) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      tx.oncomplete = () => { db.close(); resolve(request?.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

const loadFile = () => store('readonly', (s) => s.get(KEY)).catch(() => null);
const saveFile = (file) => store('readwrite', (s) => s.put(file, KEY));
const forgetFile = () => store('readwrite', (s) => s.delete(KEY));

const flag = (key) => { try { return localStorage.getItem(key) === '1'; } catch { return false; } };
const setFlag = (key, on) => { try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* optional */ } };

export const backdropBlur = () => flag(BLUR_KEY);
export const backdropMoves = () => flag(MOVE_KEY);

/** What kind of picture a file is, or null if it can't be shown. */
export function kindOf(file) {
  const type = file?.type || '';
  const name = (file?.name || '').toLowerCase();
  if (type === 'image/gif' || name.endsWith('.gif')) return 'gif';
  if (type.startsWith('image/') || /\.(png|jpe?g|webp|bmp|avif|svg)$/.test(name)) return 'image';
  if (type.startsWith('video/') || /\.(mp4|webm|ogv|mov|mkv)$/.test(name)) return 'video';
  return null;
}

/** Why a file can't be the background, or null if it can. */
export function refusal(file) {
  if (!kindOf(file)) return tr('Sound95 can\'t show that kind of file.');
  if (file.size > MAX_BYTES) return tr('That file is too big. Pick one under 200 MB.');
  return null;
}

/* ---------- Showing it ---------- */

const layer = () => document.getElementById('backdrop');
let current = null; // { file, kind, url }
let stopMotion = null;

function media(kind, url) {
  if (kind === 'video') {
    const video = document.createElement('video');
    Object.assign(video, { src: url, muted: true, loop: true, autoplay: true, playsInline: true });
    video.setAttribute('muted', '');
    return video;
  }
  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  return img;
}

/** Plays a GIF onto a canvas at whatever speed `speed()` says. */
async function gifCanvas(file) {
  const gif = gifFrames(parseGif(await file.arrayBuffer()));
  const canvas = document.createElement('canvas');
  canvas.width = gif.width;
  canvas.height = gif.height;
  const ctx = canvas.getContext('2d');
  // Wraps the decoder's own pixels without a copy, so it always holds the latest frame.
  const picture = new ImageData(gif.step(), gif.width, gif.height);
  ctx.putImageData(picture, 0, 0);
  let owed = 0;
  return {
    canvas,
    advance(ms) {
      // A still GIF never changes, so there is nothing to redraw.
      if (gif.count === 1) return;
      owed += ms;
      // A long pause shouldn't race through the frames it missed.
      owed = Math.min(owed, gif.delay * 4);
      let moved = false;
      while (owed >= gif.delay) {
        owed -= gif.delay;
        gif.step();
        moved = true;
      }
      // Only the last frame stepped through is ever seen, so only it is uploaded.
      if (moved) ctx.putImageData(picture, 0, 0);
    },
  };
}

function startMotion(node, gif) {
  let level = 0;
  let pulse = 0;
  let last = performance.now();
  const stop = onAudio(({ level: heard, bass, playing }) => {
    const now = performance.now();
    const ms = Math.min(250, now - last);
    last = now;
    level += ((playing ? heard : 0) - level) * 0.2;
    pulse = Math.max(playing ? bass : 0, pulse * 0.85);
    const speed = playing ? SLOWEST + (FASTEST - SLOWEST) * Math.min(1, level * 1.25) : 0;
    layer().style.setProperty('--pulse', String(1 + pulse * PULSE));
    if (gif) gif.advance(ms * speed);
    if (node instanceof HTMLVideoElement) {
      if (!playing) node.pause();
      else {
        node.playbackRate = Math.max(SLOWEST, speed);
        if (node.paused) node.play().catch(() => {});
      }
    }
  });
  return () => { stop(); layer().style.removeProperty('--pulse'); };
}

async function render() {
  stopMotion?.();
  stopMotion = null;
  const root = document.documentElement;
  const box = layer();
  box.replaceChildren();
  box.classList.toggle('blur', backdropBlur());
  root.classList.toggle('has-backdrop', !!current);
  if (!current) return;
  const moves = backdropMoves();
  let node = null;
  let gif = null;
  if (current.kind === 'gif' && moves) {
    try {
      gif = await gifCanvas(current.file);
      node = gif.canvas;
    } catch {
      gif = null; // Not one we can read, but the browser may still show it.
    }
  }
  node ||= media(current.kind, current.url);
  node.addEventListener('error', () => setStatus(tr('Sound95 can\'t show that kind of file.')));
  box.dataset.kind = gif ? 'gif-canvas' : current.kind;
  box.append(node);
  if (moves) stopMotion = startMotion(node, gif);
}

function use(file) {
  if (current?.url) URL.revokeObjectURL(current.url);
  current = file ? { file, kind: kindOf(file), url: URL.createObjectURL(file) } : null;
}

/** Puts back the saved background when the app starts. */
export async function restoreBackdrop() {
  const file = await loadFile();
  use(file && kindOf(file) ? file : null);
  await render();
}

export const hasBackdrop = () => !!current;
export const currentBackdrop = () => current && { kind: current.kind, url: current.url };
export const backdropName = () => current?.file.name || '';

/**
 * Changes the background. `file` is a new one, null to remove it, or undefined to
 * keep the one there is.
 */
export async function setBackdrop({ file, blur, moves }) {
  setFlag(BLUR_KEY, blur);
  setFlag(MOVE_KEY, moves);
  if (file === null) {
    await forgetFile().catch(() => {});
    use(null);
  } else if (file) {
    // Stored as a Blob of its own, so the original File can go away.
    const kept = new File([file], file.name, { type: file.type });
    await saveFile(kept);
    use(kept);
  }
  await render();
}
