// Checks the GIF decoder against ImageMagick: each tools/gifs/NAME.gif has its frames,
// as ImageMagick lays them over each other, in NAME.rgba beside it.
import { readdirSync, readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { decodeFrame, gifFrames, parseGif } from '../dist/js/gif.js';

const dir = new URL('gifs/', import.meta.url);
let bad = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith('.gif'))) {
  const gif = gifFrames(parseGif(readFileSync(new URL(file, dir))));
  const expected = readFileSync(new URL(file.replace(/\.gif$/, '.rgba'), dir));
  const frameBytes = gif.width * gif.height * 4;
  const problems = [];
  if (expected.length !== frameBytes * gif.count) problems.push(`${gif.count} frames, expected ${expected.length / frameBytes}`);
  for (let i = 0; i < gif.count && !problems.length; i++) {
    const got = gif.step();
    const want = expected.subarray(i * frameBytes, (i + 1) * frameBytes);
    for (let at = 0; at < frameBytes; at += 4) {
      const clear = got[at + 3] === 0 && want[at + 3] === 0;
      if (!clear && [0, 1, 2, 3].some((k) => got[at + k] !== want[at + k])) {
        const pixel = at / 4;
        problems.push(`frame ${i} differs at ${pixel % gif.width},${Math.floor(pixel / gif.width)}: ${[...got.subarray(at, at + 4)]} vs ${[...want.subarray(at, at + 4)]}`);
        break;
      }
    }
  }
  // Playing on wraps around to the first frame again.
  if (!problems.length) {
    gif.step();
    if (gif.index !== 0) problems.push('did not loop back to the first frame');
  }
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${file} (${gif.width}x${gif.height}, ${gif.count} frames)${problems.length ? `: ${problems[0]}` : ''}`);
  bad += problems.length;
}

// Broken files ImageMagick won't read, so they can't be NAME.gif/NAME.rgba pairs.
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) bad += 1;
}

// A code past the table (3-bit codes clear,0,7,0,7) must end the frame, not loop forever.
// A worker can be stopped if it does.
const corrupt = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x0a, 0x00, 0x0a, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x0a, 0x00, 0x0a, 0x00, 0x00, 0x02, 0x02, 0xc4, 0x71, 0x00, 0x3b];
const ended = await new Promise((resolve) => {
  const worker = new Worker(`import(${JSON.stringify(new URL('../dist/js/gif.js', import.meta.url).href)})
    .then(({ gifFrames, parseGif }) => {
      gifFrames(parseGif(new Uint8Array(${JSON.stringify(corrupt)}).buffer)).step();
      require('node:worker_threads').parentPort.postMessage('done');
    });`, { eval: true });
  const timer = setTimeout(() => { worker.terminate(); resolve(false); }, 5000);
  const finish = (ok) => { clearTimeout(timer); worker.terminate(); resolve(ok); };
  worker.once('message', () => finish(true));
  worker.once('error', () => finish(false));
});
check(ended, 'corrupt LZW code (10x10) ends the frame');

// A 16000x16000 frame cut off right after its descriptor has no code size, and must not
// spin through every pixel.
const cut = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x80, 0x3e, 0x80, 0x3e, 0x80, 0x00, 0x00, 0x00, 0x00,
  0x00, 0xff, 0xff, 0xff, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x80, 0x3e, 0x80, 0x3e, 0x00]);
const started = performance.now();
decodeFrame(parseGif(cut.buffer).frames[0]);
const cutMs = performance.now() - started;
check(cutMs < 500, `cut-off frame with no code size (${cutMs.toFixed(1)} ms)`);

process.exit(bad ? 1 : 0);
