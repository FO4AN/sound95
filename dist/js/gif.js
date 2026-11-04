// Animated GIFs, decoded here so the background can play one at the music's pace,
// which an <img> can't do. Plain functions, so tools/check-gif.mjs can test them.

/** Reads a GIF's frames without decompressing them. Throws if it isn't a GIF. */
export function parseGif(buffer) {
  const b = new Uint8Array(buffer);
  const signature = String.fromCharCode(...b.subarray(0, 6));
  if (!/^GIF8[79]a$/.test(signature)) throw new Error('Not a GIF');
  const u16 = (at) => b[at] | (b[at + 1] << 8);
  const width = u16(6);
  const height = u16(8);
  const flags = b[10];
  let p = 13;
  const table = (packed) => {
    const size = 3 * (2 << (packed & 7));
    const colours = b.subarray(p, p + size);
    p += size;
    return colours;
  };
  const global = flags & 0x80 ? table(flags) : null;
  const frames = [];
  let control = null;
  const skipBlocks = () => { while (p < b.length && b[p]) p += b[p] + 1; p += 1; };
  while (p < b.length) {
    const block = b[p++];
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = b[p++];
      if (label === 0xf9 && b[p] >= 4) {
        const packed = b[p + 1];
        control = { disposal: (packed >> 2) & 7, delay: u16(p + 2) * 10, transparent: packed & 1 ? b[p + 4] : -1 };
      }
      skipBlocks();
    } else if (block === 0x2c) {
      const frame = {
        left: u16(p), top: u16(p + 2), width: u16(p + 4), height: u16(p + 6),
        interlaced: !!(b[p + 8] & 0x40),
        disposal: 0, delay: 0, transparent: -1, ...control,
      };
      const packed = b[p + 8];
      p += 9;
      frame.colours = packed & 0x80 ? table(packed) : global;
      frame.minCode = b[p++];
      const chunks = [];
      let size = 0;
      while (p < b.length && b[p]) {
        chunks.push(b.subarray(p + 1, p + 1 + b[p]));
        size += b[p];
        p += b[p] + 1;
      }
      p += 1;
      frame.data = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) { frame.data.set(chunk, at); at += chunk.length; }
      // Browsers play very short delays at 10 a second, and so do we.
      if (frame.delay < 20) frame.delay = 100;
      if (frame.colours) frames.push(frame);
      control = null;
    } else {
      break;
    }
  }
  if (!frames.length) throw new Error('No frames');
  return { width, height, frames };
}

/** The colour index of each pixel of one frame, top row first. */
export function decodeFrame(frame) {
  const count = frame.width * frame.height;
  const out = new Uint8Array(count);
  const { data, minCode } = frame;
  const clear = 1 << minCode;
  const end = clear + 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  for (let i = 0; i < clear; i++) suffix[i] = i;
  let size = minCode + 1;
  let mask = (1 << size) - 1;
  let next = end + 1;
  let old = -1;
  let first = 0;
  let bits = 0;
  let datum = 0;
  let i = 0;
  let o = 0;
  while (o < count) {
    while (bits < size) {
      if (i >= data.length) return deinterlace(frame, out);
      datum |= data[i++] << bits;
      bits += 8;
    }
    let code = datum & mask;
    datum >>= size;
    bits -= size;
    if (code === clear) {
      size = minCode + 1;
      mask = (1 << size) - 1;
      next = end + 1;
      old = -1;
      continue;
    }
    if (code === end) break;
    if (old === -1) {
      if (code >= clear) break;
      out[o++] = suffix[code];
      old = code;
      first = code;
      continue;
    }
    const read = code;
    let top = 0;
    if (code >= next) {
      stack[top++] = first;
      code = old;
    }
    while (code > end) {
      stack[top++] = suffix[code];
      code = prefix[code];
    }
    first = suffix[code];
    stack[top++] = first;
    while (top && o < count) out[o++] = stack[--top];
    if (next < 4096) {
      prefix[next] = old;
      suffix[next] = first;
      next += 1;
      if (!(next & mask) && next < 4096) {
        size += 1;
        mask = (1 << size) - 1;
      }
    }
    old = read;
  }
  return deinterlace(frame, out);
}

function deinterlace(frame, rows) {
  if (!frame.interlaced) return rows;
  const { width, height } = frame;
  const out = new Uint8Array(rows.length);
  let from = 0;
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < height; y += step) {
      out.set(rows.subarray(from * width, (from + 1) * width), y * width);
      from += 1;
    }
  }
  return out;
}

/**
 * Lays frames over each other the way a GIF says to, into RGBA pixels. `step()`
 * moves to the next frame and returns the picture.
 */
export function gifFrames(gif) {
  const { width, height, frames } = gif;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const decoded = new Map();
  // Decoded frames are kept unless the GIF is huge, then decoded again as needed.
  const keep = width * height * frames.length <= 48_000_000;
  let index = -1;
  let saved = null;

  const indices = (i) => {
    if (decoded.has(i)) return decoded.get(i);
    const out = decodeFrame(frames[i]);
    if (keep) decoded.set(i, out);
    return out;
  };

  const clearRect = (f) => {
    for (let y = f.top; y < Math.min(height, f.top + f.height); y++) {
      pixels.fill(0, (y * width + f.left) * 4, (y * width + Math.min(width, f.left + f.width)) * 4);
    }
  };

  function step() {
    const last = frames[index];
    if (index === frames.length - 1 || index < 0) {
      // Starting over: the first frame draws onto nothing.
      pixels.fill(0);
      saved = null;
      index = 0;
    } else {
      if (last.disposal === 2) clearRect(last);
      else if (last.disposal === 3 && saved) pixels.set(saved);
      index += 1;
    }
    const f = frames[index];
    // "Restore previous" on the first frame keeps it, as most players do.
    saved = f.disposal === 3 && index > 0 ? pixels.slice() : null;
    const source = indices(index);
    const { colours, transparent } = f;
    for (let y = 0; y < f.height; y++) {
      const py = f.top + y;
      if (py >= height) break;
      for (let x = 0; x < f.width; x++) {
        const px = f.left + x;
        if (px >= width) break;
        const c = source[y * f.width + x];
        if (c === transparent) continue;
        const at = (py * width + px) * 4;
        pixels[at] = colours[c * 3];
        pixels[at + 1] = colours[c * 3 + 1];
        pixels[at + 2] = colours[c * 3 + 2];
        pixels[at + 3] = 255;
      }
    }
    return pixels;
  }

  return {
    width,
    height,
    count: frames.length,
    step,
    get index() { return index; },
    get delay() { return frames[Math.max(0, index)].delay; },
  };
}
