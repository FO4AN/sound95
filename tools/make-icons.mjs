// Draws the app icon as pixel art and writes src-tauri/icons/*.png. No dependencies.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const PALETTE = {
  '.': [0, 0, 0, 0], k: [0, 0, 0, 255], w: [255, 255, 255, 255], g: [192, 192, 192, 255],
  d: [128, 128, 128, 255], n: [0, 0, 128, 255], t: [0, 128, 128, 255], y: [255, 255, 0, 255],
};
// A beige PC speaker cabinet with a beamed note on a teal screen.
const ART = [
  '................',
  '.wwwwwwwwwwwwww.',
  '.wggggggggggggdk',
  '.wgttttttttttgdk',
  '.wgttnnnnnnttgdk',
  '.wgttnttttnttgdk',
  '.wgttnttttnttgdk',
  '.wgttnttttnttgdk',
  '.wgnnnttnnnttgdk',
  '.wgnnnttnnnttgdk',
  '.wgttttttttttgdk',
  '.wggggggggggggdk',
  '.wgdgdgdggyygdk.',
  '.wggggggggggdk..',
  '..dddddddddddk..',
  '..kkkkkkkkkkkk..',
];

function crc32(buf) {
  let c, crc = ~0;
  for (const b of buf) { c = (crc ^ b) & 255; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(size) {
  const scale = Math.floor(size / 16), pad = Math.floor((size - scale * 16) / 2);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    for (let x = 0; x < size; x++) {
      const ch = ART[Math.floor((y - pad) / scale)]?.[Math.floor((x - pad) / scale)] ?? '.';
      Buffer.from(PALETTE[ch]).copy(raw, row + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const out = new URL('../src-tauri/icons/', import.meta.url);
for (const [name, size] of [['32x32.png', 32], ['128x128.png', 128], ['icon.png', 512]]) writeFileSync(new URL(name, out), png(size));
