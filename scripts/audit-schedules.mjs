/* Every schedule on the board, checked against the ways one has been wrong.
 *
 * Written after the Toronto Flea. It was listed as a weekly Sunday market
 * because its `source` pointed at an aggregator page reading "Sundays
 * May–October". The organiser runs it a handful of times a season. The board
 * showed it on twenty-seven Sundays, the social pipeline posted it on two of
 * them, and people went to a market that was not on.
 *
 * That is the failure this file exists to catch, and the shape of it is
 * specific enough to look for: a recurrence — every Sunday, the last Sunday
 * of the month — asserted on the strength of a page the organiser did not
 * write. An aggregator summarising a season as "Sundays 11–5" is not lying,
 * it is just not a schedule, and the moment it is copied into one the board
 * starts making a claim nobody checked.
 *
 * The rest of the checks are the neighbouring ways a listing goes stale: a
 * season that ended, a window that runs to December on something that packs
 * up in October, a listing nobody has re-read in a month.
 *
 * A report, not a gate. Some of these are fine and known — the two BlogTO
 * article sources are deliberate and recorded in the handover. It prints what
 * it finds so a person can decide, and never fails the build.
 *
 *   node scripts/audit-schedules.mjs
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = process.cwd();
const ctx = vm.createContext({});
for (const f of ['price.js', 'data.js', 'scraped.js']) {
  vm.runInContext(readFileSync(`${root}/${f}`, 'utf8'), ctx, { filename: f });
}
const EVENTS = vm.runInContext('EVENTS', ctx);
const SCRAPED = vm.runInContext('SCRAPED', ctx);
const all = EVENTS.map((e) => ({ ...e, from: 'hand' }))
  .concat(SCRAPED.map((e) => ({ ...e, from: e.scrapedFrom })));

const today = new Date().toISOString().slice(0, 10);
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };

/* Sites that write about events rather than running them. Being on this list
   is not an accusation — they are good pages, and two of them are cited
   deliberately. It means they cannot confirm a recurrence, because they are
   summarising someone else's calendar and a summary drops the exceptions. */
const AGGREGATORS = new Set([
  'festmore.com', 'familyfuncanada.com', 'blogto.com', 'todocanada.ca',
  'curiocity.com', 'timeout.com', 'narcity.com', 'dailyhive.com',
  'destinationontario.com', 'destinationtoronto.com', 'bloor-yorkville.com',
  'nowtoronto.com', 'toronto.com', 'eventbrite.ca', 'eventbrite.com',
]);

/* A listing may carry one schedule or several. */
const schedulesOf = (e) => (Array.isArray(e.schedule) ? e.schedule : [e.schedule]).filter(Boolean);
const recurs = (s) => s.kind === 'weekly' || s.kind === 'nth';
const endOf = (s) => s.to ?? s.end ?? s.date ?? null;
const startOf = (s) => s.from ?? s.start ?? s.date ?? null;

/* Things that pack up for the winter. A weekly one of these running to the
   31st of December is claiming a January farmers' market. */
const SEASONAL = new Set(['market', 'flea', 'outdoors', 'festival']);

const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

const checks = [
  ['recurrence from a third party', (e) => {
    const src = host(e.source);
    return schedulesOf(e).some(recurs)
      && src && (AGGREGATORS.has(src) || (host(e.url) && src !== host(e.url)));
  }, 'the schedule repeats, and the page it was read from is not the organiser’s'],

  ['aggregator as source', (e) => AGGREGATORS.has(host(e.source)) && !schedulesOf(e).some(recurs),
    'a single date, but still cited to a page the organiser did not write'],

  /* Only the hand-written ones. A polled listing going out of date is the
     system working — the next poll rewrites scraped.js from scratch — and
     listing forty of them buries the handful somebody has to act on. They
     are counted at the end instead. */
  ['season already over', (e) => e.from === 'hand'
    && schedulesOf(e).every((s) => { const x = endOf(s); return x && x < today; }),
    'every date on this listing is in the past'],

  ['runs past its season', (e) => SEASONAL.has(e.category)
    && schedulesOf(e).some((s) => recurs(s) && /-12-(2[5-9]|3[01])$/.test(String(s.to ?? ''))),
    'an outdoor listing scheduled into late December'],

  /* Only where a time is a fact about the event rather than opening hours.
     An exhibition runs all day for three months and has none to give; a
     weekly class has one and is missing it. */
  ['no time of day', (e) => schedulesOf(e).some((s) => recurs(s) && !s.time),
    'a repeating listing with no time — the pipeline has none to post'],

  ['not re-read in a month', (e) => e.from === 'hand' && e.checked && days(e.checked, today) > 30
    && schedulesOf(e).some(recurs),
    'a repeating listing whose source has not been looked at in over 30 days'],
];

const found = new Map();
for (const e of all) {
  const hits = checks.filter(([, fn]) => { try { return fn(e); } catch { return false; } }).map(([n]) => n);
  if (hits.length) found.set(e.id, { e, hits });
}

console.log(`\n${all.length} listings · ${found.size} with something to look at\n`);

const tally = {};
for (const { hits } of found.values()) for (const h of hits) tally[h] = (tally[h] ?? 0) + 1;
for (const [name, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  const why = checks.find(([k]) => k === name)?.[2] ?? '';
  console.log(`  ${String(n).padStart(3)}  ${name.padEnd(30)} ${why}`);
}
console.log();

for (const { e, hits } of [...found.values()].sort((a, b) => a.e.id.localeCompare(b.e.id))) {
  console.log(`[${hits.join(', ')}]  ${e.title.trim().slice(0, 52)}  (${e.from})`);
  for (const s of schedulesOf(e)) {
    const span = startOf(s) && endOf(s) && startOf(s) !== endOf(s) ? `${startOf(s)} → ${endOf(s)}` : (startOf(s) ?? '?');
    console.log(`     ${String(s.kind).padEnd(7)} ${span}${s.time ? `  ${s.time}` : '  (no time)'}`);
  }
  console.log(`     source ${e.source ?? '(none)'}`);
}

const staleScraped = all.filter((e) => e.from !== 'hand'
  && schedulesOf(e).every((s) => { const x = endOf(s); return x && x < today; })).length;
if (staleScraped) {
  console.log(`\n${staleScraped} polled listing${staleScraped === 1 ? ' is' : 's are'} out of date. `
    + 'That clears on the next poll, which rewrites scraped.js whole.');
}

if (found.size) {
  console.log('\nA repeating schedule is a claim about every date it generates,'
    + '\nand the pipeline will post every one of them. Confirm it against the'
    + '\npage the organiser writes, not a page about them.');
}
