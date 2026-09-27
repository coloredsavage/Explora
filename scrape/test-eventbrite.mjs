#!/usr/bin/env node
/* Eventbrite: offline checks over trimmed copies of real event pages
 * (scrape/fixtures/eventbrite.*), fetched 2026-09-27. No network. */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fromJsonLd } from './extract.mjs';
import { normalize, validate } from './normalize.mjs';
import { SOURCES } from './sources.mjs';
import { matchArt } from './art-match.mjs';
import { classifyEventbriteEvent, eventbritePrice, formatPrice, vetEventbrite,
  CLASSIFIER_OUTPUTS, PROFESSIONAL_TITLE } from './eventbrite.mjs';

process.env.FOLLOW_DELAY_MS = '0';
const { harvest, livePages, report } = await import('./run.mjs');
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
  assert.deepEqual(eventbritePrice([{ '@type': 'Offer', price: 0 }, { '@type': 'Offer', price: '20.00' }, { '@type': 'Offer', price: 50 }]), { entry: '$20' }));
check('nested offers are read too', () =>
  assert.deepEqual(eventbritePrice({ '@type': 'AggregateOffer', lowPrice: 0, highPrice: 30, offers: [{ price: 0 }, { price: 15 }, { price: 30 }] }), { entry: '$15' }));
check('no offers, or no numbers in them, is no price', () => {
  assert.match(eventbritePrice(null).why, /no offers/);
  assert.match(eventbritePrice([{ '@type': 'Offer', availability: 'InStock' }]).why, /no readable price/);
});
check('a price in another currency is not passed off as dollars here', () =>
  assert.match(eventbritePrice([{ lowPrice: '5', highPrice: '9', priceCurrency: 'USD' }]).why, /USD/));
check('never "$0" in any combination', () => {
  const vals = [0, '0', '0.0', '0.00', 0.001, 5, '19.5', 40];
  for (const a of vals) for (const b of vals) {
    const r = eventbritePrice([{ lowPrice: a, highPrice: b, priceCurrency: 'CAD' }, { price: a }]);
    if (r.entry) assert.doesNotMatch(r.entry, /^\$0(\.0+)?$/, JSON.stringify([a, b, r]));
  }
});
check('written the way the board writes prices', () => {
  assert.equal(formatPrice(12), '$12');
  assert.equal(formatPrice(19.5), '$19.50');
  assert.equal(formatPrice(27.96), '$27.96');
  assert.equal(eventbritePrice([{ lowPrice: '12.0', highPrice: '12.0' }]).entry, '$12');
});
check('and price.js buckets what it writes', () => {
  assert.equal(priceOf('Free'), 'free');
  assert.equal(priceOf('$12.19'), 'under20');
  assert.equal(priceOf('$19.50'), 'under20');
  assert.equal(priceOf('$27.96'), 'over20');
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
check('summits, expos, symposiums and networking in titles', () => {
  for (const t of ['The Small Business Summit 2026', 'Young Professionals Leadership Summit 2026',
    '16th African Economic Summit (Friends of Africa-2026)', 'Global Data Centre & Cloud Expo Canada',
    'International Can-Africa Business Leaders Conference - 2026', 'Annual Keynote Breakfast',
    'Professional Development Day for Teachers', 'Founders Networking Night', 'Two Symposia on Care']) {
    const r = normalize({ ...page('walrus-talks'), title: t }, eventbrite, opts);
    assert.equal(r.ok, false, t);
    assert.match(r.why, /business|conference|professional/, t);
  }
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
  const revival = SOURCES.find((s) => s.id === 'revival');
  assert.equal(e.category, revival.category);
  assert.equal(e.art, matchArt({ title: 'Afrobeats & Friends | Amapiano | R&B | Dancehall' }));
  assert.equal(e.art, 'art-decks');
});
check('so does a dancehall party', () => {
  const c = classifyEventbriteEvent(page('whine-slow'));
  assert.deepEqual([c.category, c.art], ['music', 'art-decks']);
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
await checkAsync('the listing page itself publishes nothing', async () => {
  const out = await harvest(eventbrite, [{ url: eventbrite.url, html: fixture('eventbrite.html'), isIndex: true }]);
  assert.equal(out.length, 0);
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
  report.dropped.length = 0; report.errors.length = 0;
  const pages = await livePages(eventbrite, browser);
  const out = await harvest(eventbrite, pages);
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
check('a real poll does not stop over Eventbrite going quiet', () =>
  assert.equal(eventbrite.mayGoQuiet, true));

console.log(failures ? `\n${failures} failing\n` : '\nall passing\n');
process.exitCode = failures ? 1 : 0;
