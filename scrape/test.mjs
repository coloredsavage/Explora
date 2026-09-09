#!/usr/bin/env node
/* Offline checks over the fixtures. No network, no API key, no browser. */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fromJsonLd, readableText, candidateLinks } from './extract.mjs';
import { normalize, validate } from './normalize.mjs';
import { SOURCES } from './sources.mjs';
import { bestMatch, acceptable, patchEntry, loadSite, restingIds, DURABLE_REFUSAL } from './recheck.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFile(path.join(here, 'fixtures', n), 'utf8');
const wygo = SOURCES.find((s) => s.id === 'wygo');
const realSrc = await readFile(path.join(here, '..', 'data.js'), 'utf8');
const priceSrc = await readFile(path.join(here, '..', 'price.js'), 'utf8');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.log('  FAIL ' + name + '\n       ' + err.message); }
};

const index = await fixture('wygo.html');
const plain = await fixture('wygo.2.html');
const raws = fromJsonLd(index);
const today = '2026-09-08';
const results = raws.map((r) => normalize(r, wygo, { today, checked: today }));
const kept = results.filter((r) => r.ok).map((r) => r.event);

console.log('\nJSON-LD extraction');
check('finds every Event in an @graph', () => assert.equal(raws.length, 4));
check('reads a nested PostalAddress', () =>
  assert.match(raws[0].address, /9 Queens Quay W, Toronto, ON, M5J 2H3/));
check('reads a string address', () =>
  assert.equal(raws[1].address, '255 Bremner Blvd, Toronto, ON'));
check('turns a zero price into Free', () => assert.equal(raws[1].entry, 'Free'));
check('formats a real price', () => assert.equal(raws[0].entry, '$20'));

console.log('\nGates');
check('keeps the two future, complete events', () => assert.equal(kept.length, 2));
check('drops the past event', () =>
  assert.ok(results.some((r) => !r.ok && /already past/.test(r.why))));
check('drops the dateless event', () =>
  assert.ok(results.some((r) => !r.ok && /no usable start date/.test(r.why))));
check('every kept event validates', () =>
  kept.forEach((e) => assert.deepEqual(validate(e), [])));

console.log('\nShape');
check('ids are stable and readable', () =>
  assert.equal(kept[0].id, 'wygo-ultimate-hide-seek-2026-09-20'));
check('a one-day event becomes a day schedule', () =>
  assert.deepEqual(kept[0].schedule, { kind: 'day', date: '2026-09-20' }));
check('carries the source it came from', () =>
  assert.equal(kept[0].source, 'https://wygo.world/hidenseek'));
check('inherits the category of its source', () =>
  assert.equal(kept[0].category, 'dropin'));

console.log('\nFallback path');
check('a page with no JSON-LD yields nothing deterministic', () =>
  assert.equal(fromJsonLd(plain).length, 0));
check('its readable text keeps the facts a model would need', () => {
  const t = readableText(plain);
  assert.match(t, /15 October 2026/);
  assert.match(t, /1197 Dundas St W/);
  assert.match(t, /\$12/);
});
check('readable text drops markup', () => assert.doesNotMatch(readableText(plain), /</));

console.log('\nToronto gate — from what the first live run actually returned');
const gate = (raw) => normalize({ startDate: '2026-09-20', ...raw }, wygo, { today, checked: today });
check('drops a Waterloo listing', () =>
  assert.match(gate({ title: 'Liminal Scavenger Hunt', venue: 'University of Waterloo',
    address: '200 University Avenue West, Waterloo, ON' }).why, /not in Toronto/));
check('drops a TBD venue', () =>
  assert.match(gate({ title: 'Locked-in', venue: 'TBD',
    address: 'Somewhere spooky in Kitchener-Waterloo' }).why, /placeholder venue/));
check('drops a prose non-address', () =>
  assert.match(gate({ title: 'Thing', venue: 'A place',
    address: 'Somewhere spooky in Kitchener-Waterloo' }).why, /placeholder address/));
check('keeps the boroughs', () =>
  assert.ok(gate({ title: 'Bluffs walk', venue: 'Bluffers Park',
    address: '1 Brimley Rd S, Scarborough, ON' }).ok));
check('drops an online-only event', () =>
  assert.match(gate({ title: 'Free Webinar', venue: 'Online',
    address: 'Online event, Toronto, ON' }).why, /not somewhere you can go/));
check('tidies a whole-dollar price', () =>
  assert.equal(gate({ title: 'X', venue: 'Y', address: '1 King St W, Toronto, ON',
    entry: '$13.00' }).event.entry, '$13'));

console.log('\nPer-source filtering — from the first real poll');
const luma = SOURCES.find((s) => s.id === 'luma');
const viaLuma = (title, venue, address) =>
  normalize({ title, venue, address, startDate: '2026-09-09' }, luma, { today, checked: today });
check('drops a venue that is only the city', () =>
  assert.match(viaLuma('Ambition Office Housewarming', 'Toronto, ON', 'Toronto, ON').why,
    /excluded|venue is just the city/));
check('drops a networking mixer', () =>
  assert.match(viaLuma('Fintech Social Toronto', 'BrainStation', '20 Bay St, Toronto, ON').why,
    /excluded by this source/));
check('keeps a book launch, software-company host and all', () =>
  assert.ok(viaLuma('Toronto Book Launch for "The Campfire Method"',
    'Mentimeter North America Inc', '100 King St W, Toronto, ON').ok));
check('the filter is per-source, not global', () =>
  assert.ok(normalize({ title: 'Founders Brunch', venue: 'A Hall', address: '1 King St W, Toronto, ON',
    startDate: '2026-09-09' }, wygo, { today, checked: today }).ok));
check('Luma files under its own category', () => assert.equal(luma.category, 'social'));

console.log('\nTidying, against what the poll actually returned');
const tidy = (extra) => normalize({ title: 'A Thing', startDate: '2026-09-20', ...extra },
  wygo, { today, checked: today }).event;
check('strips the venue repeated into the address', () =>
  assert.equal(tidy({ venue: 'BrainStation', address: 'BrainStation, Toronto, Ontario' }).address,
    'Toronto, Ontario'));
check('leaves a real street address alone', () =>
  assert.equal(tidy({ venue: 'Toronto Reference Library', address: '789 Yonge Street, Toronto, ON' }).address,
    '789 Yonge Street, Toronto, ON'));
check('keeps an address identical to the venue rather than emptying it', () =>
  assert.equal(tidy({ venue: 'The Bentway, Toronto', address: 'The Bentway, Toronto' }).address,
    'The Bentway, Toronto'));
check('cuts a long description at a sentence boundary', () => {
  const d = tidy({ venue: 'V', address: '1 King St W, Toronto, ON',
    description: 'One sentence here. ' + 'Another sentence that runs on. '.repeat(20) }).description;
  assert.ok(d.length <= 225, `got ${d.length}`);
  assert.match(d, /…$/);
  assert.doesNotMatch(d.slice(0, -1), /\s$/);
});
check('leaves a short description untouched', () =>
  assert.equal(tidy({ venue: 'V', address: '1 King St W, Toronto, ON',
    description: 'Two floors of ceramics.' }).description, 'Two floors of ceramics.'));
check('drops a leading bracketed aside', () =>
  assert.match(tidy({ venue: 'V', address: '1 King St W, Toronto, ON',
    description: '[Note: drinks extra] The actual description.' }).description, /^The actual/));
check('cuts a single over-long sentence at a word boundary', () => {
  const d = tidy({ venue: 'V', address: '1 King St W, Toronto, ON',
    description: 'Join actor and activist Laverne Cox and philosopher Jason Stanley for a conversation about the political forces reshaping identity, power and public life in our time, and what it means for the future of democracy and belonging today.' }).description;
  assert.ok(d.length <= 225, `got ${d.length}`);
  assert.match(d, /…$/);
});
check('unescapes a doubly-escaped newline', () => {
  const d = tidy({ venue: 'V', address: '1 King St W, Toronto, ON',
    description: '\\nJoin us for a talk.' }).description;
  assert.equal(d, 'Join us for a talk.');
});
check('falls back when there is no description', () =>
  assert.match(tidy({ venue: 'V', address: '1 King St W, Toronto, ON' }).description, /^Listed by/));

console.log('\nLink following');
check('follows event links, not the index itself', () => {
  const links = candidateLinks(index, wygo.url, wygo.followLinks, wygo.maxFollow);
  assert.deepEqual(links.sort(), ['https://wygo.world/hidenseek', 'https://wygo.world/lookalike']);
});
check('skips the site furniture', () => {
  const html = ['/create', '/signin', '/about', '/privacy', '/hidenseek']
    .map((h) => `<a href="${h}">x</a>`).join('');
  assert.deepEqual(candidateLinks(html, wygo.url, wygo.followLinks, 10),
    ['https://wygo.world/hidenseek']);
});

/* ------------------------------------------------------ the recheck job */

console.log('\nPrice, the rule the page and the job share');
const { events, priceOf } = await loadSite(path.join(here, '..'));
const bucket = (entry) => priceOf({ entry });
check('the page and the job load one rule, not two', () =>
  assert.equal(typeof priceOf, 'function'));
check('plain free', () => assert.equal(bucket('Free'), 'free'));
check('free with a condition attached to the door', () =>
  assert.equal(bucket('Free, but book the timed ticket ahead'), 'free'));
check('pay what you can is a free door', () =>
  assert.equal(bucket('Pay what you can'), 'free'));
check('a discount later in the line is not a free event', () =>
  assert.equal(bucket('Ticketed; free for 25 and under'), 'unknown'));
check('the first figure wins, not the smallest', () =>
  assert.equal(bucket('$22, plus $5 and up to fire a piece'), 'over20'));
check('under twenty', () => assert.equal(bucket('$12'), 'under20'));
check('twenty is not under twenty', () => assert.equal(bucket('$20'), 'over20'));
check('a line with no number is unknown', () => assert.equal(bucket('Ticketed'), 'unknown'));
check('no entry at all is unknown', () => assert.equal(bucket(undefined), 'unknown'));

console.log('\nWhat the job will accept as an answer');
check('a plain price', () => assert.equal(acceptable('$25'), '$25'));
check('trims a pointless .00', () => assert.equal(acceptable('$25.00'), '$25'));
check('free', () => assert.equal(acceptable('Free'), 'Free'));
check('pay what you can', () => assert.equal(acceptable('Pay what you can'), 'Pay what you can'));
check('refuses "varies"', () => assert.equal(acceptable('Varies'), null));
check('refuses "see website"', () => assert.equal(acceptable('See website for pricing'), null));
check('refuses a whole sentence that happens to hold a price', () =>
  assert.equal(acceptable('Tickets for this and other events start at $20 or so'), null));
check('refuses null', () => assert.equal(acceptable(null), null));

console.log('\nMatching the right event on a page holding several');
const onPage = [{ title: 'Art Toronto 2026' }, { title: 'Winter Solstice Party' }];
check('matches despite an extra word', () =>
  assert.equal(bestMatch(onPage, 'Art Toronto').title, 'Art Toronto 2026'));
check('does not match a different event', () =>
  assert.equal(bestMatch(onPage, 'Fall Members Opening'), null));
check('no candidates, no match', () => assert.equal(bestMatch([], 'Art Toronto'), null));

console.log('\nPatching data.js');
const sample = [
  'const EVENTS = [',
  '  {',
  "    id: 'has-one',",
  "    title: 'A thing',",
  "    category: 'art',",
  "    entry: 'Ticketed',",
  "    art: 'art-star',",
  '  },',
  '  {',
  "    id: 'has-none',",
  "    title: 'Another thing',",
  "    category: 'dropin',",
  "    art: 'art-star',",
  '  },',
  '];',
  '',
].join('\n');

check('replaces a price that is already there', () => {
  const out = patchEntry(sample, 'has-one', '$25');
  assert.match(out, /id: 'has-one',\n    title: 'A thing',\n    category: 'art',\n    entry: '\$25',/);
});
check('leaves the other listing alone', () => {
  const out = patchEntry(sample, 'has-one', '$25');
  assert.match(out, /id: 'has-none',\n    title: 'Another thing',\n    category: 'dropin',\n    art: 'art-star',\n  },/);
});
check('inserts a missing price after category', () => {
  const out = patchEntry(sample, 'has-none', 'Free');
  assert.match(out, /category: 'dropin',\n    entry: 'Free',\n    art: 'art-star',/);
});
check('escapes a quote rather than breaking the file', () => {
  const out = patchEntry(sample, 'has-none', "$10 at the door, $8 if you're a member");
  assert.match(out, /entry: '\$10 at the door, \$8 if you\\'re a member',/);
});
check('refuses an id it cannot find, rather than guessing', () =>
  assert.equal(patchEntry(sample, 'not-here', 'Free'), null));

check('the patched file still parses, and holds the new price', () => {
  const out = patchEntry(sample, 'has-one', '$25');
  const ctx = vm.createContext({});
  vm.runInContext(out, ctx);
  const got = vm.runInContext('EVENTS', ctx);
  assert.equal(got.find((e) => e.id === 'has-one').entry, '$25');
  assert.equal(got.length, 2);
});

check('a real patch of the real data.js still parses', () => {
  const before = events.find((e) => priceOf(e) === 'unknown');
  assert.ok(before, 'expected at least one listing with no known price');
  const out = patchEntry(realSrc, before.id, '$19');
  assert.ok(out, 'patcher returned null on the real file');
  const ctx = vm.createContext({});
  vm.runInContext(priceSrc, ctx);
  vm.runInContext(out, ctx);
  const got = vm.runInContext('EVENTS', ctx);
  assert.equal(got.length, events.length);
  assert.equal(got.find((e) => e.id === before.id).entry, '$19');
});

console.log('\nBacking off pages that state no price');
const day = (n) => new Date(Date.parse('2026-09-09') + n * 86400000).toISOString().slice(0, 10);
const ids = ['a', 'b', 'c'];
check('a listing asked yesterday rests', () =>
  assert.deepEqual(restingIds(ids, { a: day(-1) }, '2026-09-09'), ['a']));
check('a listing asked 29 days ago still rests', () =>
  assert.deepEqual(restingIds(ids, { a: day(-29) }, '2026-09-09'), ['a']));
check('a listing asked 30 days ago is asked again', () =>
  assert.deepEqual(restingIds(ids, { a: day(-30) }, '2026-09-09'), []));
check('a listing never asked is asked', () =>
  assert.deepEqual(restingIds(ids, {}, '2026-09-09'), []));
check('an unknown id in the log does not rest a listing', () =>
  assert.deepEqual(restingIds(ids, { zzz: day(-1) }, '2026-09-09'), []));

console.log('\nRefused versus failed');
check('403 is a refusal and rests', () => assert.ok(DURABLE_REFUSAL.has(403)));
check('404 and 410 rest', () =>
  assert.ok(DURABLE_REFUSAL.has(404) && DURABLE_REFUSAL.has(410)));
check('429 is not a refusal — it asks us to slow down, so retry', () =>
  assert.ok(!DURABLE_REFUSAL.has(429)));
check('a 5xx is the request failing, not being refused', () =>
  assert.ok(!DURABLE_REFUSAL.has(500) && !DURABLE_REFUSAL.has(503)));

console.log(failures ? `\n${failures} failing\n` : '\nall passing\n');
process.exitCode = failures ? 1 : 0;
