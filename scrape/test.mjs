#!/usr/bin/env node
/* Offline checks over the fixtures. No network, no API key, no browser. */

import { readFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fromJsonLd, readableText, candidateLinks, metaDescription, readsAsDescription } from './extract.mjs';
import { shrunkSources } from './normalize.mjs';
import { normalize, validate, stripSiteSuffix, disambiguateIds, collapseSubsumed, silentSources } from './normalize.mjs';
import { SOURCES } from './sources.mjs';
import { matchArt, FAMILIES } from './art-match.mjs';
import { allowedBy, PRODUCT_TOKEN } from './robots.mjs';
import { fromTribe, priceFrom, splitPlace } from './api.mjs';
import { bestMatch, acceptable, patchEntry, loadSite, restingIds, DURABLE_REFUSAL } from './recheck.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFile(path.join(here, 'fixtures', n), 'utf8');
const wygo = SOURCES.find((s) => s.id === 'wygo');
const realSrc = await readFile(path.join(here, '..', 'data.js'), 'utf8');
const priceSrc = await readFile(path.join(here, '..', 'price.js'), 'utf8');

let failures = 0;
const pass = (name) => console.log('  ok   ' + name);
const fail = (name, err) => { failures++; console.log('  FAIL ' + name + '\n       ' + err.message); };

/* An async fn handed to this returns a promise rather than throwing, so a
   failed assertion inside one used to sail past the catch and print "ok".
   Fifteen robots tests passed that way, including one asserting that false
   equalled the string "DELIBERATELY WRONG". Refuse the promise instead of
   swallowing it; checkAsync is the one that awaits. */
const check = (name, fn) => {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      throw new Error('async check passed to check() — use checkAsync()');
    }
    pass(name);
  } catch (err) { fail(name, err); }
};

const checkAsync = async (name, fn) => {
  try { await fn(); pass(name); }
  catch (err) { fail(name, err); }
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
  assert.deepEqual(kept[0].schedule, { kind: 'day', date: '2026-09-20', time: '1pm' }));
/* The time comes off startDate now. A start with no end is still worth
   showing: "Sep 20 · 1pm" beats a bare date, which is what Luma's listings
   were getting while the Rex had its times all along. */
check('a start with no end still gives the card a time', () =>
  assert.equal(kept[0].schedule.time, '1pm'));
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
check('cuts a long description at a sentence boundary, and says nothing about it', () => {
  const long = 'One sentence here. ' + 'Another sentence that runs on. '.repeat(20);
  const d = tidy({ venue: 'V', address: '1 King St W, Toronto, ON', description: long }).description;
  assert.ok(d.length <= 225, `got ${d.length}`);
  assert.ok(d.length < long.length, 'it should have been shortened');
  /* It stopped on a full stop, so it reads as a finished thought and does not
     need an ellipsis announcing that more exists. */
  assert.match(d, /\.$/);
  assert.doesNotMatch(d, /…$/);
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
  "    art: 'art-lights',",
  '  },',
  '  {',
  "    id: 'has-none',",
  "    title: 'Another thing',",
  "    category: 'dropin',",
  "    art: 'art-lights',",
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
  assert.match(out, /id: 'has-none',\n    title: 'Another thing',\n    category: 'dropin',\n    art: 'art-lights',\n  },/);
});
check('inserts a missing price after category', () => {
  const out = patchEntry(sample, 'has-none', 'Free');
  assert.match(out, /category: 'dropin',\n    entry: 'Free',\n    art: 'art-lights',/);
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

console.log('\nA page that describes itself');
{
  const og = '<html><head><meta property="og:description" content="The Audition dives into the chaotic world of trying to book the job, completely improvised.">' +
             '<title>x</title></head><body>nav nav nav</body></html>';
  check('takes the og:description a page writes for sharing', () =>
    assert.match(metaDescription(og), /^The Audition dives into/));
  check('decodes the entities a CMS leaves in it', () =>
    assert.equal(
      metaDescription('<meta property="og:description" content="Bita &amp;amp; Nicole present a show that is more than forty characters long">'),
      'Bita & Nicole present a show that is more than forty characters long'));
  check('falls back to the plain meta description', () =>
    assert.match(
      metaDescription('<meta name="description" content="An improvised look at auditions, at Comedy Bar Bloor every Friday.">'),
      /improvised look/));
  check('a stub is worse than nothing', () =>
    assert.equal(metaDescription('<meta property="og:description" content="Bad Dog">'), null));
  check('a page with none says so', () =>
    assert.equal(metaDescription('<html><head><title>x</title></head></html>'), null));
  check('a credit block still reaches the model, which can read past it', () =>
    assert.match(
      metaDescription('<meta property="og:description" content="A Bad Dog Theatre Company Production Created by: Bita Joudaki Producers: Stephanie Malek Dates: Fridays in September Time: 7pm Location: Comedy Bar Bloor">'),
      /^A Bad Dog Theatre/));
}

console.log('\nFit to print as it stands');
{
  check('a credit block is not a description', () =>
    assert.equal(readsAsDescription('A Bad Dog Theatre Company Production Created by: Bita Joudaki Producers: Stephanie Malek Dates: Fridays in September Time: 7pm Location: Comedy Bar Bloor'), false));
  check('one stray label does not sink a real one', () =>
    assert.equal(readsAsDescription('An improvised show about auditions, different every night. Location: Comedy Bar Bloor.'), true));
  check('plain prose passes', () =>
    assert.equal(readsAsDescription('Performers work through cold reads and callbacks, improvised and different every night.'), true));
  check('a logistics block in emoji is not a description either', () =>
    assert.equal(readsAsDescription('designwalks™ Walk 11: 📍 Trinity Bellwoods Park (We’ll be meeting at Strachan Ave & Queen St W.) 🕒 3:00-5:00p.m., Saturday'), false));
  check('one pin does not sink a real description', () =>
    assert.equal(readsAsDescription('📍 A walk through the ravine looking at how the city drains, led by a hydrologist.'), true));
  check('a poster that shouts is not a description', () =>
    assert.equal(readsAsDescription('BAD DOG THEATRE PRESENTS SWEET SWEET FRIENDS Tonight, a delectable selection of RISING STARS take the stage.'), false));
  check('acronyms are not shouting', () =>
    assert.equal(readsAsDescription('TIFF and the AGO both run free nights; the ROM charges but is worth it.'), true));
  check('naming a meeting point is allowed once', () =>
    assert.equal(readsAsDescription('A guided walk through Trinity Bellwoods looking at how the park was built; meet at the gates.'), true));
  check('nothing is not a description', () =>
    assert.equal(readsAsDescription(null), false));
}

console.log('\nA title with the site bolted on');
{
  const src = { id: 'baddog', name: 'Bad Dog Theatre', category: 'comedy', art: 'art-comedy',
                url: 'https://baddogtheatre.com/whats-on' };
  const base = { startDate: '2026-09-11', venue: 'Comedy Bar Bloor',
                 address: '945 Bloor St W, Toronto, ON', description: 'x'.repeat(60) };
  const when = { today: '2026-09-11', checked: '2026-09-11' };
  const titleOf = (t) => normalize({ ...base, title: t }, src, when).event.title;

  check('drops a tail that names the source', () =>
    assert.equal(titleOf("The Audition — Bad Dog Theatre Company - Toronto's Best Improv"), 'The Audition'));
  check('keeps a dash the title actually wanted', () =>
    assert.equal(titleOf('Dungeons & Dragons — Live!'), 'Dungeons & Dragons — Live!'));
  check('keeps a title with no tail at all', () =>
    assert.equal(titleOf('Maestro'), 'Maestro'));
}

console.log('\nWhat a library runs that is not a day out');
{
  const tpl = SOURCES.find((x) => x.id === 'tpl');
  const drops = ['Microsoft Application Series', 'Computer Basics for Beginners',
                 'Job Search Club', 'Free Tax Clinic', 'ESL Conversation Circle', 'Resume Workshop'];
  const keeps = ['Randy Boyagoda: Lords of Serendipity', 'Draw Joy from a Pencil',
                 'Friday Night Film: Chinatown', 'Teen Craft Afternoon', 'Silent Book Club'];
  for (const t of drops) check(`drops "${t}"`, () => assert.ok(tpl.exclude.test(t)));
  for (const t of keeps) check(`keeps "${t}"`, () => assert.ok(!tpl.exclude.test(t)));
  check('drops "Wellness Recovery Action Plan (WRAP)"', () =>
    assert.ok(tpl.exclude.test('Wellness Recovery Action Plan (WRAP)')));
  check('drops "Caregiver Support Group"', () =>
    assert.ok(tpl.exclude.test('Caregiver Support Group')));
  check('keeps "Gift Wrapping Workshop" — wrap is a word', () =>
    assert.ok(!tpl.exclude.test('Gift Wrapping Workshop')));
}

console.log('\nPast what the calendar is for');
{
  const src = { id: 'luma', name: 'Luma', category: 'social', art: 'art-lectern', url: 'x', defaultAddress: null };
  const when = { today: '2026-09-11', checked: '2026-09-11' };
  const ok = (entry) => normalize({ title: 'A thing', startDate: '2026-09-20', venue: 'A Hall',
    address: '1 King St W, Toronto, ON', description: 'x'.repeat(60), entry }, src, when).ok;

  check('a $50 workshop does not belong on it', () => assert.equal(ok('$50'), false));
  check('nor does $41.94', () => assert.equal(ok('$41.94'), false));
  check('nor does $36', () => assert.equal(ok('$36'), false));
  check('$35 is the line and stays', () => assert.equal(ok('$35'), true));
  check('$30 is comfortably under it', () => assert.equal(ok('$30'), true));
  check('free is free whatever else the line says', () =>
    assert.equal(ok('Free; the thematic tours are $50'), true));
  check('pay what you can is never too dear', () => assert.equal(ok('Pay what you can'), true));
  check('the first figure is the door price, not the largest', () =>
    assert.equal(ok('$22, plus $5 and up to fire a piece'), true));
  check('no price is not a dear price', () => assert.equal(ok(null), true));
}

console.log('\nAnnouncements that nothing is on');
{
  const src = { id: 'bentway', name: 'The Bentway', category: 'architecture', art: 'art-skates',
                url: 'x', defaultAddress: '250 Fort York Blvd, Toronto, ON M5V 3K9' };
  const when = { today: '2026-09-11', checked: '2026-09-11' };
  const ok = (title) => normalize({ title, startDate: '2026-09-20', venue: 'The Bentway',
    address: '250 Fort York Blvd', description: 'x'.repeat(60) }, src, when).ok;

  for (const t of ['Skate Trail Closed', 'Event Cancelled', 'Public Trust — Postponed'])
    check(`drops "${t}"`, () => assert.equal(ok(t), false));
  for (const t of ['Closing Party for Public Trust', 'Closing Night at the Bentway'])
    check(`keeps "${t}"`, () => assert.equal(ok(t), true));
}

console.log('\nAn ellipsis that means something');
{
  const src = { id: 'x', name: 'X', category: 'dropin', art: 'art-dropin', url: 'x', defaultAddress: null };
  const when = { today: '2026-09-11', checked: '2026-09-11' };
  const desc = (d) => normalize({ title: 'T', startDate: '2026-09-20', venue: 'V',
    address: '1 King St W, Toronto, ON', description: d }, src, when).event.description;

  check('a description that ends on a full stop does not wear an ellipsis', () => {
    const whole = 'A guided walk through the ravine at the Brick Works, with sensory activities for families. '
      + 'Registration is required and it runs rain or shine. Bring boots you do not mind wetting.';
    assert.doesNotMatch(desc(whole), /…$/);
  });
  check('one that is genuinely cut off still says so', () =>
    assert.match(desc('A '.padEnd(320, 'long ') + 'sentence that never stops'), /…$/));
  check('a short description is left exactly alone', () =>
    assert.equal(desc('A quiet reading room, open to anyone.'), 'A quiet reading room, open to anyone.'));
}

console.log('\nEntities that arrived half-eaten');
{
  const src = { id: 'tpl', name: 'Toronto Public Library', category: 'dropin', art: 'art-books',
                url: 'x', defaultAddress: null };
  const when = { today: '2026-09-11', checked: '2026-09-11' };
  const desc = (d) => normalize({ title: 'A talk', startDate: '2026-09-18',
    venue: 'Toronto Reference Library', address: '789 Yonge St, Toronto, ON M4W 2G8',
    description: d }, src, when).event.description;

  check('a stripped &nbsp; does not become a typo', () =>
    assert.equal(desc('Word and PowerPointnbsp;classes.nbsp;'), 'Word and PowerPoint classes.'));
  check('an ampersand survives as itself', () =>
    assert.match(desc('Dungeons &amp; Dragons, every Tuesday at the library.'), /Dungeons & Dragons/));
}

console.log('\nMatching the two names one page gives an event');
{
  const name = 'Bad Dog Theatre';
  const norm = (x) => stripSiteSuffix(String(x ?? '').trim(), name)
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  check('the structured name and the written one meet in the middle', () =>
    assert.equal(
      norm("The Audition  — Bad Dog Theatre Company - Toronto's Best Improv"),
      norm('The Audition')));
  check('two different shows still do not match', () =>
    assert.notEqual(norm('The Audition'), norm('Super Hot Date Night')));
}

console.log('\nAn address with the city left off');
{
  const when = { today: '2026-09-11', checked: '2026-09-11' };
  const base = { title: 'Public Trust', startDate: '2026-09-15', description: 'x'.repeat(60) };
  const bentway = { id: 'bentway', name: 'The Bentway', category: 'architecture', art: 'art-skates',
                    url: 'https://thebentway.ca/whats-on',
                    defaultAddress: '250 Fort York Blvd, Toronto, ON M5V 3K9' };
  const wygo = { id: 'wygo', name: 'Wygo', category: 'dropin', art: 'art-lights',
                 url: 'https://wygo.world/o/wygo', defaultAddress: null };
  const run = (src, venue, address) => normalize({ ...base, venue, address }, src, when);

  check('a Toronto source lends its city to a bare address', () => {
    const r = run(bentway, 'The Bentway', '250 Fort York Blvd');
    assert.ok(r.ok); assert.equal(r.event.address, '250 Fort York Blvd, Toronto, ON');
  });
  check('it does not lend its postal code as well', () =>
    assert.doesNotMatch(run(bentway, 'Harbourfront Centre', '235 Queens Quay W').event.address, /M5V 3K9/));
  check('a source that ranges wider cannot repair anything', () =>
    assert.equal(run(wygo, 'Some Hall', '12 King St').ok, false));
  check('and an address that names another city is still refused', () =>
    assert.equal(run(wygo, 'Some Hall', '12 King St, Waterloo, ON').ok, false));
}

console.log('\nListing the same thing twice');
{
  /* the key run.mjs collapses on */
  const norm = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const key = (e) => norm(e.title) + '|' + (e.schedule.date ?? e.schedule.start ?? '') + '|' + norm(e.venue);
  const at = (title, date, venue) => ({ title, venue, schedule: { kind: 'day', date } });

  check('the same show on the same night at the same room is one listing', () =>
    assert.equal(
      key(at('The Audition', '2026-09-11', 'Comedy Bar Bloor')),
      key(at('The Audition', '2026-09-11', 'Comedy Bar Bloor'))));

  check('a weekly show keeps every week it runs', () =>
    assert.notEqual(
      key(at('The Audition', '2026-09-11', 'Comedy Bar Bloor')),
      key(at('The Audition', '2026-09-18', 'Comedy Bar Bloor'))));

  check('the same name at two places on one day is two things', () =>
    assert.notEqual(
      key(at('Leisure Swim', '2026-09-11', 'Main Square Community Recreation Centre')),
      key(at('Leisure Swim', '2026-09-11', 'Memorial Pool and Health Club'))));

  check('punctuation and case do not make a second listing', () =>
    assert.equal(
      key(at('The Audition', '2026-09-11', 'Comedy Bar Bloor')),
      key(at('the  audition!', '2026-09-11', 'COMEDY BAR — BLOOR'))));
}

console.log('\nEntities outside the description');
{
  const src = { id: 'baddog', name: 'Bad Dog Theatre', category: 'comedy', art: 'art-comedy',
                defaultVenue: null, defaultAddress: null };
  const read = (over) => normalize({
    title: 'Narrative Process &amp; Sweet Sweet Friends',
    startDate: '2026-09-23',
    venue: 'Sweet Action Theatre',
    address: '180 Shaw Street, Toronto, ON, M6J 2W5',
    ...over,
  }, src, { today: '2026-09-08', checked: '2026-09-08' });

  check('an ampersand in a title is decoded, not printed as an entity', () => {
    const r = read({});
    assert.ok(r.ok, r.why);
    assert.equal(r.event.title, 'Narrative Process & Sweet Sweet Friends');
  });

  check('and it does not ride into the id either', () => {
    const r = read({});
    assert.ok(!r.event.id.includes('amp'), r.event.id);
  });

  check('a venue carrying one is decoded too', () => {
    const r = read({ venue: 'Sweet &amp; Sour Theatre' });
    assert.ok(r.ok, r.why);
    assert.equal(r.event.venue, 'Sweet & Sour Theatre');
  });

  /* Every one of these was taken off a real listing page. */
  check('WordPress numeric entities decode, zero-padded or not', () => {
    assert.equal(read({ title: 'The Swingin&#8217; Blackjacks' }).event.title, 'The Swingin\u2019 Blackjacks');
    assert.equal(read({ title: 'Hold &#038; Release' }).event.title, 'Hold & Release');
    assert.equal(read({ title: 'Frieda&#039;s Longshots' }).event.title, "Frieda's Longshots");
    assert.equal(read({ title: 'Sat &#8211; Sun' }).event.title, 'Sat \u2013 Sun');
  });

  check('a double-encoded entity gets all the way down', () => {
    assert.equal(read({ title: 'Frieda&amp;#039;s Longshots' }).event.title, "Frieda's Longshots");
  });

  check('an entity that names nothing is left alone rather than mangled', () => {
    assert.equal(read({ title: 'Rock &widget; Roll' }).event.title, 'Rock &widget; Roll');
  });

  check('a control codepoint is refused, not printed', () => {
    assert.equal(read({ title: 'Jazz &#7; Night' }).event.title, 'Jazz &#7; Night');
  });

  check('a half-eaten nbsp does not weld two words together', () => {
    const r = read({ title: 'Sketchnbsp;Party' });
    assert.ok(r.ok, r.why);
    assert.equal(r.event.title, 'Sketch Party');
  });
}

console.log('\nOne id per listing');
{
  const at = (venue) => ({ id: 'bentway-public-trust-2026-09-15', title: 'Public Trust', venue });

  check('listings the dedupe kept apart do not share an id', () => {
    const events = [
      at('The Bentway'),
      at('Toronto Public Library, Fort York branch'),
      at('Harbourfront Centre'),
    ];
    disambiguateIds(events);
    assert.equal(new Set(events.map((e) => e.id)).size, 3);
  });

  check('the venue is what tells them apart', () => {
    const events = [at('The Bentway'), at('Harbourfront Centre')];
    disambiguateIds(events);
    assert.equal(events[0].id, 'bentway-public-trust-2026-09-15-the-bentway');
    assert.equal(events[1].id, 'bentway-public-trust-2026-09-15-harbourfront-centre');
  });

  check('an id that collides with nothing is left where it was', () => {
    const events = [at('The Bentway'), { id: 'bentway-roller-skate-lessons-2026-09-11', title: 'Roller Skate Lessons', venue: 'The Bentway' }];
    disambiguateIds(events);
    assert.equal(events[0].id, 'bentway-public-trust-2026-09-15');
    assert.equal(events[1].id, 'bentway-roller-skate-lessons-2026-09-11');
  });

  check('two venues that slug the same still get an id each', () => {
    const long = 'Toronto Public Library Fort York Branch Community Room ';
    const events = [at(long + 'One'), at(long + 'Two')];
    disambiguateIds(events);
    assert.equal(new Set(events.map((e) => e.id)).size, 2);
  });

  check('it reports which ids were shared', () => {
    const events = [at('The Bentway'), at('Harbourfront Centre')];
    const out = disambiguateIds(events);
    assert.deepEqual(out.shared, ['bentway-public-trust-2026-09-15']);
    assert.equal(out.changed, 2);
  });
}

console.log('\nA source that only says the city until you RSVP');
{
  const when = { today: '2026-09-11', checked: '2026-09-11' };
  const base = { startDate: '2026-09-20', description: 'x'.repeat(60), entry: 'Free' };
  const rsvp  = { id: 'luma', name: 'Luma', category: 'social', art: 'art-social', url: 'x',
                  defaultVenue: null, defaultAddress: null, placeOnRsvp: true };
  const plain = { ...rsvp, id: 'other', placeOnRsvp: false };
  const read = (src, over) => normalize({ ...base, title: 'A Thing', ...over }, src, when);

  check('a city-only venue is published as the city, not dropped', () => {
    const r = read(rsvp, { venue: 'Toronto, ON', address: 'Toronto, ON' });
    assert.equal(r.ok, true);
    assert.match(r.event.venue, /RSVP/);
  });
  check('no place at all is still published for such a source', () =>
    assert.equal(read(rsvp, { venue: null, address: null }).ok, true));
  check('a real venue is left exactly as it is', () =>
    assert.equal(read(rsvp, { venue: 'Creeds Coffee Bar',
      address: 'Creeds Coffee Bar, Toronto, Ontario' }).event.venue, 'Creeds Coffee Bar'));

  /* The opt-in is the whole safety of this: everywhere else a missing venue
     is a page the extractor failed to read, and publishing "Toronto" would
     invent a fact rather than report one. */
  check('a source that has not opted in still drops a city-only venue', () =>
    assert.equal(read(plain, { venue: 'Toronto, ON', address: 'Toronto, ON' }).ok, false));
  check('a source that has not opted in still drops a missing venue', () =>
    assert.equal(read(plain, { venue: null, address: null }).ok, false));
}

console.log('\nA listing page that marks its whole calendar up as one ItemList');
{
  const page = (body) => `<script type="application/ld+json">${JSON.stringify(body)}</script>`;
  const event = (name, url) => ({ '@type': 'Event', name, url, startDate: '2026-09-27T10:00:00-04:00',
    location: { '@type': 'Place', name: 'A Hall', address: { addressLocality: 'Toronto' } } });

  /* Luma's city page is twenty events inside one ItemList. Reading only the
     top level found none of them, and the source limped on whichever links
     happened to be in the rendered DOM — three, on a page describing twenty. */
  check('an ItemList of events is read as its events', () => {
    const html = page({ '@type': 'ItemList', itemListElement: [
      { '@type': 'ListItem', position: 1, item: event('One', 'https://x.ca/1') },
      { '@type': 'ListItem', position: 2, item: event('Two', 'https://x.ca/2') },
    ] });
    const got = fromJsonLd(html);
    assert.equal(got.length, 2);
    assert.equal(got[1].url, 'https://x.ca/2');
  });

  check('a plain event page is untouched', () =>
    assert.equal(fromJsonLd(page(event('Alone', 'https://x.ca/a'))).length, 1));

  check('a @graph of events still works', () =>
    assert.equal(fromJsonLd(page({ '@graph': [event('A', 'https://x.ca/a'), event('B', 'https://x.ca/b')] })).length, 2));

  check('a list that inlines its events rather than nesting them is read too', () =>
    assert.equal(fromJsonLd(page({ '@type': 'ItemList',
      itemListElement: [event('A', 'https://x.ca/a'), event('B', 'https://x.ca/b')] })).length, 2));
}

console.log('\nProgramming for children, which this calendar does not carry');
{
  const src = { id: 'x', name: 'X', category: 'dropin', art: 'art-dropin', url: 'x',
                defaultVenue: null, defaultAddress: null };
  const when = { today: '2026-09-11', checked: '2026-09-11' };
  const read = (title, description) => normalize({ title, description: description || 'x'.repeat(60),
    startDate: '2026-09-20', venue: 'A Hall', address: '1 King St W, Toronto, ON' }, src, when);

  check('a program for young kids is dropped on its description alone', () =>
    assert.equal(read('Little Discoveries', 'A program for young kids; registration required. ' + 'x'.repeat(20)).ok, false));
  check("children's portraits are dropped", () =>
    assert.equal(read('Mighty Minis: Child Portrait Photos', 'x'.repeat(60)).ok, false));
  check('an age range in years is dropped', () =>
    assert.equal(read('Drop-in craft, ages 5-12', 'x'.repeat(60)).ok, false));

  /* The words are ambiguous; the phrases are not. These are the cases a rule
     written on bare keywords gets wrong. */
  check('Kids in the Hall is a comedy act, not a kids event', () =>
    assert.equal(read('Kids in the Hall', 'The legendary sketch troupe, live. ' + 'x'.repeat(30)).ok, true));
  check('Family Day is a public holiday adults attend', () =>
    assert.equal(read('Family Day at Fort York', 'Free admission for everyone. ' + 'x'.repeat(30)).ok, true));
  check('a family nature walk is a walk', () =>
    assert.equal(read('Family Wander', 'A guided hour-long walk through the ravine. ' + 'x'.repeat(30)).ok, true));
}

console.log('\nOne event a source published on several of its own pages');
{
  const deep = (e) => (e.url && e.url.replace(/\/$/, '').split('/').length > 4 ? 1 : 0);
  const better = (a, b) => (deep(a) >= deep(b) ? a : b);
  const ev = (over) => ({ scrapedFrom: 'bentway', title: 'Public Trust', venue: 'The Bentway',
    url: 'https://x.ca/event/public-trust/', source: 'https://x.ca/event/public-trust/',
    schedule: { kind: 'day', date: '2026-09-15' }, ...over });

  check('a shorter title at a venue the longer one names is the same event', () => {
    const events = [
      ev({ title: 'Public Trust', venue: 'Toronto Public Library Fort York' }),
      ev({ title: 'Public Trust — Toronto Public Library, Fort York branch',
           venue: 'Toronto Public Library Fort York', url: 'https://x.ca/event/pt-library/' }),
    ];
    collapseSubsumed(events, better);
    assert.equal(events.length, 1);
  });

  check('two venues that do not contain each other stay two listings', () => {
    const events = [ev({ venue: 'Harbourfront Centre' }), ev({ venue: 'Fort York' })];
    collapseSubsumed(events, better);
    assert.equal(events.length, 2);
  });

  /* The rule that keeps those two apart is the one that kept a talk duplicated:
     the index gave it "The Bentway" and its own page gave the library branch. */
  check('an index line folds into the event page even when the venues differ', () => {
    const events = [
      ev({ title: 'Artist Talk', venue: 'The Bentway', url: 'https://x.ca/whats-on/',
           source: 'https://x.ca/whats-on/' }),
      ev({ title: 'Artist Talk', venue: 'Toronto Public Library – Fort York',
           url: 'https://x.ca/event/artist-talk/' }),
    ];
    collapseSubsumed(events, better);
    assert.equal(events.length, 1);
    assert.match(events[0].url, /\/event\/artist-talk\//);
  });

  /* Depth cannot find an index line on a site that puts events at the root:
     luma.com/toronto and luma.com/puuz8oak are both four segments. The Salmon
     Run kept an index copy beside the real listing, and "View event" on it
     went to Luma's city page. */
  check('an index url folds even when it is no shallower than the event url', () => {
    const events = [
      ev({ title: 'Salmon Run Hike', url: 'https://luma.com/toronto', source: 'https://luma.com/toronto' }),
      ev({ title: 'Salmon Run Hike', url: 'https://luma.com/puuz8oak' }),
    ];
    collapseSubsumed(events, better, (u) => u === 'https://luma.com/toronto');
    assert.equal(events.length, 1);
    assert.equal(events[0].url, 'https://luma.com/puuz8oak');
  });

  /* Same check from the other side: with nothing told about index urls, the
     depth fallback cannot tell two root-level slugs apart, so two listings at
     different venues stay two. Venues differ here because identical title AND
     identical venue is one event by containment whatever the urls say. */
  check('without the predicate, two root-level urls stay two listings', () => {
    const events = [
      ev({ title: 'Salmon Run Hike', venue: 'Credit Valley', url: 'https://luma.com/toronto' }),
      ev({ title: 'Salmon Run Hike', venue: 'Etienne Brule Park', url: 'https://luma.com/puuz8oak' }),
    ];
    collapseSubsumed(events, better);
    assert.equal(events.length, 2);
  });

  check('two real events with their own pages are never folded on title alone', () => {
    const events = [
      ev({ title: 'Leisure Swim', venue: 'Regent Park', url: 'https://x.ca/event/swim-regent/' }),
      ev({ title: 'Leisure Swim', venue: 'Wallace Emerson', url: 'https://x.ca/event/swim-wallace/' }),
    ];
    collapseSubsumed(events, better);
    assert.equal(events.length, 2);
  });

  /* Grouping on the start date alone folded a three-week run into a one-day
     event that happened to open on the same morning. */
  check('a run and a single day are not the same event', () => {
    const events = [
      ev({ schedule: { kind: 'range', start: '2026-09-15', end: '2026-10-04' } }),
      ev({ schedule: { kind: 'day', date: '2026-09-15' } }),
    ];
    collapseSubsumed(events, better);
    assert.equal(events.length, 2);
  });
}

console.log('\nA source still answering with most of it gone');
{
  const enabled = ['luma', 'grossmans', 'tpl'];
  const run = (before, now, allowed) =>
    shrunkSources(new Map(Object.entries(before)), new Map(Object.entries(now)), enabled, allowed);

  /* The shape of both Luma breakages: it kept answering, with almost nothing. */
  check('twenty down to three is reported', () =>
    assert.equal(run({ luma: 20 }, { luma: 3 }).length, 1));
  check('a steady source is not', () =>
    assert.equal(run({ grossmans: 68 }, { grossmans: 61 }).length, 0));
  check('growth is not', () =>
    assert.equal(run({ luma: 4 }, { luma: 16 }).length, 0));

  /* Zero is silentSources' job, and it stops the run rather than logging. */
  check('nothing at all is left to the other check', () =>
    assert.equal(run({ luma: 20 }, { luma: 0 }).length, 0));

  /* Small sources swing on one listing and would cry wolf every week. */
  check('a source too small to read anything into is ignored', () =>
    assert.equal(run({ tpl: 4 }, { tpl: 1 }).length, 0));

  check('a named source is allowed to shrink', () =>
    assert.equal(run({ luma: 20 }, { luma: 2 }, new Set(['luma'])).length, 0));
}

console.log('\nA source that stopped answering');
{
  const counts = (o) => new Map(Object.entries(o));
  const enabled = ['wygo', 'luma', 'bentway', 'evergreen', 'tpl', 'comedybar', 'baddog'];
  const ids = (list) => list.map((x) => x.id).sort();

  check('the poll that hid for five days would not have been written', () => {
    /* 09-11 against what 09-13 actually came back with */
    const before = counts({ baddog: 8, bentway: 5, comedybar: 6, evergreen: 7, luma: 3, tpl: 3 });
    const now = counts({ baddog: 2, luma: 3, tpl: 1 });
    assert.deepEqual(ids(silentSources(before, now, enabled)),
      ['bentway', 'comedybar', 'evergreen']);
  });

  check('a steady run passes', () => {
    const before = counts({ baddog: 8, bentway: 5, tpl: 3 });
    const now = counts({ baddog: 7, bentway: 6, tpl: 3 });
    assert.deepEqual(silentSources(before, now, enabled), []);
  });

  check('one event going to none is noise, not a collapse', () => {
    /* The library, on the first poll after the extractor was fixed: it had
       one event, produced none, and stopped a run that kept 190. */
    const before = counts({ baddog: 8, tpl: 1 });
    const now = counts({ baddog: 8 });
    assert.deepEqual(silentSources(before, now, enabled), []);
  });

  check('but three going to none still is', () => {
    const before = counts({ baddog: 8, tpl: 3 });
    const now = counts({ baddog: 8 });
    assert.deepEqual(ids(silentSources(before, now, enabled)), ['tpl']);
  });

  check('a source that found nothing last time either is not the alarm', () => {
    const before = counts({ baddog: 8 });
    const now = counts({ baddog: 8 });
    assert.deepEqual(silentSources(before, now, enabled), []);
  });

  check('a source parked since the last run does not fail the next one', () => {
    const before = counts({ baddog: 8, blogto: 4 });
    const now = counts({ baddog: 8 });
    assert.deepEqual(silentSources(before, now, enabled), []);
  });

  check('naming a source lets a genuinely quiet one through', () => {
    const before = counts({ baddog: 8, bentway: 5 });
    const now = counts({ baddog: 8 });
    assert.deepEqual(silentSources(before, now, enabled, new Set(['bentway'])), []);
  });

  check('it says how many the source had before', () => {
    const before = counts({ bentway: 5 });
    const now = counts({});
    assert.deepEqual(silentSources(before, now, enabled), [{ id: 'bentway', had: 5 }]);
  });
}

console.log('\nRules robots.txt writes, and this used to wave through');
{
  /* allowedBy caches per origin, so each case needs a host of its own. */
  let n = 0;
  const against = (robots) => {
    const host = `https://r${n += 1}.test`;
    return async (u) => {
      const r = await allowedBy(async () => robots, host + u);
      return r.allowed;
    };
  };

  /* Bad Dog's rule, which sources.mjs carries a comment about because the
     code could not enforce it. The Piston and the Rex publish it too. */
  await (async () => {
    const ask = against('User-agent: *\nDisallow: /*?format=json-pretty\n');
    await checkAsync('a query-string rule is enforced, not ignored', async () =>
      assert.equal(await ask('/shows/thing?format=json-pretty'), false));
    await checkAsync('and the same page without the query is still fine', async () =>
      assert.equal(await ask('/shows/thing'), true));
  })();

  await (async () => {
    const ask = against('User-agent: *\nDisallow: /en/events?*\n');
    await checkAsync('Culture Days: the filtered listing is refused', async () =>
      assert.equal(await ask('/en/events?city=toronto'), false));
    await checkAsync('Culture Days: a detail page is allowed', async () =>
      assert.equal(await ask('/en/events/cf5038fa-3b93-4e03-91d8-d90f52c492b9'), true));
  })();

  await (async () => {
    const ask = against('User-agent: *\nDisallow: /*.pdf$\n');
    await checkAsync('a wildcard with an end anchor matches', async () =>
      assert.equal(await ask('/reports/annual.pdf'), false));
    await checkAsync('and does not match past the anchor', async () =>
      assert.equal(await ask('/reports/annual.pdf.html'), true));
  })();

  /* The arrangement on half the WordPress sites this calendar reads. */
  await (async () => {
    const ask = against('User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n');
    await checkAsync('Allow beats a shorter Disallow', async () =>
      assert.equal(await ask('/wp-admin/admin-ajax.php'), true));
    await checkAsync('the rest of the directory stays refused', async () =>
      assert.equal(await ask('/wp-admin/options.php'), false));
  })();

  await (async () => {
    const ask = against('User-agent: *\nDisallow:\n');
    await checkAsync('an empty Disallow is permission, not a rule matching everything', async () =>
      assert.equal(await ask('/anything'), true));
  })();

  /* Culture Days again: two Disallow: / groups that are not ours. */
  await (async () => {
    const ask = against('User-agent: *\nDisallow: /en/events?*\n\nUser-agent: GPTBot\nDisallow: /\n');
    await checkAsync('another crawler being shut out is not our rule', async () =>
      assert.equal(await ask('/en/events/abc'), true));
  })();

  await (async () => {
    const ask = against(`User-agent: *\nDisallow:\n\nUser-agent: ${PRODUCT_TOKEN}\nDisallow: /\n`);
    await checkAsync('but a group naming this crawler outranks the catch-all', async () =>
      assert.equal(await ask('/anything'), false));
  })();

  await (async () => {
    const ask = against('User-agent: A\nUser-agent: B\nDisallow: /x/\n\nUser-agent: *\nDisallow: /y/\n');
    await checkAsync('consecutive user-agent lines share the group that follows', async () =>
      assert.equal(await ask('/x/thing'), true));
    await checkAsync('and the catch-all group is still read', async () =>
      assert.equal(await ask('/y/thing'), false));
  })();

  await (async () => {
    const ask = against('User-agent: *\nDisallow: /wp-admin/\n');
    await checkAsync('a plain prefix still works exactly as before', async () =>
      assert.equal(await ask('/wp-admin/x'), false));
    await checkAsync('and an unrelated path is untouched', async () =>
      assert.equal(await ask('/ok/page'), true));
  })();
}

console.log('\nA run that has started and has not finished');
{
  const src = { id: 'bentway', name: 'The Bentway', category: 'architecture', art: 'art-skates',
                defaultVenue: 'The Bentway', defaultAddress: '250 Fort York Blvd, Toronto, ON M5V 3K9' };
  const run = (startDate, endDate, today = '2026-09-19') => normalize({
    title: 'Public Pier', startDate, endDate,
    venue: 'Marina Quay West', address: '539 Queens Quay West, Toronto, ON',
  }, src, { today, checked: today });

  check('yesterday to next month is on today', () => {
    const r = run('2026-09-18', '2026-10-03');
    assert.ok(r.ok, r.why);
    assert.deepEqual(r.event.schedule, { kind: 'range', start: '2026-09-18', end: '2026-10-03' });
  });

  check('a run that ends today is still today', () =>
    assert.ok(run('2026-09-01', '2026-09-19').ok));

  check('a run that ended yesterday is past', () =>
    assert.equal(run('2026-09-01', '2026-09-18').ok, false));

  check('a single past day is still past', () =>
    assert.equal(run('2026-09-18', null).ok, false));

  check('a single future day is untouched', () =>
    assert.ok(run('2026-09-25', null).ok));

  /* The Bentway's Waterfront ReConnect pieces: Dec 2023 to Mar 2027. */
  check('a three-year installation is a fixture, not an event', () => {
    const r = run('2023-12-01', '2027-03-31');
    assert.equal(r.ok, false);
    assert.match(r.why, /fixture/);
  });

  check('the longest run anyone has published by hand still fits', () =>
    assert.ok(run('2026-09-08', '2027-06-30').ok));

  check('an end before the start is refused rather than read as a long run', () =>
    assert.equal(run('2026-09-19', '2026-09-01').ok, false));
}

console.log('\nReading The Events Calendar');
{
  const rec = (over) => fromTribe({
    status: 'publish', title: 'A Show', start_date: '2026-09-19 21:30:00',
    end_date: '2026-09-19 23:30:00', cost: '$20', url: 'https://x.test/e/1',
    venue: { venue: 'Revival Event Venue', address: '783 College Street', city: 'Toronto' },
    ...over,
  });

  /* Renaissance runs 21:30 to 02:30 — one night, not a two-day festival. */
  check('a night that ends after midnight is still one night', () => {
    const r = rec({ end_date: '2026-09-20 02:30:00' });
    assert.equal(r.startDate, '2026-09-19');
    assert.equal(r.endDate, null);
    assert.equal(r.time, '9:30pm – 2:30am');
  });

  check('but a genuine two-day run keeps its end', () =>
    assert.equal(rec({ end_date: '2026-09-20 18:00:00' }).endDate, '2026-09-20'));

  check('and a long festival keeps its end too', () =>
    assert.equal(rec({ end_date: '2026-09-27 18:00:00' }).endDate, '2026-09-27'));

  check('a venue with an address is used', () => {
    const r = rec({});
    assert.equal(r.venue, 'Revival Event Venue');
    assert.equal(r.address, '783 College Street, Toronto');
  });

  /* Grossman's sends this on every record; the Emmet Ray names a room. */
  check('an empty venue object leaves the source default to stand', () => {
    const r = rec({ venue: {} });
    assert.equal(r.venue, null);
    assert.equal(r.address, null);
  });

  check('a venue naming a room but no street also falls back', () =>
    assert.equal(rec({ venue: { venue: 'Back Viewing Room' } }).venue, null));

  check('an empty cost is not read as free', () =>
    assert.equal(rec({ cost: '' }).entry, null));

  check('a draft is not published', () =>
    assert.equal(rec({ status: 'draft' }), null));

  check('an event hidden from its own listings is not republished here', () =>
    assert.equal(rec({ hide_from_listings: true }), null));

  check('an all-day event carries no clock time', () =>
    assert.equal(rec({ all_day: true }).time, null));

  check('a record with no usable start is refused', () =>
    assert.equal(rec({ start_date: '' }), null));
}

console.log('\nReading a price and a place out of a feed');
{
  check('free wins whatever else the line says', () =>
    assert.equal(priceFrom('<p>Free, donations welcome ($10 suggested)</p>'), 'Free'));
  check('pay-what-you-can is free', () =>
    assert.equal(priceFrom('PWYC at the door'), 'Free'));
  check('otherwise the first figure is the door price', () =>
    assert.equal(priceFrom('<p><a href="#">$25</a></p>'), '$25'));
  check('and no figure at all is not a price', () =>
    assert.equal(priceFrom('<p>Tickets at the bar</p>'), null));

  check('a named venue splits off the front of the address', () =>
    assert.deepEqual(splitPlace('The Bentway Skate Trail, 250 Fort York Boulevard, Toronto, ON, Canada'),
      { venue: 'The Bentway Skate Trail', address: '250 Fort York Boulevard, Toronto, ON, Canada' }));
  check('a bare street line has no venue to split off', () =>
    assert.deepEqual(splitPlace('250 Fort York Blvd, Toronto, ON'),
      { venue: null, address: '250 Fort York Blvd, Toronto, ON' }));
  check('a Plus Code is a grid reference, not a place', () =>
    assert.equal(splitPlace('JJQ2+373 Toronto, Ontario, Canada'), null));
  check('nothing at all is nothing', () => assert.equal(splitPlace(''), null));
}

console.log('\nThe page and the poller agree on what a family is');
{
  /* app.js needs the families too, to keep one drawing off two touching
     cards, and it cannot import an ES module the poller owns. So data.js
     carries a copy and this is what stops the two drifting. */
  const ctx = vm.createContext({});
  vm.runInContext(readFileSync(new URL('../price.js', import.meta.url), 'utf8'), ctx);
  vm.runInContext(readFileSync(new URL('../data.js', import.meta.url), 'utf8'), ctx);
  const onThePage = vm.runInContext('ART_FAMILIES', ctx);

  const inThePoller = Object.values(FAMILIES).filter((g) => g.length > 1);
  /* Copied out of the vm's realm before comparing: arrays made in there have
     a different Array prototype and deep-equal refuses them on that alone. */
  const norm = (groups) => Array.from(groups, (g) => Array.from(g).join(',')).sort();

  check('every family with more than one drawing is in both', () =>
    assert.deepEqual(norm(onThePage), norm(inThePoller)));

  check('a drawing never sits in two families', () => {
    const seen = new Set();
    for (const g of onThePage) for (const id of g) {
      assert.ok(!seen.has(id), `${id} is in two families`);
      seen.add(id);
    }
  });

  check('every drawing in a family has a file', () => {
    const files = new Set(readdirSync(new URL('../illustrations', import.meta.url))
      .map((f) => f.replace(/\.webp$/, '')));
    for (const g of onThePage) for (const id of g) assert.ok(files.has(id), `${id} has no image`);
  });
}

console.log('\nPicking an illustration per listing');
{
  const m = (title, description) => matchArt({ title, description });

  /* Every one of these is a title the poller has actually returned. */
  check('an artist talk is not a roller skate', () =>
    assert.equal(m('Artist Talk with Paul Ramírez Jonas'), 'art-lectern'));
  check('a farmers market is not a ravine', () =>
    assert.equal(m('Saturday Farmers Market'), 'art-market'));
  check('an artisan and vintage market is still a market', () =>
    assert.equal(m('Ontario Artisan Market and Ontario Vintage Market'), 'art-market'));
  check('a skating night beats its source default', () =>
    assert.equal(m('Monthly Roller Skating Night'), 'art-skates'));
  check('child portrait photos are a camera', () =>
    assert.equal(m('Mighty Minis: Child Portrait Photos'), 'art-camera'));
  check('a book club is books, not a microphone', () =>
    assert.equal(m('Currently Reading - a Sunday morning mid-book club'), 'art-books'));
  check('a site tour of a heritage building is architecture', () =>
    assert.equal(m('Free Public Site Tours of Evergreen Brick Works'), 'art-architecture'));

  /* Title beats description, because a title is chosen and prose is not. */
  check('a walk-and-talk in the prose does not make a design walk a talk', () =>
    assert.equal(m('designwalks™ - Toronto - Walk 11',
      'A monthly walk-and-talk for the design community.'), 'art-architecture'));
  check('"make promises" in the prose does not make a civic project a pot', () =>
    assert.notEqual(m('Public Trust',
      'Torontonians are invited into a non-partisan space to make promises.'), 'art-pottery'));

  /* But the description is still read when the title is only a name. */
  /* Comedy now has two drawings, so the answer is a member of the family
     rather than one fixed id. Which member is the hash's business. */
  check('a title that says nothing falls through to its page', () =>
    assert.ok(FAMILIES['art-comedy'].includes(
      m('Sweet Sweet Friends', 'An improv show at Bad Dog Theatre.'))));

  /* The whole point of the five jazz drawings: one crate of records used to
     land on a hundred and thirty of a hundred and ninety listings. */
  check('a jazz quartet draws an instrument, not a record crate', () =>
    assert.ok(FAMILIES['art-jazz'].includes(m('The Andrew Scott Quartet'))));
  check('five jazz titles do not all draw the same thing', () =>
    assert.ok(new Set(['The Andrew Scott Quartet', 'Mike Murley Trio',
      'Bebop Night', 'Straight Ahead Jazz', 'The Sunday Swing Session']
      .map((t) => m(t))).size >= 3));
  check('a jam is a jam before it is jazz', () =>
    assert.ok(FAMILIES['art-jam'].includes(m('Tuesday Night Jazz Jam'))));

  check('and nothing at all keeps the source default', () =>
    assert.equal(m('Step6ix Sunday Social Run', 'A social run.'), null));
}

console.log(failures ? `\n${failures} failing\n` : '\nall passing\n');
process.exitCode = failures ? 1 : 0;
