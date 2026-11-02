// Music visualizer, drawn from the real audio. The backend taps the app's own sound
// and sends frequency bands; where it can't (no PipeWire), bars follow the track's
// published loudness instead and the status bar says so.

import { api, paths } from './api.js';
import { el, errorText, setStatus } from './dom.js';
import { showMenu } from './dialogs.js';
import { durationMs, onPlayerChange, player, positionMs } from './player.js';
import { loudness } from './waveform.js';
import { floatWindow } from './windows.js';

const BANDS = 32;
const WAVE = 96;
const FALL = 0.035;
const PEAK_FALL = 0.006;
const PEAK_HOLD = 0.75;
const STOP_DELAY_MS = 4000;
const STALE_MS = 400;
const DRAW_EVERY_MS = 30; // the audio arrives at 30 frames a second, so 60 would redraw the same thing
const NO_AUDIO_AFTER_MS = 3000;
const MODE_KEY = 'sound95.visual';
const PIXEL = 2;

const VGA = ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ffffff'];
const LIT = ['#00ff00', '#ffff00', '#ff0000'];
const UNLIT = ['#003000', '#303000', '#300000'];

const audio = {
  bands: new Float32Array(BANDS),
  peaks: new Float32Array(BANDS),
  wave: new Float32Array(WAVE),
  target: new Float32Array(BANDS),
  waveTarget: new Float32Array(WAVE),
  level: 0,
  frameAt: 0,
  liveAt: 0,
  available: true,
  outputMs: 0,
};
const arriving = [];

let capturing = false;
let stopTimer = null;
let drawing = false;
let drawnAt = 0;
const surfaces = new Set();

/* ---------- Audio ---------- */

window.__TAURI__.event.listen('sound95:visual', ({ payload }) => {
  const now = performance.now();
  audio.outputMs = payload.outputMs;
  if (payload.live) audio.liveAt = now;
  arriving.push({ at: now, payload });
  wake();
});

/** Bluetooth plays late, so frames wait until their sound is actually heard. */
function applyHeardFrames(now) {
  let frame = null;
  while (arriving.length && now - arriving[0].at >= audio.outputMs) frame = arriving.shift().payload;
  if (!frame) return;
  audio.level = frame.level / 255;
  audio.frameAt = now;
  frame.bands.forEach((v, i) => { audio.target[i] = v / 255; });
  frame.wave.forEach((v, i) => { audio.waveTarget[i] = v / 127; });
}

/** How far the sound you hear runs behind the sound being played. */
export const outputDelayMs = () => audio.outputMs;

function syncCapture() {
  const want = surfaces.size > 0 && player.playing;
  if (want) {
    clearTimeout(stopTimer);
    stopTimer = null;
    if (!capturing) {
      capturing = true;
      audio.liveAt = performance.now();
      api.visualStart().then((ok) => { audio.available = ok; }, (e) => {
        audio.available = false;
        setStatus(errorText(e));
      });
    }
  } else if (capturing && !stopTimer) {
    // Tracks pause for a moment as they change, which shouldn't restart the tap.
    stopTimer = setTimeout(() => {
      capturing = false;
      stopTimer = null;
      api.visualStop();
    }, STOP_DELAY_MS);
  }
  wake();
}

let published = null;
let publishedFor = null;
function loadPublished() {
  const track = player.current;
  if (!track || publishedFor === track.urn) return;
  publishedFor = track.urn;
  published = null;
  api.get(paths.track(track.urn))
    .then((raw) => loudness(raw.waveform_url))
    .then((values) => { if (publishedFor === track.urn) published = values; })
    .catch(() => {});
}

/** Stand-in when there's no live audio: real loudness, invented shape. */
function fromLoudness(now) {
  loadPublished();
  const total = durationMs();
  const value = published && total ? published[Math.floor((positionMs() / total) * published.length)] || 0 : 0.4;
  for (let i = 0; i < BANDS; i++) {
    const shape = 1 - (i / BANDS) * 0.6;
    const ripple = 0.65 + 0.35 * Math.sin(i * 0.9 + now / 170) * Math.sin(i * 0.37 - now / 310);
    audio.target[i] = Math.min(1, value * shape * ripple * 1.5);
  }
  for (let i = 0; i < WAVE; i++) audio.waveTarget[i] = value * Math.sin(i * 0.5 + now / 40) * Math.sin(i * 0.07);
  audio.level = value;
}

/** A new track takes a moment to reach the tap, so give it time before giving up. */
const usable = (now = performance.now()) => capturing && audio.available && now - audio.liveAt < NO_AUDIO_AFTER_MS;

function step(now) {
  applyHeardFrames(now);
  if (player.playing && !usable(now)) fromLoudness(now);
  else if (!player.playing || now - audio.frameAt > STALE_MS) { audio.target.fill(0); audio.waveTarget.fill(0); audio.level = 0; }
  let moving = false;
  for (let i = 0; i < BANDS; i++) {
    audio.bands[i] = Math.max(audio.target[i], audio.bands[i] - FALL);
    audio.peaks[i] = audio.bands[i] >= audio.peaks[i] ? audio.bands[i] : Math.max(0, audio.peaks[i] - PEAK_FALL);
    moving ||= audio.peaks[i] > 0;
  }
  for (let i = 0; i < WAVE; i++) audio.wave[i] += (audio.waveTarget[i] - audio.wave[i]) * 0.6;
  return moving || player.playing;
}

const bass = () => (audio.bands[0] + audio.bands[1] + audio.bands[2] + audio.bands[3]) / 4;

/* ---------- Drawing ---------- */

function clearTo(ctx, w, h, color = '#000000') {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
}

/** A line with no smoothing, because Windows 95 had none. */
function line(ctx, x0, y0, x1, y1) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1) | 0;
  for (let i = 0; i <= steps; i++) {
    ctx.fillRect(Math.round(x0 + ((x1 - x0) * i) / steps), Math.round(y0 + ((y1 - y0) * i) / steps), 1, 1);
  }
}

function drawBars(ctx, w, h) {
  clearTo(ctx, w, h);
  const columns = w >= BANDS * 4 ? BANDS : Math.floor(BANDS / 2);
  const cell = Math.max(2, Math.floor(w / columns));
  const left = Math.floor((w - cell * columns) / 2);
  const rowHeight = h >= 60 ? 3 : 2;
  const rows = Math.floor(h / rowHeight);
  for (let c = 0; c < columns; c++) {
    const band = Math.floor((c / columns) * BANDS);
    const lit = Math.round(audio.bands[band] * rows);
    const peak = Math.round(audio.peaks[band] * rows);
    for (let r = 0; r < rows; r++) {
      const zone = r / rows < 0.6 ? 0 : r / rows < 0.85 ? 1 : 2;
      ctx.fillStyle = r < lit ? LIT[zone] : UNLIT[zone];
      if (r === peak - 1 && audio.peaks[band] > 0.02) ctx.fillStyle = '#ffffff';
      ctx.fillRect(left + c * cell, h - (r + 1) * rowHeight, cell - 1, rowHeight - 1);
    }
  }
}

function drawScope(ctx, w, h) {
  clearTo(ctx, w, h);
  ctx.fillStyle = '#004000';
  for (let x = 0; x <= w; x += Math.ceil(w / 10)) ctx.fillRect(x, 0, 1, h);
  for (let y = 0; y <= h; y += Math.ceil(h / 6)) ctx.fillRect(0, y, w, 1);
  ctx.fillStyle = '#008000';
  ctx.fillRect(0, Math.floor(h / 2), w, 1);
  ctx.fillStyle = '#00ff00';
  let last = null;
  for (let x = 0; x < w; x++) {
    const at = (x / w) * (WAVE - 1);
    const from = Math.floor(at);
    const value = audio.wave[from] + (audio.wave[from + 1] - audio.wave[from]) * (at - from);
    const y = Math.round(h / 2 - value * (h / 2 - 2));
    if (last != null) ctx.fillRect(x, Math.min(last, y), 1, Math.abs(last - y) + 1);
    last = y;
  }
}

function makeShape(colorIndex) {
  const points = Array.from({ length: 4 }, () => ({
    x: Math.random(), y: Math.random(),
    dx: (Math.random() + 0.3) * (Math.random() < 0.5 ? -1 : 1),
    dy: (Math.random() + 0.3) * (Math.random() < 0.5 ? -1 : 1),
  }));
  return { points, colorIndex, trail: [] };
}

const TRAIL = 7;

function drawMystify(ctx, w, h, memory) {
  memory.shapes ||= [makeShape(1), makeShape(3)];
  clearTo(ctx, w, h);
  const speed = 0.0016 + audio.level * 0.0075;
  const kick = bass();
  if (kick - (memory.lastBass || 0) > 0.14) {
    for (const shape of memory.shapes) shape.colorIndex = (shape.colorIndex + 1) % VGA.length;
  }
  memory.lastBass = kick;
  for (const shape of memory.shapes) {
    for (const p of shape.points) {
      p.x += p.dx * speed;
      p.y += p.dy * speed;
      if (p.x < 0 || p.x > 1) { p.dx = -p.dx; p.x = Math.min(1, Math.max(0, p.x)); }
      if (p.y < 0 || p.y > 1) { p.dy = -p.dy; p.y = Math.min(1, Math.max(0, p.y)); }
    }
    shape.trail.push(shape.points.map((p) => [p.x * (w - 1), p.y * (h - 1)]));
    if (shape.trail.length > TRAIL) shape.trail.shift();
    ctx.fillStyle = VGA[shape.colorIndex];
    for (const pts of shape.trail) {
      pts.forEach(([x, y], i) => {
        const [nx, ny] = pts[(i + 1) % pts.length];
        line(ctx, x, y, nx, ny);
      });
    }
  }
}

function drawStars(ctx, w, h, memory) {
  memory.stars ||= Array.from({ length: 140 }, () => ({ x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random() }));
  clearTo(ctx, w, h);
  const speed = 0.003 + bass() * bass() * 0.04;
  for (const star of memory.stars) {
    star.z -= speed;
    if (star.z <= 0.02) {
      star.x = Math.random() * 2 - 1;
      star.y = Math.random() * 2 - 1;
      star.z = 1;
    }
    const x = w / 2 + (star.x / star.z) * (w / 2);
    const y = h / 2 + (star.y / star.z) * (h / 2);
    if (x < 0 || x >= w || y < 0 || y >= h) continue;
    ctx.fillStyle = star.z > 0.66 ? '#808080' : star.z > 0.33 ? '#c0c0c0' : '#ffffff';
    const size = star.z < 0.25 ? 2 : 1;
    ctx.fillRect(Math.round(x), Math.round(y), size, size);
  }
}

export const MODES = {
  bars: { label: 'Spectrum', draw: drawBars },
  scope: { label: 'Oscilloscope', draw: drawScope },
  mystify: { label: 'Mystify', draw: drawMystify },
  stars: { label: 'Starfield', draw: drawStars },
};

function frame(now) {
  if (now - drawnAt < DRAW_EVERY_MS) {
    requestAnimationFrame(frame);
    return;
  }
  drawnAt = now;
  const going = step(now);
  for (const surface of surfaces) {
    const { canvas, mode, memory, pixel } = surface;
    if (!canvas.isConnected || !canvas.clientWidth) continue;
    const w = Math.max(1, Math.round(canvas.clientWidth / pixel));
    const h = Math.max(1, Math.round(canvas.clientHeight / pixel));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    MODES[mode].draw(canvas.getContext('2d'), w, h, memory);
  }
  if (going) requestAnimationFrame(frame);
  else drawing = false;
}

function wake() {
  if (drawing) return;
  drawing = true;
  requestAnimationFrame(frame);
}

/** Starts drawing onto a canvas. Returns its handle, with `mode` and `detach()`. */
export function attachVisual(canvas, { mode = 'bars', pixel = 1 } = {}) {
  const surface = {
    canvas, mode, pixel, memory: {},
    detach() { surfaces.delete(surface); syncCapture(); },
  };
  surfaces.add(surface);
  syncCapture();
  return surface;
}

/* ---------- The window ---------- */

let win = null;
const visibleListeners = new Set();
export const onVisualizerToggle = (fn) => visibleListeners.add(fn);
export const visualizerOpen = () => !!win;

function savedMode() {
  try {
    const mode = localStorage.getItem(MODE_KEY);
    return MODES[mode] ? mode : 'bars';
  } catch { return 'bars'; }
}

export function toggleVisualizer() {
  if (win) { win.close(); return; }
  const canvas = el('canvas', { class: 'viz-canvas' });
  const surface = attachVisual(canvas, { mode: savedMode(), pixel: PIXEL });
  const modeItems = () => Object.entries(MODES).map(([id, { label }]) => ({
    label,
    checked: surface.mode === id,
    action: () => {
      surface.mode = id;
      surface.memory = {};
      try { localStorage.setItem(MODE_KEY, id); } catch { /* optional */ }
      describe();
    },
  }));
  let timer = null;
  win = floatWindow({
    id: 'visualizer',
    title: 'Visualizer',
    iconName: 'bars',
    width: 440,
    height: 300,
    menus: { Mode: modeItems },
    onClose: () => {
      clearInterval(timer);
      surface.detach();
      win = null;
      visibleListeners.forEach((fn) => fn());
    },
  });
  canvas.addEventListener('dblclick', () => win.toggleMaximize());
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(modeItems(), e.clientX, e.clientY); });
  win.setBody(canvas);
  function describe() {
    if (!win) return;
    const source = !player.playing ? 'Waiting for music' : usable() ? 'Live audio' : 'Track loudness only';
    win.setStatus(`${MODES[surface.mode].label} - ${source}`);
  }
  describe();
  timer = setInterval(describe, 500);
  visibleListeners.forEach((fn) => fn());
}

onPlayerChange(syncCapture);
