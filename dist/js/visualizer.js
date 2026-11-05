// Music visualizer, drawn from the real audio. The backend taps the app's own sound
// and sends frequency bands; where it can't (no PipeWire), bars follow the track's
// published loudness instead and the status bar says so. Bars stand as tall as
// the music is loud, at the volume it plays at, unless that's turned off in Settings.

import { tr } from './i18n.js';
import { api, paths } from './api.js';
import { el, errorText, setStatus } from './dom.js';
import { showMenu } from './dialogs.js';
import { durationMs, getVolume, onPlayerChange, player, positionMs } from './player.js';
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
const FOLLOW_KEY = 'sound95.vizFollow';
const LOUDEST_KEY = 'sound95.loudest';
// The backend shows this many dB below its reference, so a dB is this much of the height.
const RANGE_DB = 54;
// How fast the memory of the loudest music fades, in dB a frame: about 7 dB a minute,
// so a quiet stretch stays quiet but a quiet album gets its height back eventually.
const LOUDEST_FALL = 0.004;
// Sound already on its way to the tap was played at the old volume, so frames this
// soon after a change say nothing about how loud the music is.
const VOLUME_SETTLE_MS = 300;
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

let follows = (() => { try { return localStorage.getItem(FOLLOW_KEY) !== '0'; } catch { return true; } })();
let loudest = (() => { try { return Number(localStorage.getItem(LOUDEST_KEY)) || -Infinity; } catch { return -Infinity; } })();

export const followsVolume = () => follows;
export function setFollowsVolume(on) {
  follows = on;
  try { localStorage.setItem(FOLLOW_KEY, on ? '1' : '0'); } catch { /* optional */ }
}

const volumeDb = (volume = getVolume()) => 20 * Math.log10(Math.max(volume, 0.001));

/**
 * How far to lower everything, as a share of the height. The backend scales the
 * bands to `peak`, the loudest band lately in dB. The loudest the music itself has
 * been lately (with the volume taken back out) fills the display at full volume, so
 * quiet passages and a lower volume both show lower.
 */
function quietBy({ payload: frame, volume, settled }) {
  if (!follows || !Number.isFinite(frame.peak)) return 0;
  // This frame's own loudest band. The backend's peak falls slowly, so right after
  // the volume goes down it would pass for much louder music.
  const own = frame.peak - RANGE_DB * (1 - Math.max(...frame.bands) / 255);
  if (frame.level > 0 && volume > 0 && settled) {
    loudest = Math.max(own - volumeDb(volume), loudest - LOUDEST_FALL);
  } else {
    loudest -= LOUDEST_FALL; // silence, mute or a volume change still reaching the tap
  }
  return Math.min(1, Math.max(0, (loudest - frame.peak) / RANGE_DB));
}

let capturing = false;
let stopTimer = null;
let drawing = false;
let drawnAt = 0;
let seenVolume = null;
let volumeChangedAt = -Infinity;
const surfaces = new Set();
const audioListeners = new Set();

/* ---------- Audio ---------- */

window.__TAURI__.event.listen('sound95:visual', ({ payload }) => {
  const now = performance.now();
  audio.outputMs = payload.outputMs;
  if (payload.live) audio.liveAt = now;
  // Stamped as it arrives, since Bluetooth holds it back until after a change is old.
  const volume = getVolume();
  if (volume !== seenVolume) { seenVolume = volume; volumeChangedAt = now; }
  arriving.push({ at: now, payload, volume, settled: now - volumeChangedAt >= VOLUME_SETTLE_MS });
  wake();
});

/** Bluetooth plays late, so frames wait until their sound is actually heard. */
function applyHeardFrames(now) {
  let heard = null;
  while (arriving.length && now - arriving[0].at >= audio.outputMs) heard = arriving.shift();
  if (!heard) return;
  const frame = heard.payload;
  const lower = quietBy(heard);
  const shrink = 10 ** ((-lower * RANGE_DB) / 20);
  audio.level = Math.max(0, frame.level / 255 - lower);
  audio.frameAt = now;
  frame.bands.forEach((v, i) => { audio.target[i] = Math.max(0, v / 255 - lower); });
  frame.wave.forEach((v, i) => { audio.waveTarget[i] = (v / 127) * shrink; });
}

/** How far the sound you hear runs behind the sound being played. */
export const outputDelayMs = () => audio.outputMs;

document.addEventListener('visibilitychange', () => syncCapture());

function syncCapture() {
  const want = (surfaces.size > 0 || audioListeners.size > 0) && player.playing && !document.hidden;
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
      if (Number.isFinite(loudest)) {
        try { localStorage.setItem(LOUDEST_KEY, String(loudest)); } catch { /* optional */ }
      }
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
  const loudness = published && total ? published[Math.floor((positionMs() / total) * published.length)] || 0 : 0.4;
  const value = follows ? loudness * Math.max(0, 1 + volumeDb() / RANGE_DB) : loudness;
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

/* A fillRect per pixel costs milliseconds on a big window, so modes made of single
   pixels write them into an image and draw that once. */
const packer = new Uint8ClampedArray(4);
const packed = new Uint32Array(packer.buffer);

/** A '#rrggbb' or 'rgb(r,g,b)' colour as one pixel of an image's Uint32Array. */
function packColor(color) {
  const rgb = color.startsWith('#') ? [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)) : color.match(/\d+/g).map(Number);
  packer.set([...rgb, 255]);
  return packed[0];
}

const BLACK32 = packColor('#000000');
const VGA32 = VGA.map(packColor);

/** The surface's own image of this size, with one number per pixel. */
function imageOf(memory, w, h) {
  if (memory.image?.width !== w || memory.image.height !== h) {
    memory.image = new ImageData(w, h);
    memory.pixels = new Uint32Array(memory.image.data.buffer);
  }
  return memory.pixels;
}

/** line(), into an image. */
function linePx(pixels, w, h, color, x0, y0, x1, y1) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1) | 0;
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps);
    const y = Math.round(y0 + ((y1 - y0) * i) / steps);
    if (x >= 0 && x < w && y >= 0 && y < h) pixels[y * w + x] = color;
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
  const pixels = imageOf(memory, w, h);
  pixels.fill(BLACK32);
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
    const color = VGA32[shape.colorIndex];
    for (const pts of shape.trail) {
      pts.forEach(([x, y], i) => {
        const [nx, ny] = pts[(i + 1) % pts.length];
        linePx(pixels, w, h, color, x, y, nx, ny);
      });
    }
  }
  ctx.putImageData(memory.image, 0, 0);
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

/* Black through blue, red and yellow to white, for how loud a band is. */
const HEAT = Array.from({ length: 48 }, (_, i) => {
  const v = i / 47;
  const channel = (from, span) => Math.round(255 * Math.min(1, Math.max(0, (v - from) / span)));
  return `rgb(${channel(0.2, 0.3)},${channel(0.5, 0.3)},${Math.max(channel(0, 0.25) - channel(0.25, 0.25), channel(0.8, 0.2))})`;
});
const HEAT32 = HEAT.map(packColor);
const heatAt = (v) => Math.min(HEAT.length - 1, Math.floor(v * HEAT.length));
const heat = (v) => HEAT[heatAt(v)];

function average(from, to) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += audio.bands[i];
  return sum / (to - from);
}

function drawMeters(ctx, w, h, memory) {
  clearTo(ctx, w, h, '#202020');
  memory.needles ||= [0, 0];
  const gap = 4;
  const width = Math.floor((w - gap * 3) / 2);
  const height = h - gap * 2;
  [average(0, BANDS / 2), average(BANDS / 2, BANDS)].forEach((level, i) => {
    memory.needles[i] += (Math.min(1, level * 1.3) - memory.needles[i]) * 0.35;
    const left = gap + i * (width + gap);
    ctx.fillStyle = '#ffffe1';
    ctx.fillRect(left, gap, width, height);
    const cx = left + width / 2;
    const cy = gap + height * 0.92;
    const radius = Math.min(width * 0.46, height * 0.8);
    const point = (at, reach) => {
      const angle = Math.PI * (-0.75 + at * 0.5);
      return [cx + Math.cos(angle) * reach, cy + Math.sin(angle) * reach];
    };
    for (let tick = 0; tick <= 20; tick++) {
      ctx.fillStyle = tick >= 15 ? '#ff0000' : '#000000';
      line(ctx, ...point(tick / 20, radius), ...point(tick / 20, radius - (tick % 5 ? 2 : 5)));
    }
    ctx.fillStyle = '#800000';
    line(ctx, cx, cy, ...point(memory.needles[i], radius - 1));
    ctx.fillStyle = '#000000';
    ctx.fillRect(cx - 3, cy - 3, 7, 7);
  });
}

function drawWaterfall(ctx, w, h, memory) {
  if (!memory.started) { clearTo(ctx, w, h); memory.started = true; }
  ctx.drawImage(ctx.canvas, 0, -1);
  const cell = Math.ceil(w / BANDS);
  for (let band = 0; band < BANDS; band++) {
    ctx.fillStyle = heat(audio.bands[band]);
    ctx.fillRect(Math.floor((band / BANDS) * w), h - 1, cell, 1);
  }
}

function drawSunburst(ctx, w, h, memory) {
  const pixels = imageOf(memory, w, h);
  pixels.fill(BLACK32);
  memory.spin = (memory.spin || 0) + 0.004 + bass() * 0.05;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) / 2 - 2;
  const inner = radius * (0.16 + bass() * 0.14);
  const spokes = BANDS * 2;
  for (let i = 0; i < spokes; i++) {
    const value = audio.bands[i < BANDS ? i : spokes - 1 - i];
    const angle = memory.spin + (i / spokes) * Math.PI * 2;
    const reach = inner + value * (radius - inner);
    const color = HEAT32[heatAt(0.35 + value * 0.65)];
    linePx(pixels, w, h, color, cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner, cx + Math.cos(angle) * reach, cy + Math.sin(angle) * reach);
  }
  ctx.putImageData(memory.image, 0, 0);
}

const PLASMA = Array.from({ length: 64 }, (_, i) => {
  const wave = (shift) => Math.round(127 + 127 * Math.sin((i / 64) * Math.PI * 2 + shift));
  return `rgb(${wave(0)},${wave(2.1)},${wave(4.2)})`;
});
const PLASMA32 = PLASMA.map(packColor);

function drawPlasma(ctx, w, h, memory) {
  memory.time = (memory.time || 0) + 0.015 + audio.level * 0.09;
  const time = memory.time;
  const size = Math.max(3, Math.ceil(w / 90));
  // One pixel per cell on a small canvas, then scaled up without smoothing.
  const columns = Math.ceil(w / size);
  const rows = Math.ceil(h / size);
  const pixels = imageOf(memory, columns, rows);
  for (let row = 0; row < rows; row++) {
    const y = row * size;
    for (let column = 0; column < columns; column++) {
      const x = column * size;
      const value = Math.sin(x * 0.04 + time) + Math.sin(y * 0.06 - time * 1.3)
        + Math.sin((x + y) * 0.03 + time * 0.7) + Math.sin(Math.hypot(x - w / 2, y - h / 2) * 0.05 - time * 1.7);
      pixels[row * columns + column] = PLASMA32[Math.floor(((value + 4) / 8) * 63 + time * 6) % 64];
    }
  }
  if (memory.cells?.width !== columns || memory.cells.height !== rows) {
    memory.cells = Object.assign(document.createElement('canvas'), { width: columns, height: rows });
  }
  memory.cells.getContext('2d').putImageData(memory.image, 0, 0);
  ctx.imageSmoothingEnabled = false; // resizing the canvas turns it back on
  ctx.drawImage(memory.cells, 0, 0, columns * size, rows * size);
}

const DIRECTIONS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const PIPE_COLORS = [['#800000', '#ff0000'], ['#008000', '#00ff00'], ['#000080', '#0000ff'], ['#808000', '#ffff00'], ['#008080', '#00ffff'], ['#800080', '#ff00ff']];

function newPipe(columns, rows) {
  return {
    x: Math.floor(Math.random() * columns),
    y: Math.floor(Math.random() * rows),
    direction: Math.floor(Math.random() * 4),
    colors: PIPE_COLORS[Math.floor(Math.random() * PIPE_COLORS.length)],
  };
}

function drawPipes(ctx, w, h, memory) {
  const cell = Math.max(8, Math.floor(Math.min(w, h) / 12));
  const columns = Math.floor(w / cell);
  const rows = Math.floor(h / cell);
  if (!memory.pipe || memory.drawn > columns * rows * 1.5) {
    clearTo(ctx, w, h);
    memory.pipe = newPipe(columns, rows);
    memory.drawn = 0;
    memory.owed = 0;
  }
  const width = Math.max(3, Math.floor(cell * 0.55));
  const center = (n) => Math.floor(n * cell + cell / 2);
  memory.owed += 0.12 + audio.level * 0.9;
  for (; memory.owed >= 1; memory.owed -= 1) {
    const pipe = memory.pipe;
    if (Math.random() < 0.3) pipe.direction = (pipe.direction + (Math.random() < 0.5 ? 1 : 3)) % 4;
    const [dx, dy] = DIRECTIONS[pipe.direction];
    const x = pipe.x + dx;
    const y = pipe.y + dy;
    if (x < 0 || y < 0 || x >= columns || y >= rows) { memory.pipe = newPipe(columns, rows); continue; }
    const left = Math.min(center(pipe.x), center(x)) - (width >> 1);
    const top = Math.min(center(pipe.y), center(y)) - (width >> 1);
    const across = dx ? cell + width : width;
    const down = dy ? cell + width : width;
    ctx.fillStyle = pipe.colors[0];
    ctx.fillRect(left, top, across, down);
    ctx.fillStyle = pipe.colors[1];
    if (dx) ctx.fillRect(left, top + 1, across, Math.max(1, width >> 2));
    else ctx.fillRect(left + 1, top, Math.max(1, width >> 2), down);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(center(x) - 1, center(y) - 1, 2, 2);
    pipe.x = x;
    pipe.y = y;
    memory.drawn += 1;
  }
}

const FLAG = ['#ff0000', '#00c000', '#0000ff', '#ffff00'];

function drawFlags(ctx, w, h, memory) {
  memory.flags ||= Array.from({ length: 12 }, () => ({ x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random() }));
  memory.time = (memory.time || 0) + 0.15;
  clearTo(ctx, w, h);
  const speed = 0.004 + bass() * bass() * 0.03;
  memory.flags.sort((a, b) => b.z - a.z);
  for (const flag of memory.flags) {
    flag.z -= speed;
    if (flag.z <= 0.05) {
      flag.x = Math.random() * 2 - 1;
      flag.y = Math.random() * 2 - 1;
      flag.z = 1;
    }
    const size = Math.max(4, Math.round((Math.min(w, h) * 0.07) / flag.z));
    const x = w / 2 + (flag.x / flag.z) * (w / 2) - size / 2;
    const y = h / 2 + (flag.y / flag.z) * (h / 2) - size / 2;
    const columns = 8;
    const width = Math.ceil(size / columns);
    for (let c = 0; c < columns; c++) {
      const sway = Math.round(Math.sin(c * 0.9 + memory.time + flag.x * 9) * size * 0.07);
      const half = c < columns / 2 ? 0 : 1;
      const cx = Math.round(x + (c / columns) * size + half);
      ctx.fillStyle = FLAG[half];
      ctx.fillRect(cx, Math.round(y) + sway, width, Math.floor(size * 0.47));
      ctx.fillStyle = FLAG[half + 2];
      ctx.fillRect(cx, Math.round(y + size * 0.53) + sway, width, Math.floor(size * 0.47));
    }
  }
}

function drawMarquee(ctx, w, h, memory) {
  clearTo(ctx, w, h, '#000080');
  const text = player.current ? `${player.current.artist} - ${player.current.title}` : 'Sound95';
  const size = Math.max(10, Math.floor(h * 0.34));
  ctx.font = `700 ${size}px "Pixelated MS Sans Serif", Tahoma, Arial, sans-serif`;
  ctx.textBaseline = 'middle';
  memory.x ??= w;
  memory.time = (memory.time || 0) + 0.06;
  memory.x -= 1 + audio.level * 5;
  const width = ctx.measureText(text).width;
  if (memory.x < -width) memory.x = w;
  if (bass() - (memory.lastBass || 0) > 0.14) memory.color = ((memory.color || 0) + 1) % VGA.length;
  memory.lastBass = bass();
  const y = h / 2 + Math.sin(memory.time) * h * 0.14 - bass() * h * 0.12;
  ctx.fillStyle = '#000000';
  ctx.fillText(text, Math.round(memory.x) + 3, Math.round(y) + 3);
  ctx.fillStyle = VGA[memory.color || 0];
  ctx.fillText(text, Math.round(memory.x), Math.round(y));
}

export const MODES = {
  bars: { label: 'Spectrum', draw: drawBars },
  scope: { label: 'Oscilloscope', draw: drawScope },
  mystify: { label: 'Mystify', draw: drawMystify },
  stars: { label: 'Starfield', draw: drawStars },
  meters: { label: 'VU Meters', draw: drawMeters },
  waterfall: { label: 'Waterfall', draw: drawWaterfall },
  sunburst: { label: 'Sunburst', draw: drawSunburst },
  plasma: { label: 'Plasma', draw: drawPlasma },
  pipes: { label: '3D Pipes', draw: drawPipes },
  flags: { label: 'Flying Windows', draw: drawFlags },
  marquee: { label: 'Marquee', draw: drawMarquee },
};

function frame(now) {
  if (now - drawnAt < DRAW_EVERY_MS) {
    requestAnimationFrame(frame);
    return;
  }
  drawnAt = now;
  const going = step(now);
  for (const surface of surfaces) {
    const { canvas, mode, memory, pixel, width, height } = surface;
    if (!canvas.isConnected || !width) continue;
    const w = Math.max(1, Math.round(width / pixel));
    const h = Math.max(1, Math.round(height / pixel));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    MODES[mode].draw(canvas.getContext('2d'), w, h, memory);
  }
  const heard = { level: audio.level, bass: bass(), playing: player.playing };
  for (const fn of audioListeners) fn(heard);
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
  // The picture fills the content box, since padding isn't drawn on, and a new size
  // is redrawn at once even when nothing is playing.
  const resized = new ResizeObserver(([entry]) => {
    surface.width = entry.contentRect.width;
    surface.height = entry.contentRect.height;
    wake();
  });
  const surface = {
    canvas, mode, pixel, memory: {}, width: 0, height: 0,
    detach() { resized.disconnect(); surfaces.delete(surface); syncCapture(); },
  };
  resized.observe(canvas);
  surfaces.add(surface);
  syncCapture();
  return surface;
}

/** Calls `fn({ level, bass, playing })` every frame. Returns a function that stops it. */
export function onAudio(fn) {
  audioListeners.add(fn);
  syncCapture();
  return () => { audioListeners.delete(fn); syncCapture(); };
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
    label: tr(label),
    checked: surface.mode === id,
    action: () => {
      surface.mode = id;
      surface.memory = {};
      try { localStorage.setItem(MODE_KEY, id); } catch { /* optional */ }
      wake(); // nothing else redraws it while paused
      describe();
    },
  }));
  let timer = null;
  win = floatWindow({
    id: 'visualizer',
    title: tr('Visualizer'),
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
    const source = !player.playing ? tr('Waiting for music') : usable() ? tr('Live audio') : tr('Track loudness only');
    win.setStatus(`${tr(MODES[surface.mode].label)} - ${source}`);
  }
  describe();
  timer = setInterval(describe, 500);
  visibleListeners.forEach((fn) => fn());
}

onPlayerChange(syncCapture);
