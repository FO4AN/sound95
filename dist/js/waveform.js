// A track's waveform, styled after the Sound Recorder's display. SoundCloud
// publishes the loudness of every track, so this works before anything plays.

import { el, whileShown } from './dom.js';
import { durationMs, onPlayerChange, onProgress, player, positionMs, seekTo } from './player.js';
import { api } from './api.js';

const COLUMN = 3;
const UNPLAYED = '#006000';
const PLAYED = '#00ff00';
const CURSOR = '#ff0000';
const BACKGROUND = '#000000';

const cache = new Map();

/** Loudness of each moment as 0..1, or null when SoundCloud has none. */
export function loudness(link) {
  if (!link) return Promise.resolve(null);
  if (!cache.has(link)) {
    cache.set(link, api.waveform(link).then(
      ({ samples, height }) => samples.map((v) => v / (height || 140)),
      () => { cache.delete(link); return null; },
    ));
  }
  return cache.get(link);
}

export function waveformView(track, { onPlay }) {
  const canvas = el('canvas', { class: 'wave-canvas' });
  const frame = el('div', { class: 'wave sunken', title: 'Click to jump here' }, canvas);
  let samples = null;
  let hover = null;

  const isCurrent = () => player.current?.urn === track.urn;

  function draw() {
    const { clientWidth: width, clientHeight: height } = canvas;
    if (!width) return;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, width, height);
    const middle = Math.floor(height / 2);
    ctx.fillStyle = UNPLAYED;
    ctx.fillRect(0, middle, width, 1);
    if (!samples) return;
    const progress = isCurrent() && durationMs() ? positionMs() / durationMs() : 0;
    for (let x = 0; x < width; x += COLUMN) {
      const value = samples[Math.floor((x / width) * samples.length)] || 0;
      const reach = Math.max(1, Math.round(value * (height / 2 - 2)));
      ctx.fillStyle = x / width < progress ? PLAYED : UNPLAYED;
      ctx.fillRect(x, middle - reach, COLUMN - 1, reach * 2);
    }
    if (progress) {
      ctx.fillStyle = CURSOR;
      ctx.fillRect(Math.round(progress * width), 0, 1, height);
    }
    if (hover != null) {
      ctx.fillStyle = '#ffff00';
      ctx.fillRect(hover, 0, 1, height);
    }
  }

  whileShown(canvas, onProgress, draw);
  whileShown(canvas, onPlayerChange, draw);
  new ResizeObserver(draw).observe(canvas);

  frame.addEventListener('mousemove', (e) => { hover = e.offsetX; draw(); });
  frame.addEventListener('mouseleave', () => { hover = null; draw(); });
  frame.addEventListener('click', (e) => {
    const ratio = e.offsetX / canvas.clientWidth;
    if (isCurrent()) seekTo(ratio);
    else onPlay(ratio);
  });

  loudness(track.waveform).then((values) => { samples = values; draw(); });
  return frame;
}
