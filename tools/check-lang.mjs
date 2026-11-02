// Checks that every language translates every string in the app, keeping its {placeholders}.
import { readdirSync, readFileSync } from 'node:fs';

const root = new URL('../dist/', import.meta.url);
const code = readdirSync(new URL('js/', root)).filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(new URL(`js/${f}`, root), 'utf8')).join('\n');
const html = readFileSync(new URL('index.html', root), 'utf8');
const keys = new Set();
for (const [, text] of code.matchAll(/(?<![\w.$])tr\('((?:[^'\\]|\\.)*)'/g)) keys.add(text.replace(/\\(.)/g, '$1'));
for (const [, a, b] of code.matchAll(/tr\(isPeople \? '([^']*)' : '([^']*)'/g)) { keys.add(a); keys.add(b); }
for (const [, a, b] of code.matchAll(/tr\(lyrics\.offBy > 0 \? '([^']*)' : '([^']*)'/g)) { keys.add(a); keys.add(b); }
for (const [, text] of html.matchAll(/data-(?:t|tip|hint)="([^"]+)"/g)) keys.add(text);
for (const [, text] of code.matchAll(/label: '([^']+)', draw:/g)) keys.add(text);
for (const [, list] of code.matchAll(/const GENRES = \[([^\]]*)\]/g)) {
  for (const [, text] of list.matchAll(/'([^']+)'/g)) keys.add(text);
}
for (const text of ['File', 'View', 'Playback', 'Help', 'Off', 'All', 'One', 'Small Text', 'Medium Text', 'Large Text', 'Lyrics', 'Timing', 'Mode', 'You']) keys.add(text);

if (process.argv[2] === '--keys') {
  console.log(JSON.stringify([...keys].sort(), null, 1));
  process.exit(0);
}
const holes = (s) => [...s.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort().join();
let bad = 0;
for (const file of readdirSync(new URL('js/lang/', root))) {
  const { default: strings } = await import(new URL(`js/lang/${file}`, root));
  for (const key of keys) {
    if (!(key in strings)) { console.log(`${file}: missing "${key}"`); bad += 1; }
    else if (holes(key) !== holes(strings[key])) { console.log(`${file}: placeholders differ in "${key}"`); bad += 1; }
  }
  for (const key of Object.keys(strings)) if (!keys.has(key)) { console.log(`${file}: unused "${key}"`); bad += 1; }
}
console.log(`${keys.size} strings, ${bad} problems`);
process.exit(bad ? 1 : 0);
