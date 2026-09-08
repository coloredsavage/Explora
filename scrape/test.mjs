#!/usr/bin/env node
/* Offline checks over the fixtures. No network, no API key, no browser. */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { fromJsonLd, readableText, candidateLinks } from './extract.mjs';
import { normalize, validate } from './normalize.mjs';
import { SOURCES } from './sources.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFile(path.join(here, 'fixtures', n), 'utf8');
const wygo = SOURCES.find((s) => s.id === 'wygo');

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
check('tidies a whole-dollar price', () =>
  assert.equal(gate({ title: 'X', venue: 'Y', address: '1 King St W, Toronto, ON',
    entry: '$13.00' }).event.entry, '$13'));

console.log('\nLink following');
check('follows event links, not the index itself', () => {
  const links = candidateLinks(index, wygo.url, wygo.followLinks, wygo.maxFollow);
  assert.deepEqual(links.sort(), ['https://wygo.world/hidenseek', 'https://wygo.world/lookalike']);
});

console.log(failures ? `\n${failures} failing\n` : '\nall passing\n');
process.exitCode = failures ? 1 : 0;
