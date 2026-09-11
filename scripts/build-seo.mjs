/* Everything a crawler needs, generated from data.js at deploy time.
 *
 * The site renders its board in the browser, which means the HTML a crawler
 * first receives carries no listings at all — the whole point of the site is
 * invisible to anything that does not run JavaScript, and that is most things
 * that are not Google. This writes the static counterparts:
 *
 *   sitemap.xml    what exists
 *   robots.txt     who may read it, including the AI crawlers, and the sitemap
 *   llms.txt       what the site is, for an agent that wants the short version
 *   listings.md    every listing as plain text, for the same reader
 *   listings.html  every listing as a real page, for a search crawler
 *   index.html     gets Event JSON-LD and the listing count injected
 *
 * Run from the repo root. It reads the same data.js the page does, through a
 * vm context, so nothing here can drift from what a visitor sees. */

import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';

const root = process.cwd();
const SITE = 'https://explora.city';

/* ---------------------------------------------------------------- loading */

const ctx = vm.createContext({});
for (const f of ['price.js', 'data.js', 'scraped.js']) {
  try {
    vm.runInContext(await readFile(path.join(root, f), 'utf8'), ctx, { filename: f });
  } catch (e) {
    if (f === 'scraped.js') continue;      /* optional; the poller writes it */
    throw e;
  }
}
const EVENTS = vm.runInContext('EVENTS', ctx);
const SCRAPED = vm.runInContext('typeof SCRAPED !== "undefined" ? SCRAPED : []', ctx);
const CATEGORIES = vm.runInContext('CATEGORIES', ctx);
const priceOf = vm.runInContext('priceOf', ctx);

const LISTINGS = EVENTS.concat(Array.isArray(SCRAPED) ? SCRAPED : [])
  .filter((e) => e && e.id && e.title && e.schedule && CATEGORIES[e.category]);

/* ------------------------------------------------------------- schedules */

/* Mirrors expand() in app.js. If the schedule kinds ever grow, both change. */
const iso = (d) => d.toISOString().slice(0, 10);
const fromISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12);
const cmp = (a, b) => a - b;

function nthWeekday(year, month, weekday, nth) {
  if (nth > 0) {
    const first = new Date(year, month, 1, 12);
    const day = 1 + ((weekday - first.getDay() + 7) % 7) + (nth - 1) * 7;
    const d = new Date(year, month, day, 12);
    return d.getMonth() === month ? d : null;
  }
  const last = new Date(year, month + 1, 0, 12);
  return new Date(year, month, last.getDate() - ((last.getDay() - weekday + 7) % 7), 12);
}

function occurrences(ev, from, to) {
  const out = [];
  for (const s of [].concat(ev.schedule)) {
    const push = (start, end) => {
      if (cmp(end, from) < 0 || cmp(start, to) > 0) return;
      out.push({ start, end, time: s.time || null });
    };
    if (s.kind === 'range') { push(fromISO(s.start), fromISO(s.end)); continue; }
    if (s.kind === 'day')   { const d = fromISO(s.date); push(d, d); continue; }

    const lo = new Date(Math.max(from, fromISO(s.from)));
    const hi = new Date(Math.min(to, fromISO(s.to)));
    if (cmp(lo, hi) > 0) continue;

    if (s.kind === 'weekly') {
      for (const wd of [].concat(s.weekday)) {
        let c = addDays(lo, (wd - lo.getDay() + 7) % 7);
        while (cmp(c, hi) <= 0) { push(c, c); c = addDays(c, 7); }
      }
    } else if (s.kind === 'nth') {
      let y = lo.getFullYear(), m = lo.getMonth();
      while (y < hi.getFullYear() || (y === hi.getFullYear() && m <= hi.getMonth())) {
        const d = nthWeekday(y, m, s.weekday, s.nth);
        if (d && cmp(d, lo) >= 0 && cmp(d, hi) <= 0) push(d, d);
        if (++m > 11) { m = 0; y += 1; }
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

const TODAY = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12); })();
const HORIZON = addDays(TODAY, 365);

/* Each listing reduced to its next upcoming occurrence. One Event per
   listing rather than per night: a reader wants to know the thing is on, and
   a hundred near-identical Events is what a spam filter is built to catch. */
const upcoming = LISTINGS
  .map((ev) => ({ ev, occ: occurrences(ev, TODAY, HORIZON)[0] }))
  .filter((x) => x.occ)
  /* Sorted by when it is next relevant, not when it began. A run that opened
     in July and closes in October is on today, and belongs above something
     that starts next week rather than three months above it. */
  .sort((a, b) => Math.max(a.occ.start, TODAY) - Math.max(b.occ.start, TODAY)
                  || a.ev.title.localeCompare(b.ev.title));

/* ------------------------------------------------------------- structured */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function offersFor(ev) {
  const bucket = priceOf(ev);
  if (bucket === 'free') {
    return { '@type': 'Offer', price: '0', priceCurrency: 'CAD', availability: 'https://schema.org/InStock', url: ev.url };
  }
  const m = String(ev.entry || '').match(/\$\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;                     /* unknown stays unknown */
  return { '@type': 'Offer', price: m[1], priceCurrency: 'CAD', availability: 'https://schema.org/InStock', url: ev.url };
}

function eventNode({ ev, occ }) {
  const node = {
    '@type': 'Event',
    name: ev.title,
    startDate: iso(occ.start),
    endDate: iso(occ.end),
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    description: ev.description || undefined,
    url: ev.url || SITE,
    location: {
      '@type': 'Place',
      name: ev.venue,
      address: { '@type': 'PostalAddress', streetAddress: ev.address, addressLocality: 'Toronto', addressRegion: 'ON', addressCountry: 'CA' },
    },
    organizer: { '@type': 'Organization', name: ev.venue, url: ev.url || undefined },
    isAccessibleForFree: priceOf(ev) === 'free' || undefined,
  };
  const offers = offersFor(ev);
  if (offers) node.offers = offers;
  return node;
}

const graph = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      '@id': SITE + '/#website',
      name: 'Explora',
      url: SITE + '/',
      description: 'A calendar of free and cheap things to do in Toronto, every listing checked against the venue’s own page.',
      inLanguage: 'en-CA',
sameAs: ['https://www.tiktok.com/@explora.to'],
    },
    ...upcoming.map(eventNode),
  ],
};

/* ------------------------------------------------------------------ pages */

const fmtDate = (d) => d.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const when = (o) => (iso(o.start) === iso(o.end) ? fmtDate(o.start) : `${fmtDate(o.start)} – ${fmtDate(o.end)}`)
  + (o.time ? `, ${o.time}` : '');

const rows = upcoming.map(({ ev, occ }) => ({
  ev, occ,
  cat: CATEGORIES[ev.category].label,
  price: ev.entry || 'Price not listed',
  when: when(occ),
}));

const listingsHtml = `<!doctype html>
<html lang="en-CA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Every listing on Explora — free and cheap things to do in Toronto</title>
<meta name="description" content="All ${rows.length} events on Explora, with dates, venues and prices. Every listing checked against the venue's own page.">
<link rel="canonical" href="${SITE}/listings.html">
<meta property="og:title" content="Every listing on Explora">
<meta property="og:description" content="All ${rows.length} free and cheap things to do in Toronto, with dates, venues and prices.">
<meta property="og:url" content="${SITE}/listings.html">
<meta property="og:image" content="${SITE}/hero.png">
<meta property="og:type" content="website">
<link rel="stylesheet" href="styles.css?v=dev">
<style>
  body { margin: 0 auto; padding: 40px 24px 80px; max-width: 720px; background: var(--paper); color: var(--ink); }
  h1 { font-size: 24px; line-height: 32px; letter-spacing: -0.02em; margin: 0 0 8px; }
  .sub { color: var(--ink-soft); margin: 0 0 36px; }
  article { padding: 18px 0; border-top: 1px solid var(--line); }
  h2 { font-size: 16px; line-height: 24px; margin: 0 0 4px; }
  dl { display: grid; grid-template-columns: 96px 1fr; gap: 2px 12px; margin: 8px 0 0; font-size: 14px; line-height: 21px; }
  dt { color: var(--ink-soft); }
  dd { margin: 0; }
  p.desc { margin: 6px 0 0; font-size: 14px; line-height: 21px; color: var(--ink-soft); }
  a { color: inherit; }
</style>
</head>
<body>
<h1>Every listing on Explora</h1>
<p class="sub">All ${rows.length} things to do in Toronto currently on the calendar, soonest first.
Each was checked against the venue’s own page. <a href="/">Back to the calendar</a>.</p>

${rows.map(({ ev, cat, price, when }) => `<article>
  <h2>${esc(ev.title)}</h2>
  <dl>
    <dt>When</dt><dd>${esc(when)}</dd>
    <dt>Where</dt><dd>${esc(ev.venue)}${ev.address ? ', ' + esc(ev.address) : ''}</dd>
    <dt>Price</dt><dd>${esc(price)}</dd>
    <dt>Category</dt><dd>${esc(cat)}</dd>
    <dt>Source</dt><dd><a href="${esc(ev.source || ev.url)}" rel="nofollow noopener">${esc((ev.source || ev.url || '').replace(/^https?:\/\//, '').split('/')[0])}</a></dd>
  </dl>
  ${ev.description ? `<p class="desc">${esc(ev.description)}</p>` : ''}
</article>`).join('\n')}

<script type="application/ld+json">${JSON.stringify(graph)}</script>
</body>
</html>
`;

const listingsMd = `# Explora — free and cheap things to do in Toronto

${rows.length} listings, soonest first. Every one checked against the venue's own
page; anything that could not be confirmed is not here. Updated ${iso(TODAY)}.

Calendar: ${SITE}/

${rows.map(({ ev, cat, price, when }) => `## ${ev.title}

- When: ${when}
- Where: ${ev.venue}${ev.address ? ', ' + ev.address : ''}
- Price: ${price}
- Category: ${cat}
- Source: ${ev.source || ev.url}
${ev.description ? '\n' + ev.description + '\n' : ''}`).join('\n')}
`;

const llms = `# Explora

> A calendar of free and cheap things to do in Toronto. Every listing is checked
> against the venue's own page before it is published; anything that could not be
> confirmed is left out and the gap is recorded rather than guessed at.

The calendar runs from today outward in time windows — Today, this week, this
month, this year — so the first card is always the answer to "what should I do
today?". ${rows.length} listings across ${new Set(rows.map((r) => r.cat)).size} categories:
${[...new Set(rows.map((r) => r.cat))].sort().join(', ')}.

## Listings

- [Every listing, as plain text](${SITE}/listings.md): all ${rows.length} with dates, venues, prices and sources
- [Every listing, as a page](${SITE}/listings.html): the same, as HTML
- [The calendar itself](${SITE}/): interactive, renders in the browser

## Notes for anyone quoting this

Prices are what the venue charges at the door, taken from its own page on the
date in the listing's source. They go stale — check the source before relying
on one. A listing with no price means the venue publishes none, not that it is
free.

Contact: savage@explora.city
`;

const robots = `# explora.city
#
# Everything here is public and meant to be read, by people and by machines
# alike. The AI crawlers are named explicitly rather than left to the wildcard
# so there is no ambiguity about it.

User-agent: *
Allow: /

User-agent: GPTBot
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Claude-User
Allow: /

User-agent: Claude-SearchBot
Allow: /

User-agent: anthropic-ai
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Perplexity-User
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: Applebot
Allow: /

User-agent: Applebot-Extended
Allow: /

User-agent: CCBot
Allow: /

User-agent: Bingbot
Allow: /

User-agent: cohere-ai
Allow: /

User-agent: Meta-ExternalAgent
Allow: /

Sitemap: ${SITE}/sitemap.xml
`;

const urls = [
  { loc: SITE + '/', priority: '1.0', freq: 'daily' },
  { loc: SITE + '/listings.html', priority: '0.8', freq: 'daily' },
  { loc: SITE + '/listings.md', priority: '0.5', freq: 'daily' },
];
const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${iso(TODAY)}</lastmod>
    <changefreq>${u.freq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>
`;

/* --------------------------------------------------------------- injection */

/* Idempotent: strip any block this script wrote before, then write a fresh
   one. The workflow runs on a clean checkout, but a developer running it
   twice locally should not end up with two graphs in the head. */
let index = await readFile(path.join(root, 'index.html'), 'utf8');
const OPEN = '<!-- build-seo:start -->';
const CLOSE = '<!-- build-seo:end -->';
const between = new RegExp(OPEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + CLOSE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n?', 'g');
index = index.replace(between, '');
const block = `${OPEN}\n<script type="application/ld+json">${JSON.stringify(graph)}</script>\n${CLOSE}\n`;
index = index.replace('</head>', block + '</head>');
await writeFile(path.join(root, 'index.html'), index);

await writeFile(path.join(root, 'listings.html'), listingsHtml);
await writeFile(path.join(root, 'listings.md'), listingsMd);
await writeFile(path.join(root, 'llms.txt'), llms);
await writeFile(path.join(root, 'robots.txt'), robots);
await writeFile(path.join(root, 'sitemap.xml'), sitemapXml);

console.log(`build-seo: ${LISTINGS.length} listings, ${upcoming.length} upcoming`);
console.log(`  index.html   +${JSON.stringify(graph).length} bytes of JSON-LD (${graph['@graph'].length - 1} events)`);
console.log(`  listings.html listings.md llms.txt robots.txt sitemap.xml`);
