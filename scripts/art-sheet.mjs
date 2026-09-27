/* Every illustration on the board, in one page, on the tint it actually sits on.
 *
 *   node scripts/art-sheet.mjs          # write _art-sheet.html and report
 *   node scripts/art-sheet.mjs --check  # report only, non-zero if anything is wrong
 *
 * This used to measure SVG geometry — where an object sat against its shadow
 * ellipse, whether it was centred in a 260x200 viewBox, how many fills it had.
 * None of that survives the move to rendered images: the drawings are cut out
 * and normalised by scratchpad/cutout2.py, so placement is decided once, for
 * the whole set, rather than per drawing.
 *
 * What is worth checking now is the join between the data and the files. An id
 * in data.js with no image is a broken card, and an image nothing points at is
 * dead weight — and neither is visible by looking at the board, because the
 * missing one only shows on the listing that uses it.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import vm from 'node:vm';

const root = process.cwd();
const DIR = 'illustrations';

const files = new Map(
  readdirSync(`${root}/${DIR}`)
    .filter((f) => f.endsWith('.webp'))
    .map((f) => [f.replace(/\.webp$/, ''), statSync(`${root}/${DIR}/${f}`).size]),
);

const ctx = vm.createContext({});
for (const f of ['price.js', 'data.js', 'scraped.js']) {
  vm.runInContext(readFileSync(`${root}/${f}`, 'utf8'), ctx, { filename: f });
}
const events = vm.runInContext('EVENTS', ctx).concat(vm.runInContext('SCRAPED', ctx));
const CATEGORIES = vm.runInContext('CATEGORIES', ctx);

const tint = new Map(
  [...readFileSync(`${root}/styles.css`, 'utf8').matchAll(/--c-([a-z]+):\s*(#[0-9a-f]{6})/g)]
    .map((m) => [m[1], m[2]]),
);

/* How often each drawing is actually on screen, and which category tint it
   most often sits on — a drawing is only right against the grounds it lands on. */
const uses = new Map();
const ground = new Map();
for (const e of events) {
  const art = e.art || CATEGORIES[e.category].art;
  uses.set(art, (uses.get(art) ?? 0) + 1);
  if (!ground.has(art)) ground.set(art, e.category);
}
for (const [key, c] of Object.entries(CATEGORIES)) {
  if (!ground.has(c.art)) ground.set(c.art, key);
}

const missing = [...uses.keys()].filter((id) => !files.has(id));
const unused = [...files.keys()].filter((id) => !uses.has(id));

const pad = (s, n) => String(s).padEnd(n);
const rows = [...files.keys()].sort((a, b) => (uses.get(b) ?? 0) - (uses.get(a) ?? 0) || a.localeCompare(b));
console.log(`\n${files.size} illustrations · ${events.length} listings · ${(
  [...files.values()].reduce((n, b) => n + b, 0) / 1024 / 1024).toFixed(2)} MB\n`);
console.log(`  ${pad('drawing', 20)}${pad('uses', 6)}${pad('KB', 6)}tint`);
for (const id of rows) {
  console.log(`  ${pad(id, 20)}${pad(uses.get(id) ?? '·', 6)}${pad(Math.round(files.get(id) / 1024), 6)}${ground.get(id) ?? '·'}`);
}

if (missing.length) console.log(`\n  MISSING an image, cards will break: ${missing.join(', ')}`);
if (unused.length) console.log(`\n  drawn by nothing yet: ${unused.join(', ')}`);
console.log(`\n  What each one is for: art/RENDERS.md\n`);

if (process.argv.includes('--check')) process.exit(missing.length ? 1 : 0);

const cells = rows.map((id) => {
  const bg = tint.get(ground.get(id)) ?? '#eee';
  return `<figure style="margin:0;background:${bg};border-radius:14px;overflow:hidden">
  <img src="${DIR}/${id}.webp" loading="lazy" alt="${id}"
       style="display:block;width:100%;aspect-ratio:13/10;object-fit:contain">
  <figcaption style="font:500 11px/1.4 system-ui;color:#555;text-align:center;padding:6px 4px;background:#fff">
    ${id}${uses.get(id) ? ` · ${uses.get(id)}` : ''}</figcaption>
  </figure>`;
}).join('');

writeFileSync(`${root}/_art-sheet.html`, `<!doctype html><meta charset="utf-8"><title>Illustrations</title>
<body style="margin:0;padding:18px;background:#fff">
<div style="display:grid;grid-template-columns:repeat(6,1fr);gap:12px">${cells}</div></body>`);
console.log('  wrote _art-sheet.html\n');
