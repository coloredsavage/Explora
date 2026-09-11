/* Every description on the board, checked against the things that have gone
 * wrong with them before.
 *
 * Written because the owner was the one finding these: a credit block here, a
 * meeting point there, a sentence wearing an ellipsis it had not earned. The
 * poll job runs this afterwards and prints what it finds, so a bad batch is
 * visible in the run rather than on the site.
 *
 * It never fails the build. A short description is sometimes the honest
 * answer, and a listing whose page says little should not stop a deploy —
 * this is a report to read, not a gate. */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { readsAsDescription } from '../scrape/extract.mjs';

const root = process.cwd();
const ctx = vm.createContext({});
for (const f of ['price.js', 'data.js', 'scraped.js'])
  vm.runInContext(readFileSync(root + '/' + f, 'utf8'), ctx, { filename: f });
const E = vm.runInContext('EVENTS', ctx), S = vm.runInContext('SCRAPED', ctx);
const all = E.map(e => ({ ...e, from: 'hand' })).concat(S.map(e => ({ ...e, from: e.scrapedFrom })));

const checks = [
  ['placeholder',     e => /^Listed by /.test(e.description || '')],
  ['missing',         e => !e.description || !e.description.trim()],
  ['logistics block', e => e.description && !readsAsDescription(e.description)],
  ['truncated',       e => /[…]$|\.\.\.$/.test((e.description || '').trim())],
  ['opens with the title', e => {
      const d = (e.description || '').toLowerCase(), t = e.title.trim().toLowerCase().slice(0, 18);
      return t.length > 8 && d.startsWith(t);
  }],
  ['marketing question', e => /^(are you |do you |ever wanted|looking for|want to |ready to )/i.test((e.description || '').trim())],
  ['shouting',        e => (((e.description || '').match(/\b[A-Z]{4,}\b/g) || []).length >= 3)],
  ['entity artefact', e => /nbsp|&amp|&#\d|&[a-z]{2,6};|\\n/.test(e.description || '')],
  ['repeats the price', e => e.entry && e.description && e.description.includes(String(e.entry).split(/[;,]/)[0].trim()) && /\$/.test(e.entry)],
  ['very short',      e => (e.description || '').trim().length > 0 && (e.description || '').trim().length < 60],
  ['very long',       e => (e.description || '').length > 320],
];

const found = new Map();
for (const e of all) {
  const hits = checks.filter(([, fn]) => fn(e)).map(([n]) => n);
  if (hits.length) found.set(e.id, { e, hits });
}
console.log(`\n${all.length} listings · ${found.size} with something to look at\n`);
const byCheck = {};
for (const { hits } of found.values()) for (const h of hits) byCheck[h] = (byCheck[h] || 0) + 1;
for (const [k, v] of Object.entries(byCheck).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
console.log();
for (const { e, hits } of found.values()) {
  console.log(`[${hits.join(', ')}]  ${e.title.trim().slice(0, 46)}  (${e.from})`);
  console.log(`     ${(e.description || '(none)').slice(0, 150)}`);
}
