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

import { readFile, writeFile, mkdir } from 'node:fs/promises';
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
  /* validFrom is when the offer is known to hold. The honest answer is the
     day the listing was checked against the venue's own page — that is the
     date we can say the price was true, and nothing here knows when tickets
     first went on sale. */
  const base = {
    '@type': 'Offer',
    priceCurrency: 'CAD',
    availability: 'https://schema.org/InStock',
    url: ev.url,
    ...(ev.checked ? { validFrom: ev.checked } : {}),
  };
  if (priceOf(ev) === 'free') return { ...base, price: '0' };
  const m = String(ev.entry || '').match(/\$\s*(\d+(?:\.\d+)?)/);
  /* A listing with no confirmable price gets no offer at all. Search Console
     asks for one on every event; inventing a number to satisfy it would be
     the wrong-money failure this whole project is built to avoid, written in
     a form machines read. The two ROM listings are the ones this affects. */
  if (!m) return null;
  return { ...base, price: m[1] };
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
    /* Only where the source published one of its own. */
    image: ev.image || undefined,
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

const slug = (s) => String(s).toLowerCase()
  .replace(/['’]/g, '').replace(/&/g, 'and')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const fmtDate = (d) => d.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const fmtShort = (d) => d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
const when = (o) => (iso(o.start) === iso(o.end) ? fmtDate(o.start) : `${fmtDate(o.start)} – ${fmtDate(o.end)}`)
  + (o.time ? `, ${o.time}` : '');

const rows = upcoming.map(({ ev, occ }) => ({
  ev, occ,
  cat: CATEGORIES[ev.category].label,
  price: ev.entry || 'Price not listed',
  when: when(occ),
  href: `/event/${ev.id}/`,
  free: priceOf(ev) === 'free',
}));

/* The shell every generated page shares. The site's own stylesheet, a link
   home, and nothing that needs JavaScript to be readable. */
function page({ title, desc, canonical, body, jsonld, crumb }) {
  const ld = crumb
    ? { '@context': 'https://schema.org', '@graph': [jsonld, crumb] }
    : { '@context': 'https://schema.org', ...jsonld };
  return `<!doctype html>
<html lang="en-CA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${SITE}${canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Explora">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${SITE}${canonical}">
<meta property="og:image" content="${SITE}/hero.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${SITE}/hero.png">
<link rel="stylesheet" href="/styles.css?v=dev">
<style>
  /* styles.css is written for the calendar, which is an app shell that must
     not scroll: it sets html,body{height:100%} and body{overflow:hidden}.
     These are documents and have to scroll, so both are undone here — without
     it everything below the first screen is simply unreachable. */
  html { height: auto; }
  body {
    height: auto; min-height: 100%; overflow: visible;
    margin: 0 auto; padding: 28px 24px 80px; max-width: 720px;
    background: var(--paper); color: var(--ink);
  }
  nav.crumbs { font-size: 13px; color: var(--ink-soft); margin: 0 0 26px; }
  nav.crumbs a { color: inherit; }
  h1 { font-size: 26px; line-height: 34px; letter-spacing: -0.02em; margin: 0 0 10px; text-wrap: balance; }
  p.sub { color: var(--ink-soft); margin: 0 0 32px; line-height: 22px; }
  article { padding: 18px 0; border-top: 1px solid var(--line); }
  article h2 { font-size: 16px; line-height: 24px; margin: 0 0 6px; }
  article h2 a { color: inherit; text-decoration: none; }
  article h2 a:hover { text-decoration: underline; }
  dl { display: grid; grid-template-columns: 92px 1fr; gap: 2px 12px; margin: 8px 0 0; font-size: 14px; line-height: 21px; }
  dt { color: var(--ink-soft); }
  dd { margin: 0; }
  p.desc { margin: 8px 0 0; font-size: 14px; line-height: 21px; color: var(--ink-soft); }
  /* The pill carries its category's own colour, the same one the card wears
     on the calendar, so the two read as one system. styles.css defines
     --c-<key> for every category; the fallback is only reached if a listing
     somehow carries a category with no token. */
  .tag {
    display: inline-block; font-size: 12px; line-height: 18px;
    padding: 2px 10px; border-radius: 999px;
    background: var(--line); color: var(--ink);
    box-shadow: inset 0 0 0 1px rgba(25, 25, 25, .07);
  }
  footer { margin-top: 44px; padding-top: 20px; border-top: 1px solid var(--line); font-size: 13px; color: var(--ink-soft); }
  footer a { color: inherit; }
  ul.more { list-style: none; padding: 0; margin: 10px 0 0; display: flex; flex-wrap: wrap; gap: 8px 14px; font-size: 13px; }
</style>
</head>
<body>
${body}
<footer>
  <p><a href="/">Explora</a> — a calendar of free and cheap things to do in Toronto.
  Every listing checked against the venue’s own page; anything unconfirmed is left out.
  Got something to add? <a href="mailto:savage@explora.city">Email me</a>.</p>
</footer>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
</body>
</html>
`;
}

const crumbs = (trail) => ({
  '@type': 'BreadcrumbList',
  itemListElement: trail.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t.name, item: SITE + t.href })),
});

const crumbNav = (trail, here) =>
  `<nav class="crumbs">${trail.map((t) => `<a href="${t.href}">${esc(t.name)}</a>`).join(' › ')} › ${esc(here)}</nav>`;

const card = (r, { headingLink = true } = {}) => `<article>
  <h2>${headingLink ? `<a href="${r.href}">${esc(r.ev.title)}</a>` : esc(r.ev.title)}</h2>
  <span class="tag" style="background: var(--c-${esc(r.ev.category)}, var(--line))">${esc(r.cat)}</span>
  <dl>
    <dt>When</dt><dd>${esc(r.when)}</dd>
    <dt>Where</dt><dd>${esc(r.ev.venue)}${r.ev.address ? ', ' + esc(r.ev.address) : ''}</dd>
    <dt>Price</dt><dd>${esc(r.price)}</dd>
  </dl>
  ${r.ev.description ? `<p class="desc">${esc(r.ev.description)}</p>` : ''}
</article>`;

/* ---------------------------------------------------------- collections */

/* An aggregator's pages are its collections — "free things to do in Toronto"
   is a thing people search; "Explora" is not, yet. One page per intent, each
   listing only what it actually holds. A collection under three listings is
   not published: a page with one item on it is a thin page. */
const MIN_IN_COLLECTION = 3;

function weekendRange(from) {
  const sat = addDays(from, (6 - from.getDay() + 7) % 7);
  return [sat, addDays(sat, 1)];
}
const [SAT, SUN] = weekendRange(TODAY);

const onIn = (r, from, to) => {
  const occ = occurrences(r.ev, from, to);
  return occ.length > 0;
};

const collections = [];

collections.push({
  path: '/free-things-to-do-in-toronto/',
  title: 'Free things to do in Toronto',
  desc: 'Everything on Explora that costs nothing — museum free nights, markets, gigs, walks and street festivals. Each checked against the venue’s own page.',
  intro: 'Everything on the calendar with no door price. Museum free nights, farmers’ markets, gallery openings, street festivals and pay-what-you-can rooms.',
  rows: rows.filter((r) => r.free),
});

collections.push({
  path: '/things-to-do-in-toronto-this-weekend/',
  title: 'Things to do in Toronto this weekend',
  desc: `What’s on in Toronto on ${fmtShort(SAT)} and ${fmtShort(SUN)} — free and cheap events, each checked against the venue’s own page.`,
  intro: `On this coming Saturday and Sunday, ${fmtShort(SAT)} and ${fmtShort(SUN)}. Regenerated every deploy, so it is always the next weekend rather than a fixed one.`,
  rows: rows.filter((r) => onIn(r, SAT, SUN)),
});

collections.push({
  path: '/cheap-things-to-do-in-toronto/',
  title: 'Cheap things to do in Toronto — under $20',
  desc: 'Everything on Explora that costs less than twenty dollars at the door, with the price and the page it was checked against.',
  intro: 'Under twenty dollars at the door. The price shown is what the venue charges, taken from its own page.',
  rows: rows.filter((r) => priceOf(r.ev) === 'under20'),
});

for (const [key, c] of Object.entries(CATEGORIES)) {
  const inCat = rows.filter((r) => r.ev.category === key);
  if (inCat.length < MIN_IN_COLLECTION) continue;
  const label = c.label.toLowerCase();
  collections.push({
    path: `/${slug(c.label)}-in-toronto/`,
    title: `${c.label} in Toronto`,
    desc: `${inCat.length} ${label} listings on Explora, free and cheap, each checked against the venue’s own page.`,
    intro: `Everything on the calendar filed under ${label}.`,
    rows: inCat,
  });
}

const published = collections.filter((c) => c.rows.length >= MIN_IN_COLLECTION);
const skipped = collections.filter((c) => c.rows.length < MIN_IN_COLLECTION);

const otherLinks = (exclude) => `<ul class="more">${published
  .filter((c) => c.path !== exclude)
  .map((c) => `<li><a href="${c.path}">${esc(c.title)}</a></li>`).join('')}</ul>`;

/* ------------------------------------------------------------------ write */

const written = [];
async function put(rel, html) {
  const full = path.join(root, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, html);
  written.push(rel);
}

for (const c of published) {
  const trail = [{ name: 'Explora', href: '/' }];
  await put(c.path.replace(/^\//, '') + 'index.html', page({
    title: `${c.title} — Explora`,
    desc: c.desc,
    canonical: c.path,
    crumb: crumbs([...trail, { name: c.title, href: c.path }]),
    jsonld: {
      '@type': 'CollectionPage',
      name: c.title,
      description: c.desc,
      url: SITE + c.path,
      isPartOf: { '@type': 'WebSite', name: 'Explora', url: SITE + '/' },
      mainEntity: {
        '@type': 'ItemList',
        numberOfItems: c.rows.length,
        itemListElement: c.rows.map((r, i) => ({
          '@type': 'ListItem', position: i + 1, url: SITE + r.href, name: r.ev.title,
        })),
      },
    },
    body: `${crumbNav(trail, c.title)}
<h1>${esc(c.title)}</h1>
<p class="sub">${esc(c.intro)} ${c.rows.length} listing${c.rows.length === 1 ? '' : 's'}, soonest first.</p>
${c.rows.map((r) => card(r)).join('\n')}
<h2 style="margin-top:40px;font-size:15px">Elsewhere on Explora</h2>
${otherLinks(c.path)}`,
  }));
}

for (const r of rows) {
  const trail = [{ name: 'Explora', href: '/' }];
  const catCollection = published.find((c) => c.rows.includes(r) && c.path.endsWith('-in-toronto/') && !c.path.startsWith('/free') && !c.path.startsWith('/cheap') && !c.path.startsWith('/things-to-do'));
  if (catCollection) trail.push({ name: catCollection.title, href: catCollection.path });
  await put(`event/${r.ev.id}/index.html`, page({
    title: `${r.ev.title} — ${r.when.split(',')[0]}, Toronto`,
    desc: `${r.ev.title} at ${r.ev.venue}. ${r.when}. ${r.price}. Checked against the venue’s own page.`,
    canonical: r.href,
    crumb: crumbs([...trail, { name: r.ev.title, href: r.href }]),
    jsonld: eventNode({ ev: r.ev, occ: r.occ }),
    body: `${crumbNav(trail, r.ev.title)}
<h1>${esc(r.ev.title)}</h1>
<p class="sub">${esc(r.cat)} in Toronto${r.free ? ', free' : ''}.</p>
${card(r, { headingLink: false }).replace(/<h2>[\s\S]*?<\/h2>\n/, '')}
<p class="desc" style="margin-top:18px">
  Checked against <a href="${esc(r.ev.source || r.ev.url)}" rel="nofollow noopener">the venue’s own page</a>${r.ev.checked ? ` on ${esc(r.ev.checked)}` : ''}.
  ${r.ev.url ? `<a href="${esc(r.ev.url)}" rel="nofollow noopener">Full details</a>.` : ''}
</p>
<h2 style="margin-top:40px;font-size:15px">More on Explora</h2>
${otherLinks('')}`,
  }));
}

/* --------------------------------------------- index, feeds and directives */

const listingsMd = `# Explora — free and cheap things to do in Toronto

${rows.length} listings, soonest first. Every one checked against the venue's own
page; anything that could not be confirmed is not here. Updated ${iso(TODAY)}.

Calendar: ${SITE}/

## Collections

${published.map((c) => `- [${c.title}](${SITE}${c.path}) — ${c.rows.length} listings`).join('\n')}

## Listings

${rows.map((r) => `### ${r.ev.title}

- When: ${r.when}
- Where: ${r.ev.venue}${r.ev.address ? ', ' + r.ev.address : ''}
- Price: ${r.price}
- Category: ${r.cat}
- Page: ${SITE}${r.href}
- Source: ${r.ev.source || r.ev.url}
${r.ev.description ? '\n' + r.ev.description + '\n' : ''}`).join('\n')}
`;

const llms = `# Explora

> A calendar of free and cheap things to do in Toronto. It is an aggregator:
> it gathers what is on across the city into one place. Every listing is
> checked against the venue's own page before publishing, and anything that
> could not be confirmed is left out rather than guessed at.

The calendar runs from today outward in time windows — Today, this week, this
month, this year — so the first card is always the answer to "what should I do
today?". ${rows.length} listings across ${new Set(rows.map((r) => r.cat)).size} categories.

## Collections

${published.map((c) => `- [${c.title}](${SITE}${c.path}): ${c.rows.length} listings`).join('\n')}

## Everything at once

- [All listings, plain text](${SITE}/listings.md): dates, venues, prices, sources
- [All listings, as a page](${SITE}/listings.html)
- [The calendar itself](${SITE}/): interactive, renders in the browser

## Notes for anyone quoting this

Prices are what the venue charges at the door, taken from its own page on the
date in the listing's source. They go stale — check the source before relying
on one. A listing with no price means the venue publishes none, not that it is
free. Dates for recurring things are the next occurrence, not the only one.

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
  ...published.map((c) => ({ loc: SITE + c.path, priority: '0.9', freq: 'daily' })),
  ...rows.map((r) => ({ loc: SITE + r.href, priority: '0.7', freq: 'weekly' })),
  { loc: SITE + '/listings.html', priority: '0.6', freq: 'daily' },
  { loc: SITE + '/listings.md', priority: '0.4', freq: 'daily' },
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

const listingsHtml = page({
  title: 'Every listing on Explora — free and cheap things to do in Toronto',
  desc: `All ${rows.length} events on Explora, with dates, venues and prices. Every listing checked against the venue's own page.`,
  canonical: '/listings.html',
  crumb: crumbs([{ name: 'Explora', href: '/' }, { name: 'Every listing', href: '/listings.html' }]),
  jsonld: {
    '@type': 'CollectionPage',
    name: 'Every listing on Explora',
    url: SITE + '/listings.html',
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: rows.length,
      itemListElement: rows.map((r, i) => ({ '@type': 'ListItem', position: i + 1, url: SITE + r.href, name: r.ev.title })),
    },
  },
  body: `${crumbNav([{ name: 'Explora', href: '/' }], 'Every listing')}
<h1>Every listing on Explora</h1>
<p class="sub">All ${rows.length} things to do in Toronto currently on the calendar, soonest first.
Each was checked against the venue’s own page.</p>
${rows.map((r) => card(r)).join('\n')}
<h2 style="margin-top:40px;font-size:15px">Collections</h2>
${otherLinks('')}`,
});

await put('listings.html', listingsHtml);
await put('listings.md', listingsMd);
await put('llms.txt', llms);
await put('robots.txt', robots);
await put('sitemap.xml', sitemapXml);

/* Idempotent: strip any block this script wrote before, then write a fresh
   one. The workflow runs on a clean checkout, but a developer running it
   twice locally should not end up with two graphs in the head. */
let index = await readFile(path.join(root, 'index.html'), 'utf8');
const OPEN = '<!-- build-seo:start -->';
const CLOSE = '<!-- build-seo:end -->';
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
index = index.replace(new RegExp(rx(OPEN) + '[\\s\\S]*?' + rx(CLOSE) + '\\n', 'g'), '');

/* The home page points at the collections so a crawler arriving there has
   somewhere to go — without them every generated page is an orphan. */
const homeGraph = {
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
const homeBlock = `${OPEN}\n<script type="application/ld+json">${JSON.stringify(homeGraph)}</script>\n${CLOSE}\n`;
index = index.replace('</head>', homeBlock + '</head>');

/* No link block is written into the home page. The thirteen collections plus
   the full index came to fourteen links dropped into the middle of the About
   copy, which read as keyword stuffing to a person and probably to a crawler
   too. Discovery does not depend on them: sitemap.xml carries all seventy
   URLs and is submitted, the collections link each other, and every event
   page breadcrumbs up to its collection. What is given up is the sliver of
   link equity the home page would have passed down, which on a domain with
   no inbound links is worth less than a clean page. */

await writeFile(path.join(root, 'index.html'), index);

console.log(`build-seo: ${LISTINGS.length} listings, ${upcoming.length} upcoming`);
console.log(`  collections published: ${published.length}${skipped.length ? `, skipped as thin (<${MIN_IN_COLLECTION}): ${skipped.map((c) => c.title + ' (' + c.rows.length + ')').join(', ')}` : ''}`);
console.log(`  event pages: ${rows.length}`);
console.log(`  sitemap urls: ${urls.length}`);
console.log(`  index.html: ${homeGraph['@graph'].length - 1} events of JSON-LD`);
