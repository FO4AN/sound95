// Checks the GIF decoder against ImageMagick: each tools/gifs/NAME.gif has its frames,
// as ImageMagick lays them over each other, in NAME.rgba beside it.
import { readdirSync, readFileSync } from 'node:fs';
import { gifFrames, parseGif } from '../dist/js/gif.js';

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
process.exit(bad ? 1 : 0);
