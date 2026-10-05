#!/usr/bin/env node
/* Eventbrite: offline checks over trimmed copies of real event pages
 * (scrape/fixtures/eventbrite.*), fetched 2026-09-27. No network.
 *
 * Nothing here reads the clock. Every normalize and harvest call is handed
 * the pinned `today` below, so the fixtures (dated September and October
 * 2026) do not age out of the suite: `faketime '2027-06-01' npm test` passes
 * as it does today. A new check that needs "today" takes it from here. */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fromJsonLd, sectionProse, sectionText, echoesTitle, metaDescription } from './extract.mjs';
import { normalize, validate, asNightlife } from './normalize.mjs';
import { SOURCES } from './sources.mjs';
import { matchArt } from './art-match.mjs';
import { classifyEventbriteEvent, eventbritePrice, formatPrice, vetEventbrite, readAmount,
  settlePageNodes, alreadyHandListed, handListedIndex, eventbriteId, localityName,
  CLASSIFIER_OUTPUTS, PROFESSIONAL_TITLE, PROFESSIONAL_DESCRIPTION } from './eventbrite.mjs';

/* The suite, and only the suite, may follow pages with no pause. */
process.env.EXPLORA_TEST = '1';
process.env.FOLLOW_DELAY_MS = '0';
const { harvest, livePages, pollSource, followVerdict, carryForward, quietSources, followDelayMs,
  indexUrls, report, FOLLOW_BREAKER, MIN_FOLLOW_DELAY_MS } = await import('./run.mjs');
const { enabledSources } = await import('./sources.mjs');
const { reportDir } = await import('./dry-run-eventbrite.mjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const fixture = (n) => readFileSync(path.join(here, 'fixtures', n), 'utf8');
const eventbrite = SOURCES.find((s) => s.id === 'eventbrite');
const today = '2026-09-27';
const opts = { today, checked: today };

let failures = 0;
const check = (name, fn) => {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') throw new Error('async check passed to check() — use checkAsync()');
    console.log('  ok   ' + name);
  } catch (err) { failures++; console.log('  FAIL ' + name + '\n       ' + err.message); }
};
const checkAsync = async (name, fn) => {
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.log('  FAIL ' + name + '\n       ' + err.message); }
};

/* The run's shared report, emptied between checks that read it. */
const resetReport = () => {
  for (const k of ['kept', 'dropped', 'skipped', 'errors', 'coverage']) report[k].length = 0;
  for (const k of Object.keys(report.followFailures)) delete report.followFailures[k];
};
const reportSize = () => ['kept', 'dropped', 'skipped', 'errors'].reduce((n, k) => n + report[k].length, 0);

/* One fixture page -> normalize, the way a poll reads it. */
const page = (slug) => {
  const raws = fromJsonLd(fixture(`eventbrite.e-${slug}.html`));
  assert.equal(raws.length, 1, `${slug} should carry one Event`);
  return raws[0];
};
const poll = (slug) => normalize(page(slug), eventbrite, opts);
const kept = (slug) => {
  const r = poll(slug);
  assert.ok(r.ok, `${slug} was dropped: ${r.why}`);
  assert.deepEqual(validate(r.event), []);
  return r.event;
};
const dropped = (slug, why) => {
  const r = poll(slug);
  assert.equal(r.ok, false, `${slug} was kept`);
  assert.match(r.why, why);
  return r.why;
};

/* The page's own illustration set and categories, read from where the site
   reads them: files in illustrations/, CATEGORIES in data.js. */
const ART_FILES = new Set(readdirSync(path.join(root, 'illustrations'))
  .filter((f) => f.endsWith('.webp')).map((f) => f.replace(/\.webp$/, '')));
const ctx = vm.createContext({});
vm.runInContext(readFileSync(path.join(root, 'price.js'), 'utf8'), ctx);
vm.runInContext(readFileSync(path.join(root, 'data.js'), 'utf8') + '\n;globalThis.__C = CATEGORIES;', ctx);
const CATEGORY_KEYS = new Set(Object.keys(ctx.__C));
const priceOf = (entry) => vm.runInContext(`priceOf(${JSON.stringify({ entry })})`, ctx);

console.log('\nThe source entry');
check('enabled, with the ToS warning and the owner’s decision written beside it', () => {
  assert.equal(eventbrite.enabled, true);
  const src = readFileSync(path.join(here, 'sources.mjs'), 'utf8');
  const block = src.slice(src.indexOf("id: 'eventbrite'"), src.indexOf("id: 'harbourfront'"));
  assert.match(block, /TERMS OF SERVICE PROHIBIT AUTOMATED EXTRACTION/);
  assert.match(block, /enabled this source anyway on 2026-09-27/);
});
check('follows .ca and .com event pages, tickets and registration', () => {
  for (const u of [
    'https://www.eventbrite.ca/e/the-walrus-talks-community-reborn-tickets-1998915982513',
    'https://www.eventbrite.com/e/uk-calling-toronto-tickets-1989056146478',
    'https://www.eventbrite.ca/e/young-professionals-leadership-summit-2026-registration-1987876836129',
  ]) assert.ok(eventbrite.followLinks.test(u), u);
});
check('and nothing that only looks like one', () => {
  for (const u of [
    'https://www.eventbrite.co/e/x-tickets-1', 'https://www.eventbrite.cm/e/x-tickets-1',
    'https://www.eventbrite.co.uk/e/x-tickets-1', 'https://www.eventbrite.ca/o/organiser-123',
    'https://www.eventbrite.ca/d/canada--toronto/all-events/',
  ]) assert.ok(!eventbrite.followLinks.test(u), u);
});
check('every event on the saved listing page is a followable url, within the cap', () => {
  const listed = fromJsonLd(fixture('eventbrite.html'));
  assert.equal(listed.length, 20);
  for (const e of listed) assert.ok(eventbrite.followLinks.test(e.url), e.url);
  assert.ok(listed.length <= eventbrite.maxFollow);
});

console.log('\nPrice: Free only when every ticket is $0, otherwise the cheapest paid one');
check('0–0 is Free', () => assert.deepEqual(eventbritePrice([{ '@type': 'AggregateOffer', lowPrice: '0.0', highPrice: '0.0', priceCurrency: 'CAD' }]), { entry: 'Free' }));
check('a paid floor is the price', () => assert.deepEqual(eventbritePrice([{ '@type': 'AggregateOffer', lowPrice: '12.19', highPrice: '28.25', priceCurrency: 'CAD' }]), { entry: '$12.19' }));
check('a free tier beside paid ones is not Free, and not $0', () => {
  const r = eventbritePrice([{ '@type': 'AggregateOffer', lowPrice: '0.0', highPrice: '50.0', priceCurrency: 'CAD' }]);
  assert.equal(r.entry, undefined);
  assert.match(r.why, /free and paid tickets .*cheapest paid ticket is not in the offers/);
});
check('individual offers give the cheapest paid ticket', () =>
  assert.deepEqual(eventbritePrice([{ '@type': 'Offer', price: 0, priceCurrency: 'CAD' }, { '@type': 'Offer', price: '20.00', priceCurrency: 'CAD' }, { '@type': 'Offer', price: 50, priceCurrency: 'CAD' }]), { entry: '$20' }));
check('nested offers are read too, taking the currency from their parent', () =>
  assert.deepEqual(eventbritePrice({ '@type': 'AggregateOffer', lowPrice: 0, highPrice: 30, priceCurrency: 'CAD', offers: [{ price: 0 }, { price: 15 }, { price: 30 }] }), { entry: '$15' }));
check('no offers, or no numbers in them, is no price', () => {
  assert.match(eventbritePrice(null).why, /no offers/);
  assert.match(eventbritePrice([{ '@type': 'Offer', availability: 'InStock' }]).why, /no readable price/);
});
check('a price in another currency is not passed off as dollars here', () =>
  assert.match(eventbritePrice([{ lowPrice: '5', highPrice: '9', priceCurrency: 'USD' }]).why, /USD/));
check('never "$0" in any combination', () => {
  const vals = [0, '0', '0.0', '0.00', 0.001, 5, '19.5', 40];
  for (const a of vals) for (const b of vals) {
    const r = eventbritePrice([{ lowPrice: a, highPrice: b, priceCurrency: 'CAD' }, { price: a, priceCurrency: 'CAD' }]);
    if (r.entry) assert.doesNotMatch(r.entry, /^\$0(\.0+)?$/, JSON.stringify([a, b, r]));
  }
});
check('written the way the board writes prices', () => {
  assert.equal(formatPrice(12), '$12');
  assert.equal(formatPrice(19.5), '$19.50');
  assert.equal(formatPrice(27.96), '$27.96');
  assert.equal(eventbritePrice([{ lowPrice: '12.0', highPrice: '12.0', priceCurrency: 'CAD' }]).entry, '$12');
});
check('and price.js buckets what it writes', () => {
  assert.equal(priceOf('Free'), 'free');
  assert.equal(priceOf('$12.19'), 'under20');
  assert.equal(priceOf('$19.50'), 'under20');
  assert.equal(priceOf('$27.96'), 'over20');
});

console.log('\nPrice: read strictly, or not at all');
const CAD = { priceCurrency: 'CAD' };
check("'TBD' is unreadable, not Free", () => {
  const r = eventbritePrice([{ price: 'TBD', ...CAD }]);
  assert.equal(r.entry, undefined);
  assert.match(r.why, /unreadable price \("TBD"\)/);
});
check("'' is unreadable, not Free", () => {
  const r = eventbritePrice([{ lowPrice: '', highPrice: '', ...CAD }]);
  assert.equal(r.entry, undefined);
  assert.match(r.why, /empty price/);
});
check('a free tier beside an unreadable one is not Free either', () =>
  assert.equal(eventbritePrice([{ lowPrice: '0', highPrice: 'TBA', ...CAD }]).entry, undefined));
check("'-5' is refused, not read as $5", () => {
  for (const v of ['-5', '-5.00', '$-5', '-$5', -5, '−5']) {
    const r = eventbritePrice([{ price: v, ...CAD }]);
    assert.equal(r.entry, undefined, JSON.stringify(v));
    assert.match(r.why, /negative price/, JSON.stringify(v));
  }
});
check("a comma decimal: '12,50' is $12.50, not $1250", () => {
  assert.deepEqual(eventbritePrice([{ lowPrice: '12,50', highPrice: '12,50', ...CAD }]), { entry: '$12.50' });
  assert.deepEqual(eventbritePrice([{ price: '7,5', ...CAD }]), { entry: '$7.50' });
});
check('a thousands comma is a thousands comma, and anything else with a comma is unreadable', () => {
  assert.deepEqual(readAmount('1,250.00'), { n: 1250 });
  assert.match(readAmount('1,2,3').bad, /unreadable/);
  assert.match(readAmount('12,5,0').bad, /unreadable/);
});
check('currency marks around a figure are read, words are not', () => {
  assert.deepEqual(readAmount('$12'), { n: 12 });
  assert.deepEqual(readAmount('CA$19.50'), { n: 19.5 });
  assert.deepEqual(readAmount('12.00 CAD'), { n: 12 });
  assert.match(readAmount('free').bad, /unreadable/);
  assert.match(readAmount('Donation').bad, /unreadable/);
  assert.equal(readAmount(undefined), null);
  assert.equal(readAmount(null), null);
});
check('an unreadable price on a real page drops the event instead of publishing it', () => {
  const r = normalize({ ...page('walrus-talks'), offers: [{ '@type': 'AggregateOffer', lowPrice: 'TBD', highPrice: 'TBD', ...CAD }] }, eventbrite, opts);
  assert.equal(r.ok, false);
  assert.match(r.why, /unreadable price/);
});
check('sold-out tickets are not the cheapest price', () => {
  assert.deepEqual(eventbritePrice([
    { price: 10, availability: 'https://schema.org/SoldOut', ...CAD },
    { price: 20, availability: 'https://schema.org/InStock', ...CAD },
  ]), { entry: '$20' });
  assert.deepEqual(eventbritePrice([
    { price: 8, availability: 'OutOfStock', ...CAD },
    { price: 14, availability: 'InStock', ...CAD },
  ]), { entry: '$14' });
});
check('nor is a sold-out free tier a reason to call it Free', () =>
  assert.deepEqual(eventbritePrice([
    { price: 0, availability: 'https://schema.org/SoldOut', ...CAD },
    { price: 15, ...CAD },
  ]), { entry: '$15' }));
check('a sold-out child is left out even when its parent summarises it', () =>
  assert.deepEqual(eventbritePrice({ '@type': 'AggregateOffer', lowPrice: 5, highPrice: 30, ...CAD,
    offers: [{ price: 5, availability: 'SoldOut' }, { price: 12 }, { price: 30 }] }), { entry: '$12' }));
check('everything sold out: dropped, and says so', () => {
  const r = eventbritePrice([{ lowPrice: '10', highPrice: '20', availability: 'https://schema.org/SoldOut', ...CAD }]);
  assert.equal(r.entry, undefined);
  assert.match(r.why, /sold out or unavailable/);
});
check('no currency on the offers: dropped, not assumed to be dollars', () => {
  for (const offers of [[{ lowPrice: '12', highPrice: '20' }], [{ lowPrice: '0', highPrice: '0' }], [{ price: 5, ...CAD }, { price: 3 }]]) {
    const r = eventbritePrice(offers);
    assert.equal(r.entry, undefined, JSON.stringify(offers));
    assert.match(r.why, /no currency/, JSON.stringify(offers));
  }
  const r = normalize({ ...page('artcell'), offers: [{ '@type': 'AggregateOffer', lowPrice: '27.96', highPrice: '54.58' }] }, eventbrite, opts);
  assert.equal(r.ok, false);
  assert.match(r.why, /no currency/);
});
check('a free tier with no highPrice says so without "$-Infinity"', () => {
  const r = eventbritePrice([{ price: 0, ...CAD }, { lowPrice: 10, ...CAD }]);
  assert.equal(r.entry, undefined);
  assert.doesNotMatch(r.why, /Infinity|NaN/);
  assert.match(r.why, /free and paid tickets; the cheapest paid ticket is not in the offers/);
  assert.match(eventbritePrice([{ lowPrice: 0, highPrice: 76.41, ...CAD }]).why, /up to \$76\.41/);
});

console.log('\nThe gates, on the real pages');
check('the Walrus Talks: free, kept', () => assert.equal(kept('walrus-talks').entry, 'Free'));
check('every kept event carries an entry read from its offers', () => {
  for (const slug of ['walrus-talks', 'douglas-stuart', 'artcell', 'rooftop-day-party', 'end-times-fascism', 'best-croissant', 'u-of-t-historical-tour']) {
    const e = kept(slug);
    assert.ok(e.entry, `${slug} has no entry`);
    assert.doesNotMatch(e.entry, /^\$0/);
  }
});
check('no offers on the page: dropped, and says so', () => dropped('somebody-anybody', /no offers .* no readable price/));
check('the $35 ceiling: UK Calling at $39.96 is dropped', () => dropped('uk-calling', /\$39\.96 is past what this calendar is for/));
check('$35 exactly is still in', () => {
  const raw = { ...page('artcell'), offers: [{ lowPrice: '35.00', highPrice: '60', priceCurrency: 'CAD' }] };
  const r = normalize(raw, eventbrite, opts);
  assert.ok(r.ok, r.why);
  assert.equal(r.event.entry, '$35');
});
check('DOC Wine at 3045 Southcreek Road, Mississauga is not in Toronto', () => dropped('doc-wine', /not in Toronto \(Mississauga\)/));
check('the Heart Failure Symposium is dropped as a conference', () => dropped('heart-failure-symposium', /conference, summit or professional event.*Symposium/));
check('researchED is dropped as Eventbrite files it: a BusinessEvent', () => dropped('researched', /BusinessEvent/));
check('and would be on its description even if it were filed as a plain Event', () => {
  const r = normalize({ ...page('researched'), types: ['Event'] }, eventbrite, opts);
  assert.equal(r.ok, false);
  assert.match(r.why, /description says “keynote”/);
});
const TITLE_DROPS = ['The Small Business Summit 2026', 'Young Professionals Leadership Summit 2026',
  '16th African Economic Summit (Friends of Africa-2026)', 'International Can-Africa Business Leaders Conference - 2026',
  'Global Data Centre & Cloud Expo Canada', 'Ted Rogers Centre for Heart Research: 2026 Heart Failure Symposium'];
check('the six business titles from the dry run are still dropped, from the listing and on the page', () => {
  for (const t of TITLE_DROPS) {
    assert.ok(eventbrite.skipBeforeFollow({ title: t, url: 'https://www.eventbrite.ca/e/x-tickets-1000000001' }), t);
    const r = normalize({ ...page('walrus-talks'), title: t }, eventbrite, opts);
    assert.equal(r.ok, false, t);
    assert.match(r.why, /business|conference|professional/, t);
  }
});
check('the Data Centre & Cloud Expo goes on its industry, not on the word "expo"', () => {
  assert.ok(!PROFESSIONAL_TITLE.test('Global Expo Canada'));
  assert.match(PROFESSIONAL_TITLE.exec('Global Data Centre & Cloud Expo Canada')[0], /data centre|cloud expo/i);
  assert.ok(PROFESSIONAL_TITLE.test('Canada Cloud Expo'));
  assert.ok(PROFESSIONAL_TITLE.test('Toronto Franchise Expo'));
  assert.ok(PROFESSIONAL_TITLE.test('Healthcare Tech Forum'));
});
check('and more of the business end: keynotes, symposia, networking', () => {
  for (const t of ['Annual Keynote Breakfast', 'Professional Development Day for Teachers', 'Founders Networking Night', 'Two Symposia on Care']) {
    const r = normalize({ ...page('walrus-talks'), title: t }, eventbrite, opts);
    assert.equal(r.ok, false, t);
    assert.match(r.why, /business|conference|professional/, t);
  }
});
check('an expo, a convention, a forum, Steve Jobs and a summit you hike to are all kept', () => {
  for (const t of ['Toronto Comic Expo', 'Anime Convention', 'Community Forum on Transit',
    'Steve Jobs (2015) — Outdoor Screening', 'Sunrise Hike to the Summit', 'Careers in Clay: A Pottery Night', 'Marketing Your Band — A Musicians Q&A']) {
    assert.equal(eventbrite.skipBeforeFollow({ title: t, url: 'https://www.eventbrite.ca/e/x-tickets-1000000002' }), null, t);
    const r = normalize({ ...page('walrus-talks'), title: t }, eventbrite, opts);
    assert.ok(r.ok, `${t}: ${r.why}`);
  }
});
check('a hike whose page says "reach the summit" is kept', () => {
  const desc = 'A moderate 8 km hike through the Don Valley. We reach the summit of the escarpment around noon, then walk back for lunch.';
  assert.ok(!PROFESSIONAL_DESCRIPTION.test(desc));
  const r = normalize({ ...page('walrus-talks'), title: 'Don Valley Escarpment Hike', description: desc }, eventbrite, opts);
  assert.ok(r.ok, r.why);
  assert.equal(r.event.category, 'outdoors');
});
check('"conference" in passing on a page is no longer enough', () => {
  const desc = 'Local band The Marsh play songs from the album they recorded after a conference tour of church basements.';
  const r = normalize({ ...page('artcell'), title: 'The Marsh — Live', description: desc }, eventbrite, opts);
  assert.ok(r.ok, r.why);
});
check('while a bake sale, a salsa night and a book launch get through the filter', () => {
  for (const t of ['Church Bake Sale', 'Salsa Night at the Lula Lounge', 'Book Launch: River Stories']) {
    assert.ok(!PROFESSIONAL_TITLE.test(t), t);
  }
});
check('a recurring series is not a months-long event', () => {
  const r = normalize({ ...page('walrus-talks'), startDate: '2026-04-05T20:00:00-04:00', endDate: '2026-12-27T23:00:00-05:00' }, eventbrite, opts);
  assert.match(r.why, /recurring series \(2026-04-05 to 2026-12-27\)/);
});
check('while a weekend festival still is one', () => {
  const r = normalize({ ...page('walrus-talks'), startDate: '2026-10-09T10:00:00-04:00', endDate: '2026-10-11T18:00:00-04:00' }, eventbrite, opts);
  assert.ok(r.ok, r.why);
});
check('an online-only event is dropped', () => {
  const r = normalize({ ...page('walrus-talks'), attendanceMode: 'https://schema.org/OnlineEventAttendanceMode' }, eventbrite, opts);
  assert.match(r.why, /online only/);
});
check('a GTA suburb in the address is out; Markham Street in Toronto is not', () => {
  const base = { ...page('walrus-talks'), locality: null, streetAddress: null };
  assert.match(vetEventbrite({ ...base, address: '5000 Hwy 7, Markham, ON L3R 4M9' }).reject, /not in Toronto \(Markham\)/);
  assert.equal(vetEventbrite({ ...base, address: '600 Markham St, Toronto, ON M6G 2L8' }).reject, undefined);
});
check("addressLocality as organisers type it: 'Toronto, ON', 'City of Toronto'", () => {
  for (const locality of ['Toronto, ON', 'City of Toronto', 'Toronto, Ontario, Canada', 'toronto ON', 'Scarborough, ON']) {
    assert.equal(vetEventbrite({ ...page('walrus-talks'), locality }).reject, undefined, locality);
  }
  assert.match(vetEventbrite({ ...page('walrus-talks'), locality: 'City of Mississauga' }).reject, /not in Toronto \(City of Mississauga\)/);
  assert.match(vetEventbrite({ ...page('walrus-talks'), locality: 'Brampton, ON' }).reject, /not in Toronto/);
  assert.equal(localityName('City of Toronto'), 'Toronto');
});
check('and joined to a bare street it reads Toronto, ON once', () => {
  const v = vetEventbrite({ ...page('walrus-talks'), streetAddress: '93 Charles St W', locality: 'Toronto, ON' });
  assert.equal(v.address, '93 Charles St W, Toronto, ON');
});
check('a series node of 14 days or less does not show up beside its dated node', () => {
  const base = page('walrus-talks');
  const dated = { ...base, startDate: '2026-10-08T19:00:00-04:00', endDate: '2026-10-08T21:00:00-04:00' };
  const series = { ...base, startDate: '2026-10-08T19:00:00-04:00', endDate: '2026-10-10T21:00:00-04:00' };
  const { keep, dropped } = settlePageNodes([series, dated]);
  assert.deepEqual(keep, [dated]);
  assert.match(dropped[0].why, /series node \(2026-10-08 to 2026-10-10\) beside its dated node \(2026-10-08\)/);
});
await checkAsync('and harvest publishes the day card only', async () => {
  const node = (start, end, type = 'Event') => ({ '@context': 'https://schema.org', '@type': type, name: 'Three Nights of Jazz',
    startDate: start, endDate: end, url: 'https://www.eventbrite.ca/e/three-nights-of-jazz-tickets-1000000009',
    location: { '@type': 'Place', name: 'The Emmet Ray', address: { '@type': 'PostalAddress', streetAddress: '924 College St', addressLocality: 'Toronto' } },
    offers: [{ '@type': 'AggregateOffer', lowPrice: '12', highPrice: '12', priceCurrency: 'CAD' }] });
  /* Typed as a plain Event, as Eventbrite's series nodes are: an
     'EventSeries' node never reaches here, because extract.mjs only reads
     types ending in "Event". */
  const html = `<script type="application/ld+json">${JSON.stringify([
    node('2026-10-08T20:00:00-04:00', '2026-10-10T23:00:00-04:00', 'MusicEvent'),
    node('2026-10-08T20:00:00-04:00', '2026-10-08T23:00:00-04:00')])}</script>`;
  resetReport();
  const out = await harvest(eventbrite, [{ url: 'https://www.eventbrite.ca/e/three-nights-of-jazz-tickets-1000000009', html, isIndex: false }], { today });
  assert.equal(out.length, 1);
  assert.equal(out[0].schedule.kind, 'day');
  assert.equal(out[0].schedule.date, '2026-10-08');
  assert.ok(report.dropped.some((d) => /series node/.test(d)));
});
await checkAsync('nor when the series and its dated night are two event pages', async () => {
  const at = (id, start, end) => {
    const url = `https://www.eventbrite.com/e/three-nights-of-jazz-tickets-${id}`;
    return { url, isIndex: false, html: `<script type="application/ld+json">${JSON.stringify({ '@type': 'MusicEvent', name: 'Three Nights of Jazz',
      startDate: start, endDate: end, url,
      location: { '@type': 'Place', name: 'The Emmet Ray', address: { '@type': 'PostalAddress', streetAddress: '924 College St', addressLocality: 'Toronto' } },
      offers: [{ '@type': 'AggregateOffer', lowPrice: '12', highPrice: '12', priceCurrency: 'CAD' }] })}</script>` };
  };
  resetReport();
  const out = await harvest(eventbrite, [
    at('1000000011', '2026-10-08T20:00:00-04:00', '2026-10-10T23:00:00-04:00'),
    at('1000000012', '2026-10-08T20:00:00-04:00', '2026-10-08T23:00:00-04:00'),
  ], { today });
  assert.deepEqual(out.map((e) => e.schedule.kind), ['day']);
  assert.ok(report.dropped.some((d) => /series node \(2026-10-08 to 2026-10-10\).*on another event page/.test(d)), report.dropped.join('\n'));
  assert.equal(report.kept.length, 1);
  /* Two different nights of one show are both kept. */
  resetReport();
  const two = await harvest(eventbrite, [
    at('1000000013', '2026-10-08T20:00:00-04:00', '2026-10-08T23:00:00-04:00'),
    at('1000000014', '2026-10-09T20:00:00-04:00', '2026-10-09T23:00:00-04:00'),
  ], { today });
  assert.equal(two.length, 2);
});
check('while a page with one overnight node keeps it, and a long series is still refused', () => {
  assert.equal(settlePageNodes([page('whine-slow')]).keep.length, 1);
  const r = normalize({ ...page('walrus-talks'), startDate: '2026-10-01T20:00:00-04:00', endDate: '2026-10-20T23:00:00-04:00' }, eventbrite, opts);
  assert.match(r.why, /recurring series/);
});
check('the Mississauga fix is Eventbrite’s alone: other sources keep the old town gate', () => {
  const wygo = SOURCES.find((s) => s.id === 'wygo');
  const r = normalize({ title: 'Salmon Run Hike', startDate: '2026-10-03', venue: 'Erindale Park',
    address: '1695 Dundas St W, Mississauga, ON' }, wygo, opts);
  assert.ok(r.ok, r.why);
});
check('the address says Toronto once', () =>
  assert.equal(kept('walrus-talks').address, '93 Charles St W, Toronto, ON M5S 2C7'));

console.log('\nFiling: the titles that went wrong before');
check('The Walrus Talks Community Reborn is a talk', () => {
  const e = kept('walrus-talks');
  assert.equal(e.category, 'stage');
  assert.equal(e.art, 'art-lectern');
});
check('Douglas Stuart Toronto launch "John of John" is books', () => {
  const e = kept('douglas-stuart');
  assert.equal(e.category, 'books');
  assert.equal(e.art, 'art-books');
  assert.equal(e.entry, '$19.50');
});
check('a launch whose page names a bookshop is books', () =>
  assert.equal(kept('end-times-fascism').category, 'books'));
check('“the launch of <book> by <author>” is books with no other clue', () =>
  assert.equal(classifyEventbriteEvent({ title: 'Toronto launch', description: 'Celebrate the launch of Night Water by Ann Lee.' }).category, 'books'));
check('ARTCELL – Live in Toronto is music', () => {
  const e = kept('artcell');
  assert.equal(e.category, 'music');
  assert.equal(e.art, 'art-music');
});
check('UK Calling - Toronto is music, on its page', () =>
  assert.equal(classifyEventbriteEvent(page('uk-calling')).category, 'music'));
check('and on its venue if the page said nothing', () =>
  assert.equal(classifyEventbriteEvent({ title: 'UK Calling - Toronto', description: '', venue: 'The Concert Hall' }).category, 'music'));
check('a rooftop day party files like Revival’s DJ nights', () => {
  const e = kept('rooftop-day-party');
  assert.equal(e.category, 'nightlife');
  assert.equal(e.art, matchArt({ title: 'Afrobeats & Friends | Amapiano | R&B | Dancehall' }));
  assert.equal(e.art, 'art-decks');
  /* The claim in the name, tested rather than assumed. Revival carries one
     category for everything it publishes, so its DJ nights only reach the
     same place through asNightlife; comparing against revival.category would
     now compare against the source default and pass whatever happened. */
  const revival = SOURCES.find((s) => s.id === 'revival');
  assert.equal(revival.category, 'music');
  assert.equal(asNightlife(revival.category, 'Afrobeats & Friends | Amapiano | R&B | Dancehall', ''), 'nightlife');
  assert.equal(asNightlife(revival.category, 'Destination Dancefloor', ''), 'nightlife');
});
check('so does a dancehall party', () => {
  const c = classifyEventbriteEvent(page('whine-slow'));
  assert.deepEqual([c.category, c.art], ['nightlife', 'art-decks']);
});
check('plurals and stems: Talks, Lectures, Bookshop, Concerts, Tastings', () => {
  const c = (title) => classifyEventbriteEvent({ title }).category;
  assert.equal(c('Evening Lectures on the City'), 'stage');
  assert.equal(c('Signing at the Bookshop'), 'books');
  assert.equal(c('Lunchtime Concerts'), 'music');
  assert.equal(c('Cider Tastings'), 'food');
  assert.equal(c('Walking Tours of Cabbagetown'), 'architecture');
});
check('a croissant competition is food; a historical tour is architecture', () => {
  assert.equal(kept('best-croissant').category, 'food');
  assert.equal(kept('u-of-t-historical-tour').category, 'architecture');
});

console.log('\nFiling: booking verbs, rocks, metal and tea');
const filed = (title, description = '', venue = '') => {
  const c = classifyEventbriteEvent({ title, description, venue });
  return [c.category, c.art];
};
check("'Book now' and 'Book your tickets' do not make a costume night books", () => {
  assert.notEqual(filed('Halloween Costume Night', 'Book your tickets now — costumes encouraged, prizes for the best.')[0], 'books');
  assert.notEqual(filed('Book now: Costume Night at Lavelle')[0], 'books');
  assert.notEqual(filed('Masquerade Costume Ball', 'Book a table for your group. Booking closes Friday.')[0], 'books');
  assert.deepEqual(filed('Book now: Costume Party at Lavelle'), ['nightlife', 'art-decks']);
});
check('nor a product launch, quoted name and all', () => {
  assert.notEqual(filed('Product Launch "Nova X1"', 'Book now to see the reveal. Book tickets early.')[0], 'books');
  assert.notEqual(filed('Sneaker launch "Air Toronto"', 'Presented by Nike Canada. Book your spot.')[0], 'books');
  assert.notEqual(filed('Launch Night', 'Book now for the launch of our spring menu.')[0], 'books');
});
check('while real book words still count', () => {
  assert.equal(filed('Signing at the Bookshop')[0], 'books');
  assert.equal(filed('Book Club: The Handmaid’s Tale')[0], 'books');
  assert.equal(filed('Used Books Sale')[0], 'books');
  assert.equal(filed('Poetry Night at the Library')[0], 'books');
});
check('a launch is books only with book context: bookshop, author, novel, memoir, publisher, "by <Name>", an imprint', () => {
  for (const [t, d] of [
    ['Launch: The Quiet Year', 'Join us at Type Books for the launch.'],
    ['Launch night', 'Meet the author and hear a reading.'],
    ['Launch party', 'Celebrating her debut novel.'],
    ['Spring launch', 'A new memoir about growing up in Scarborough.'],
    ['Launch', 'Hosted with the publisher, Coach House Books.'],
    ['Toronto launch "Low Water"', ''],
    ['Launch', 'Celebrate "Low Water" by Maya Chen.'],
    ['Launch: Low Water', 'Presented with Knopf Canada.'],
  ]) {
    if (t === 'Toronto launch "Low Water"') assert.notEqual(filed(t, d)[0], 'books', 'a quoted title alone is not a book');
    else assert.deepEqual(filed(t, d), ['books', 'art-books'], `${t} / ${d}`);
  }
});
check("'Rock Climbing' is not music, and nor is 'Metal Casting Workshop'", () => {
  assert.notEqual(filed('Rock Climbing for Beginners')[0], 'music');
  assert.notEqual(filed('Intro to Rock Climbing', 'Learn to climb at our gym.')[0], 'music');
  assert.deepEqual(filed('Metal Casting Workshop'), ['dropin', 'art-pottery']);
  assert.notEqual(filed('Metalworking Basics')[0], 'music');
  assert.equal(filed('Punk Rock Night')[0], 'music');
  assert.equal(filed('Heavy Metal Tribute')[0], 'music');
});
check("'Tea Party' does not get the DJ decks", () => {
  assert.notEqual(filed('Mad Hatter Tea Party')[1], 'art-decks');
  assert.deepEqual(filed('Victorian Tea Party'), ['food', 'art-food']);
  assert.deepEqual(filed('Toronto Rooftop Day Party'), ['nightlife', 'art-decks']);
});
check('the cases that went wrong before still file right: Walrus Talks, two launches, two bands', () => {
  assert.deepEqual(filed(page('walrus-talks').title, page('walrus-talks').description), ['stage', 'art-lectern']);
  const ds = kept('douglas-stuart');
  assert.deepEqual([ds.category, ds.art], ['books', 'art-books']);
  const nk = kept('end-times-fascism');
  assert.deepEqual([nk.category, nk.art], ['books', 'art-books']);
  const ac = kept('artcell');
  assert.deepEqual([ac.category, ac.art], ['music', 'art-music']);
  assert.equal(classifyEventbriteEvent(page('uk-calling')).category, 'music');
});
check('a comic expo is not comedy; a stand-up comic still is', () => {
  assert.notEqual(filed('Toronto Comic Expo')[0], 'comedy');
  assert.equal(filed('Stand-up comic showcase')[0], 'comedy');
});

console.log('\nEvery drawing and category the classifier can return is real');
check('every art id is a file in illustrations/', () => {
  for (const o of CLASSIFIER_OUTPUTS) assert.ok(ART_FILES.has(o.art), `${o.name} -> ${o.art} has no illustrations/${o.art}.webp`);
});
check('every category is one data.js defines', () => {
  for (const o of CLASSIFIER_OUTPUTS) assert.ok(CATEGORY_KEYS.has(o.category), `${o.name} -> ${o.category} is not in CATEGORIES`);
});
check('and so is everything the fixtures actually produced', () => {
  const slugs = readdirSync(path.join(here, 'fixtures')).filter((n) => n.startsWith('eventbrite.e-'))
    .map((n) => n.slice('eventbrite.e-'.length, -'.html'.length));
  assert.ok(slugs.length >= 10);
  for (const slug of slugs) {
    const r = poll(slug);
    if (!r.ok) continue;
    assert.ok(ART_FILES.has(r.event.art), `${slug}: ${r.event.art}`);
    assert.ok(CATEGORY_KEYS.has(r.event.category), `${slug}: ${r.event.category}`);
  }
});

console.log('\nThe poll: listing page, follows, and scraped.js');
await checkAsync('the listing page itself publishes nothing — it is skipped, not merely unpriced', async () => {
  /* A complete, priced, publishable Event node. As an event page it is kept;
     as the index page only the listingOnly skip in harvest keeps it off. */
  const html = fixture('eventbrite.e-walrus-talks.html');
  resetReport();
  const asEventPage = await harvest(eventbrite, [{ url: 'https://www.eventbrite.ca/e/the-walrus-talks-community-reborn-tickets-1998915982513', html, isIndex: false }], { today });
  assert.equal(asEventPage.length, 1, 'control: the page is publishable when it is not the index');
  resetReport();
  const asIndex = await harvest(eventbrite, [{ url: eventbrite.url, html, isIndex: true }], { today });
  assert.equal(asIndex.length, 0);
  /* And the real listing leaves no trace at all: not kept, not dropped for
     having no price — not read. */
  await harvest(eventbrite, [{ url: eventbrite.url, html: fixture('eventbrite.html'), isIndex: true }], { today });
  assert.equal(reportSize(), 0, `the index was read: ${JSON.stringify(report.dropped.slice(0, 2))}`);
});
await checkAsync('harvest judges "already past" by the date it is handed, not the clock', async () => {
  const html = fixture('eventbrite.e-walrus-talks.html');
  const url = 'https://www.eventbrite.ca/e/the-walrus-talks-community-reborn-tickets-1998915982513';
  assert.equal((await harvest(eventbrite, [{ url, html, isIndex: false }], { today: '2026-09-27' })).length, 1);
  resetReport();
  assert.equal((await harvest(eventbrite, [{ url, html, isIndex: false }], { today: '2026-12-01' })).length, 0);
  assert.ok(report.dropped.some((d) => /already past \(2026-10-08\)/.test(d)));
});
await checkAsync('every listed event is followed, or dropped with a reason', async () => {
  /* A browser that serves the saved listing, and the saved event pages where
     there are some; the rest answer 404, and one times out. */
  const saved = new Map();
  for (const n of readdirSync(path.join(here, 'fixtures')).filter((x) => x.startsWith('eventbrite.e-'))) {
    const html = fixture(n);
    const url = fromJsonLd(html)[0].url;
    saved.set(url, html);
  }
  const listed = fromJsonLd(fixture('eventbrite.html'));
  const slow = listed.find((e) => !saved.has(e.url) && !eventbrite.skipBeforeFollow(e)).url;
  let current = '';
  const browser = { newContext: async () => ({
    newPage: async () => ({
      goto: async (u) => {
        current = u;
        if (u === slow) throw new Error('page.goto: Timeout 45000ms exceeded.');
        const ok = u.endsWith('/robots.txt') || u === eventbrite.url || saved.has(u);
        return { ok: () => ok, status: () => (ok ? 200 : 404) };
      },
      content: async () => (current.endsWith('/robots.txt') ? 'User-agent: *\nAllow: /\n'
        : current === eventbrite.url ? fixture('eventbrite.html') : saved.get(current)),
    }),
    close: async () => {},
  }) };
  resetReport();
  const pages = await livePages(eventbrite, browser);
  const out = await harvest(eventbrite, pages, { today });
  assert.equal(pages.listed, 20);
  const ruledOut = listed.filter((e) => eventbrite.skipBeforeFollow(e));
  assert.ok(ruledOut.length >= 5, `only ${ruledOut.length} conferences ruled out from the listing`);
  assert.equal(pages.followed, 20 - ruledOut.length);
  for (const e of ruledOut) {
    assert.ok(report.dropped.some((d) => d.startsWith(`eventbrite: ${e.title} — `) && d.endsWith('(not fetched)')), e.title);
  }
  const accounted = new Set([...out.map((e) => e.title), ...report.dropped.map((d) => d.replace(/^eventbrite: /, '').split(' — ')[0])]);
  for (const e of listed) assert.ok(accounted.has(e.title), `${e.title} was neither kept nor dropped`);
  assert.ok(report.dropped.some((d) => d.includes('could not be read')));
  assert.ok(report.errors.some((d) => d.includes('Timeout')), 'the timeout is reported');
  assert.equal(pages.followFailures, 2, 'one timeout and one 404, counted');
  assert.equal(report.followFailures.eventbrite, 2);
  assert.equal(followVerdict(pages).failed, false, 'two of fourteen is not a failed source');
  assert.ok(out.length >= 5, `kept ${out.length}`);
});
check('an offline poll leaves scraped.js exactly as it was', () => {
  const hash = () => createHash('sha256').update(readFileSync(path.join(root, 'scraped.js'))).digest('hex');
  const before = hash();
  const mtime = statSync(path.join(root, 'scraped.js')).mtimeMs;
  execFileSync(process.execPath, [path.join(here, 'run.mjs'), '--offline'], { cwd: root, stdio: 'pipe' });
  assert.equal(hash(), before);
  assert.equal(statSync(path.join(root, 'scraped.js')).mtimeMs, mtime);
});
check('the dry run refuses to write inside the repository', () => {
  assert.throws(() => reportDir(root), /refusing/);
  assert.throws(() => reportDir(path.join(root, 'scrape')), /refusing/);
  assert.ok(!reportDir(null).startsWith(root + path.sep));
  assert.ok(reportDir(null).startsWith(os.tmpdir()));
});

/* A made-up listing of `n` free Toronto events, each with its own page, and a
   browser that serves them — and fails the ones `fails(i)` says to. */
const synthetic = (n) => {
  const events = Array.from({ length: n }, (_, i) => ({
    '@context': 'https://schema.org', '@type': 'Event', name: `Community Walk ${i + 1}`,
    startDate: '2026-10-10T10:00:00-04:00', endDate: '2026-10-10T12:00:00-04:00',
    url: `https://www.eventbrite.ca/e/community-walk-${i + 1}-tickets-${2000000000 + i}`,
    location: { '@type': 'Place', name: `Park ${i + 1}`, address: { '@type': 'PostalAddress', streetAddress: `${i + 1} Queen St W`, addressLocality: 'Toronto' } },
    offers: [{ '@type': 'AggregateOffer', lowPrice: '0', highPrice: '0', priceCurrency: 'CAD' }],
  }));
  const ld = (x) => `<script type="application/ld+json">${JSON.stringify(x)}</script>`;
  const listing = ld({ '@type': 'ItemList', itemListElement: events.map((e, i) => ({ '@type': 'ListItem', position: i + 1, item: { ...e, offers: undefined } })) });
  return { events, listing, pageFor: new Map(events.map((e) => [e.url, ld(e)])) };
};
/* `tried` is event pages only. Every one of the source's listing pages is
   served here, not just source.url: livePages reads source.url plus each
   alsoIndex, and a harness that knew about only the first counted the extra
   ones as event pages — which made the breaker look like it had fetched one
   page more than it had. The extra indexes serve an empty list, so the link
   count is exactly what synthetic() says and these checks stay about the
   breaker rather than about pooling. */
const EMPTY_LISTING = '<script type="application/ld+json">'
  + JSON.stringify({ '@type': 'ItemList', itemListElement: [] }) + '</script>';
const fakeBrowser = ({ listing, pageFor }, fails = () => false) => {
  const tried = [];
  const indexes = indexUrls(eventbrite);
  let current = '';
  const browser = { newContext: async () => ({
    newPage: async () => ({
      goto: async (u) => {
        current = u;
        if (u.endsWith('/robots.txt')) return { ok: () => true, status: () => 200 };
        if (indexes.includes(u)) return { ok: () => true, status: () => 200 };
        const i = tried.length;
        tried.push(u);
        if (fails(i, u)) throw new Error('page.goto: Timeout 45000ms exceeded.');
        const ok = pageFor.has(u);
        return { ok: () => ok, status: () => (ok ? 200 : 404) };
      },
      content: async () => (current.endsWith('/robots.txt') ? 'User-agent: *\nAllow: /\n'
        : current === eventbrite.url ? listing
        : indexes.includes(current) ? EMPTY_LISTING
        : pageFor.get(current)),
    }),
    close: async () => {},
  }) };
  return { browser, tried };
};

console.log('\nThe description Eventbrite does not put in its structured data');
check('all three of its description fields are just the title', () => {
  const html = fixture('eventbrite.e-croissant-overview.html');
  const raw = fromJsonLd(html)[0];
  assert.equal(raw.description, raw.title);
  assert.ok(echoesTitle(raw.description, raw.title));
  assert.ok(echoesTitle(metaDescription(html), raw.title), 'meta description should echo the title too');
});
check('sectionProse drops the heading the container holds', () => {
  const html = fixture('eventbrite.e-croissant-overview.html');
  const title = fromJsonLd(html)[0].title;
  /* Ungated, the block opens with the event's own h2. */
  assert.match(sectionText(html), /^Best Croissant & Best Baguette in Toronto - The 2026 Competition On Sunday/);
  /* Given the title, it starts at the prose — which is also what keeps the
     first sentence inside the length budget instead of cut off for it. */
  const prose = sectionProse(html, { title });
  assert.match(prose, /^On Sunday, October 4th/);
  assert.ok(!/Best Croissant/.test(prose.slice(0, 40)), 'the heading leaked through');
  /* An ampersand and a double space in the markup must not defeat it. */
  const messy = html.replace('<h2>Best Croissant &amp; Best', '<h2>Best  Croissant  and  Best');
  assert.match(sectionProse(messy, { title }), /^On Sunday, October 4th/);
});
check('sectionProse reads the Overview block instead', () => {
  const prose = sectionProse(fixture('eventbrite.e-croissant-overview.html'), { title: fromJsonLd(fixture('eventbrite.e-croissant-overview.html'))[0].title });
  assert.match(prose, /^On Sunday, October 4th, in front of a panel of professionals/);
  assert.match(prose, /People's Choice Award/);
  /* Both paragraphs, and not run together into one word. */
  assert.match(prose, /Toronto\. Sample all the finest/);
  assert.ok(!/Overview|module|scss/.test(prose), 'markup leaked into the prose');
});
check('the hash in the class name is not what it matches on', () => {
  const html = fixture('eventbrite.e-croissant-overview.html');
  /* Eventbrite ships a new CSS module hash; the prose must still be found. */
  const rebuilt = html.replace(/dJyb9a/g, 'Zq91xK').replace(/5yIgma/g, 'aB3dEf');
  assert.match(sectionProse(rebuilt, { title: fromJsonLd(html)[0].title }), /^On Sunday, October 4th/);
});
check('no Overview block, or prose that is really a logistics block, is null', () => {
  assert.equal(sectionProse(fixture('eventbrite.e-best-croissant.html')), null);
  assert.equal(sectionText(fixture('eventbrite.e-best-croissant.html')), null);
  assert.equal(sectionProse(''), null);
  assert.equal(sectionProse('<div class="Overview-x__summary"><p>\u{1F4CD} MIA, 244 Adelaide St W \u{1F553} 10pm \u{1F39F} $25</p></div>'), null);
});
await checkAsync('a poll of that page publishes the prose, not the title', async () => {
  const html = fixture('eventbrite.e-croissant-overview.html');
  resetReport();
  const out = await harvest(eventbrite, [{ url: fromJsonLd(html)[0].url, html, isIndex: false }], { today });
  assert.equal(out.length, 1);
  assert.match(out[0].description, /^On Sunday, October 4th/);
  assert.notEqual(out[0].description, out[0].title);
});

console.log('\nThe description queue never holds an index page');
await checkAsync('a listing harvested off an index is not queued, so it cannot be dropped for it', async () => {
  const { descriptionQueue } = await import('./run.mjs');
  descriptionQueue.clear();
  resetReport();

  /* One page, two Events, no descriptions on either — the shape of a venue's
     "what's on" index. Bad Dog's "Super Hot Date Night" arrived exactly this
     way, kept baddogtheatre.com/whats-on as its url, and the model was asked
     what one of twenty shows on it was. */
  const ld = (x) => `<script type="application/ld+json">${JSON.stringify(x)}</script>`;
  const two = [1, 2].map((i) => ({
    '@type': 'Event', name: `Show ${i}`, startDate: `2026-10-0${i}T20:00:00-04:00`,
    location: { '@type': 'Place', name: 'Bad Dog', address: { '@type': 'PostalAddress', streetAddress: '875 Bloor St W', addressLocality: 'Toronto' } },
  }));
  const indexHtml = two.map(ld).join('');
  const indexUrl = 'https://baddogtheatre.com/whats-on';
  /* Real body text, so the index is skipped for being an index and not
     merely for having nothing readable on it. */
  const body0 = '<body><p>Every show at Bad Dog Theatre this season, with dates and times for each.</p></body>';

  /* A source that publishes from its index (not listingOnly), the way Bad Dog
     does, so harvest does not skip the page outright. */
  const baddog = { ...eventbrite, id: 'baddog-test', listingOnly: false, noModel: true, vet: null, skipBeforeFollow: null };

  await harvest(baddog, [{ url: indexUrl, html: indexHtml + body0, isIndex: true }], { today });
  assert.equal(descriptionQueue.size, 0, 'an index page was queued for a description');

  /* The same markup as the event's own page IS queued. */
  descriptionQueue.clear();
  /* With a body, because queueForDescription will not ask about a page that
     has no readable text — readableText strips <script>, so a fixture that
     is only a JSON-LD block has nothing to send and is correctly skipped. */
  const body = '<body><p>Two teams improvise a full set from a single audience suggestion, with a different guest each week.</p></body>';
  await harvest(baddog, [{ url: 'https://baddogtheatre.com/whats-on/2026/10/1/show-1', html: ld(two[0]) + body, isIndex: false }], { today });
  assert.equal(descriptionQueue.size, 1);
  assert.equal([...descriptionQueue.values()][0].own, true, 'an event page should be queued as own');
  descriptionQueue.clear();
});

console.log('\nExtra listing pages');
await checkAsync('an alsoIndex page is pooled for links and never harvested as an event', async () => {
  const site = synthetic(4);
  /* A second listing page naming two events of its own, one of which the
     first page also names. */
  const ld = (x) => `<script type="application/ld+json">${JSON.stringify(x)}</script>`;
  const extraUrl = indexUrls(eventbrite)[1];
  assert.ok(extraUrl, 'eventbrite should carry at least one alsoIndex');
  const own = [site.events[0], {
    '@type': 'Event', name: 'Only On The Second Page', startDate: '2026-10-20T20:00:00-04:00',
    url: 'https://www.eventbrite.ca/e/only-on-the-second-page-tickets-2000009999',
    location: { '@type': 'Place', name: 'Club', address: { '@type': 'PostalAddress', streetAddress: '9 Queen St W', addressLocality: 'Toronto' } },
    offers: [{ '@type': 'AggregateOffer', lowPrice: '0', highPrice: '0', priceCurrency: 'CAD' }],
  }];
  site.pageFor.set(own[1].url, ld(own[1]));
  const second = ld({ '@type': 'ItemList', itemListElement: own.map((e, i) => ({ '@type': 'ListItem', position: i + 1, item: { ...e, offers: undefined } })) });

  const tried = [];
  let current = '';
  const indexes = indexUrls(eventbrite);
  const browser = { newContext: async () => ({
    newPage: async () => ({
      goto: async (u) => {
        current = u;
        if (u.endsWith('/robots.txt') || indexes.includes(u)) return { ok: () => true, status: () => 200 };
        tried.push(u);
        return { ok: () => site.pageFor.has(u), status: () => (site.pageFor.has(u) ? 200 : 404) };
      },
      content: async () => (current.endsWith('/robots.txt') ? 'User-agent: *\nAllow: /\n'
        : current === eventbrite.url ? site.listing
        : current === extraUrl ? second
        : site.pageFor.get(current)),
    }),
    close: async () => {},
  }) };

  resetReport();
  const pages = await livePages(eventbrite, browser);

  /* The second page's own event is followed; the one it shares with the
     first is read once, not twice. */
  assert.ok(tried.includes(own[1].url), 'the event only the second page names was not followed');
  assert.equal(new Set(tried).size, tried.length, 'an event shared by both pages was fetched twice');
  assert.equal(tried.length, 5, `followed ${tried.length}, expected 4 + 1`);

  /* Both listing pages are marked as listings, so neither is harvested. */
  const indexPages = pages.filter((p) => p.isIndex).map((p) => p.url);
  assert.deepEqual(indexPages.sort(), [eventbrite.url, extraUrl].sort());
  const harvested = await harvest(eventbrite, pages, { today });
  assert.ok(!harvested.some((e) => /Community Walk/.test(e.title) && e.entry === undefined),
    'an index ItemList was harvested as events');
});

console.log('\nFollow failures: the breaker, the count, and a failed source');
await checkAsync(`${FOLLOW_BREAKER} failed follows in a row stop the source following`, async () => {
  const site = synthetic(12);
  const { browser, tried } = fakeBrowser(site, () => true);
  resetReport();
  const pages = await livePages(eventbrite, browser);
  assert.equal(tried.length, FOLLOW_BREAKER, `fetched ${tried.length} event pages into a failing site`);
  assert.equal(pages.followFailures, FOLLOW_BREAKER);
  assert.equal(pages.followAbandoned, 12 - FOLLOW_BREAKER);
  assert.equal(report.followFailures.eventbrite, FOLLOW_BREAKER);
  assert.ok(report.errors.some((e) => /stopped following after 3 failed event pages in a row; 9 left unread/.test(e)));
  assert.equal(report.dropped.filter((d) => /not fetched: stopped after 3 failed/.test(d)).length, 9, 'every link left is accounted for');
  assert.equal(followVerdict(pages).failed, true);
});
await checkAsync('failures that never come three in a row do not trip it', async () => {
  const site = synthetic(12);
  const { browser, tried } = fakeBrowser(site, (i) => i % 3 !== 2);   /* fail, fail, read, … */
  resetReport();
  const pages = await livePages(eventbrite, browser);
  assert.equal(tried.length, 12);
  assert.equal(pages.followFailures, 8);
  assert.equal(pages.followAbandoned, 0);
});
check('more than a third unread is a failed source; a third exactly is not', () => {
  assert.equal(followVerdict({ followed: 12, followFailures: 4 }).failed, false);
  assert.equal(followVerdict({ followed: 12, followFailures: 5 }).failed, true);
  assert.equal(followVerdict({ followed: 12, followFailures: 3, followAbandoned: 9 }).failed, true);
  assert.equal(followVerdict({ followed: 0, followFailures: 0 }).failed, false);
  assert.match(followVerdict({ followed: 12, followFailures: 5 }).why, /5 of 12 event pages unread/);
});
const previousRun = [
  { id: 'eventbrite-kept-a', title: 'Kept A', scrapedFrom: 'eventbrite', schedule: { kind: 'day', date: '2026-10-20' } },
  { id: 'eventbrite-kept-b', title: 'Kept B', scrapedFrom: 'eventbrite', schedule: { kind: 'range', start: '2026-09-20', end: '2026-10-02' } },
  { id: 'eventbrite-past', title: 'Past', scrapedFrom: 'eventbrite', schedule: { kind: 'day', date: '2026-09-01' } },
  { id: 'luma-other', title: 'Other source', scrapedFrom: 'luma', schedule: { kind: 'day', date: '2026-10-20' } },
];
check('a failed source carries forward its own listings that have not finished', () =>
  assert.deepEqual(carryForward(previousRun, 'eventbrite', today).map((e) => e.id), ['eventbrite-kept-a', 'eventbrite-kept-b']));
await checkAsync('a poll where more than a third of follows fail keeps the last run’s listings, not a partial set', async () => {
  const site = synthetic(15);
  const { browser } = fakeBrowser(site, (i) => i % 3 !== 2);   /* 10 of 15 fail, never 3 in a row */
  resetReport();
  const found = await pollSource(eventbrite, { browser, previous: previousRun, today });
  assert.deepEqual(found.map((e) => e.id), ['eventbrite-kept-a', 'eventbrite-kept-b']);
  assert.ok(report.errors.some((e) => /eventbrite — failed: 10 of 15 event pages unread .*Kept its 2 listings from the last run/.test(e)), report.errors.join('\n'));
  assert.ok(report.coverage.some((c) => /15 to read, 10 failed, 2 carried over from the last run/.test(c)), report.coverage.join('\n'));
  assert.equal(report.followFailures.eventbrite, 10);
});
await checkAsync('with no last run to fall back on, a failed source publishes nothing rather than a part', async () => {
  const site = synthetic(15);
  const { browser } = fakeBrowser(site, (i) => i % 3 !== 2);
  resetReport();
  assert.deepEqual(await pollSource(eventbrite, { browser, previous: null, today }), []);
});
await checkAsync('one failed follow of fifteen is a page lost, and the rest are published', async () => {
  const site = synthetic(15);
  const { browser } = fakeBrowser(site, (i) => i === 4);
  resetReport();
  const found = await pollSource(eventbrite, { browser, previous: previousRun, today });
  assert.equal(found.length, 14);
  assert.ok(found.every((e) => e.title.startsWith('Community Walk')));
  assert.ok(report.coverage.some((c) => /15 to read, 1 failed, 14 kept/.test(c)), report.coverage.join('\n'));
});

console.log('\nAlready hand-listed in data.js');
const REHEAT = 'https://www.eventbrite.com/e/the-reheat-podcast-live-tickets-1997921693568';
check('data.js does carry The Reheat Podcast on Eventbrite, by hand', () => {
  const data = readFileSync(path.join(root, 'data.js'), 'utf8');
  assert.ok(data.includes(REHEAT));
  assert.ok(handListedIndex(data).ids.has('1997921693568'));
});
check('its url, or its event number under another host or with a tracking query, is skipped', () => {
  assert.match(alreadyHandListed(REHEAT), /already hand-listed/);
  assert.match(alreadyHandListed('https://www.eventbrite.ca/e/the-reheat-podcast-live-tickets-1997921693568?aff=ebdssbdestsearch'), /already hand-listed/);
  assert.match(alreadyHandListed('https://www.eventbrite.ca/e/reheat-renamed-tickets-1997921693568'), /already hand-listed/);
  assert.equal(alreadyHandListed('https://www.eventbrite.ca/e/the-walrus-talks-community-reborn-tickets-1998915982513'), null);
  assert.equal(eventbriteId(REHEAT), '1997921693568');
});
check('on the event page, it is dropped with the reason', () => {
  const r = normalize({ ...page('walrus-talks'), url: REHEAT }, eventbrite, opts);
  assert.equal(r.ok, false);
  assert.match(r.why, /already hand-listed in data\.js/);
});
await checkAsync('from the listing, it is dropped and never fetched', async () => {
  const site = synthetic(3);
  const reheat = { ...site.events[0], name: 'The Reheat Podcast LIVE', url: REHEAT };
  const listing = `<script type="application/ld+json">${JSON.stringify({ '@type': 'ItemList', itemListElement: [...site.events, reheat].map((item, i) => ({ '@type': 'ListItem', position: i + 1, item })) })}</script>`;
  const { browser, tried } = fakeBrowser({ listing, pageFor: site.pageFor });
  resetReport();
  const pages = await livePages(eventbrite, browser);
  assert.ok(!tried.some((u) => u.includes('1997921693568')), 'the hand-listed event page was fetched');
  assert.ok(report.dropped.some((d) => /^eventbrite: The Reheat Podcast LIVE — already hand-listed in data\.js .*\(not fetched\)$/.test(d)), report.dropped.join('\n'));
  assert.equal(pages.followed, 3);
});

console.log('\nThe follow delay');
check('non-numeric values are ignored, and a real poll never goes under a second', () => {
  assert.equal(followDelayMs({}), 1500);
  assert.equal(followDelayMs({ FOLLOW_DELAY_MS: 'fast' }), 1500);
  assert.equal(followDelayMs({ FOLLOW_DELAY_MS: '' }), 1500);
  assert.equal(followDelayMs({ FOLLOW_DELAY_MS: '-5' }), 1500);
  assert.equal(followDelayMs({ FOLLOW_DELAY_MS: '0' }), MIN_FOLLOW_DELAY_MS);
  assert.equal(followDelayMs({ FOLLOW_DELAY_MS: '200' }), 1000);
  assert.equal(followDelayMs({ FOLLOW_DELAY_MS: '2500' }), 2500);
});
check('only the suite may go lower', () => {
  assert.equal(followDelayMs({ FOLLOW_DELAY_MS: '0', EXPLORA_TEST: '1' }), 0);
  assert.equal(followDelayMs({ FOLLOW_DELAY_MS: 'nope', EXPLORA_TEST: '1' }), 1500);
});

console.log('\nGoing quiet');
check('a real poll does not stop over Eventbrite going quiet — the guard itself, run', () => {
  const sources = enabledSources();
  const lumaNow = Array.from({ length: 5 }, () => ({ scrapedFrom: 'luma' }));
  const before = new Map([['eventbrite', 12], ['luma', 5]]);
  const r = quietSources(before, lumaNow, sources, '');
  assert.deepEqual(r.silent, [], `stopped over ${JSON.stringify(r.silent)}`);
  assert.deepEqual(r.shrunk, []);
  /* The control: the same guard, on a source that has not said it may go
     quiet, does stop the run — so the pass above is the exemption working. */
  const ebNow = Array.from({ length: 12 }, () => ({ scrapedFrom: 'eventbrite' }));
  assert.deepEqual(quietSources(before, ebNow, sources, '').silent.map((x) => x.id), ['luma']);
  assert.deepEqual(quietSources(before, ebNow, sources, 'luma').silent, []);
});
check('and main() runs its guard through that function', () => {
  const src = readFileSync(path.join(here, 'run.mjs'), 'utf8');
  const main = src.slice(src.indexOf('async function main()'));
  assert.match(main, /quietSources\(countBySource\(previous\), events, enabledSources\(\), process\.env\.ALLOW_SILENT_SOURCES\)/);
});

console.log(failures ? `\n${failures} failing\n` : '\nall passing\n');
process.exitCode = failures ? 1 : 0;
