/* Eventbrite: what gets through, what it costs, and how it is filed.
 *
 * Every other source here is a venue or an organiser publishing its own
 * calendar. Eventbrite is a ticket vendor for anyone, so its Toronto page is
 * mostly conferences, summits and business breakfasts, a lot of it is in
 * Mississauga, and one event can have a free tier and a $600 one. The gates
 * below are the difference between that and this board.
 *
 * vetEventbrite is the one entry point: sources.mjs hands it to normalize as
 * `vet`, and normalize applies everything it cannot know on its own — dates,
 * venue, the $35 ceiling — before and after it. Everything here reads the
 * event page's own JSON-LD, which extract.mjs carries through as raw fields. */

import { NETWORKING } from './filters.mjs';

/* ------------------------------------------------------------------ gates */

/* The conference end of the feed, which Luma's list was never written for:
   'Ted Rogers Centre for Heart Research: 2026 Heart Failure Symposium',
   'Young Professionals Leadership Summit 2026', 'Global Data Centre & Cloud
   Expo Canada'. Stems and plurals, because Eventbrite titles are written
   by thousands of people and none of them agree on either. */
export const PROFESSIONAL_TITLE = new RegExp('\\b(' + [
  'symposi(um|ums|a)', 'conferences?', 'summits?', 'keynotes?', 'forums?',
  'professional development', '(young )?professionals', 'expos?', 'trade ?shows?',
  'conventions?', 'seminars?', 'webinars?', 'leadership', 'entrepreneur(s|ship|ial)?',
  'investors?', 'investing', 'real estate', 'small business(es)?',
  'business (leaders?|owners?|event|events|network(ing)?|growth|awards?|breakfast|luncheon|lunch)',
  'executives?', 'ceos?', 'marketing', 'sales (training|summit|kickoff)', 'certification', 'accreditation',
  'cpd', 'ceus?', 'continuing education', 'careers?', 'jobs?', 'industry night',
  'data (centre|center)s?', 'cloud (computing|expo|summit)', 'cyber ?security', 'blockchain', 'crypto',
].join('|') + ')\\b', 'i');

/* Titles that name nothing but a brand — 'researchED Toronto - From
   Evidence to More Equitable Outcomes' — give themselves away in the first
   line of the page instead: "world-class keynote speakers and educators".
   Narrower than the title list, because prose mentions things in passing. */
export const PROFESSIONAL_DESCRIPTION = /\b(keynotes?|professional development|continuing education|cpd (credits|hours)|ceus?|networking (event|events|opportunit(y|ies)|reception|session|lunch|breakfast)|conferences?|symposi(um|a)|summits?|trade shows?|b2b|thought leaders?|industry leaders|c-suite)\b/i;

/* Toronto as the city draws it. normalize.mjs's IN_TOWN also accepts
   Mississauga — on purpose, because Luma's Salmon Run Hike on the Credit is
   on the board through it — which is how 'DOC Wine Imports Annual Portfolio
   Wine Tasting' at 3045 Southcreek Road, Mississauga got through. For
   Eventbrite, which lists the whole GTA, the page's own addressLocality
   decides, and only the city and its former boroughs count. */
const TORONTO_LOCALITY = /^(toronto|old toronto|downtown toronto|scarborough|etobicoke|north york|east york|york)$/i;
const ELSEWHERE = /^(mississauga|brampton|vaughan|markham|richmond hill|oakville|burlington|hamilton|milton|pickering|ajax|whitby|oshawa|newmarket|aurora|king city|caledon|concord|woodbridge|thornhill|maple|stouffville|halton hills|georgetown|bolton|niagara.*|kitchener|waterloo|guelph|barrie)$/i;

function cityProblem(raw) {
  const locality = String(raw.locality ?? '').trim();
  if (locality) return TORONTO_LOCALITY.test(locality) ? null : `not in Toronto (${locality})`;
  /* No locality: look for a municipality standing as its own part of the
     address, so "Markham St, Toronto" is still Toronto and "…, Markham, ON"
     is not. */
  const parts = String(raw.address ?? '').split(',')
    .map((p) => p.replace(/\b[A-Z]\d[A-Z]\s*\d[A-Z]\d\b/i, '').replace(/\b(on|ont|ontario)\b/i, '').trim());
  const other = parts.find((p) => ELSEWHERE.test(p));
  if (other) return `not in Toronto (${other})`;
  if (!parts.some((p) => TORONTO_LOCALITY.test(p))) return `no Toronto locality in the address (${raw.address ?? 'none'})`;
  return null;
}

/* ------------------------------------------------------------------ price */

const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const isZero = (n) => n !== null && n < 0.005;

/* Written the way the rest of the board writes a price: "Free", "$12",
   "$19.70". price.js buckets on the leading "Free" or the first dollar
   figure, and normalize's ceiling reads the same figure. */
export const formatPrice = (n) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`)
  .replace(/\.00$/, '');

/* The price of an Eventbrite event from its page's offers.
 *
 * Free only when every ticket is $0. Otherwise the cheapest ticket that costs
 * something — never "$0", and never "Free" for an event whose free tier is a
 * waitlist beside a $50 seat.
 *
 * Eventbrite publishes one AggregateOffer with lowPrice and highPrice and no
 * per-ticket list. That settles two cases: 0–0 is free, and a lowPrice above
 * zero is the cheapest paid ticket. It cannot settle 0–$76: there is a free
 * tier and at least one paid one, and the cheapest paid price is nowhere on
 * the page. That is a price nobody can read, so the event is dropped with
 * that reason rather than published as Free or as a guess.
 *
 * Returns { entry } or { why }. */
export function eventbritePrice(offers) {
  const flat = [];
  const walk = (o) => {
    for (const x of [].concat(o ?? [])) {
      if (!x || typeof x !== 'object') continue;
      flat.push(x);
      if (x.offers) walk(x.offers);
    }
  };
  walk(offers);
  if (!flat.length) return { why: 'no offers in the event page’s JSON-LD, so no readable price' };

  const currencies = [...new Set(flat.map((o) => o.priceCurrency).filter(Boolean).map(String))];
  const foreign = currencies.find((c) => c.toUpperCase() !== 'CAD');
  if (foreign) return { why: `priced in ${foreign}, not CAD` };

  const tickets = [];            /* individual prices: Offer.price */
  const lows = [];
  const highs = [];
  for (const o of flat) {
    const p = num(o.price);
    if (p !== null) tickets.push(p);
    const lo = num(o.lowPrice);
    const hi = num(o.highPrice);
    if (lo !== null) lows.push(lo);
    if (hi !== null) highs.push(hi);
  }
  const all = [...tickets, ...lows, ...highs];
  if (!all.length) return { why: 'offers carry no readable price' };
  if (all.every(isZero)) return { entry: 'Free' };

  /* Everything known to be the price of a paid ticket: an individual price
     above zero, or a lowPrice above zero (every ticket costs at least that). */
  const paid = [...tickets, ...lows].filter((n) => !isZero(n));
  const freeTier = [...tickets, ...lows].some(isZero);
  if (freeTier && tickets.filter((n) => !isZero(n)).length === 0) {
    const top = Math.max(...highs);
    return { why: `free and paid tickets (up to ${formatPrice(top)}); the cheapest paid ticket is not in the offers` };
  }
  if (!paid.length) return { why: 'offers carry no readable price' };
  return { entry: formatPrice(Math.min(...paid)) };
}

/* ------------------------------------------------------------- classifier */

/* Category and drawing, read off the title first, then the description, then
 * the venue's name — the same order art-match.mjs uses, for the same reason:
 * a title is chosen and prose is incidental.
 *
 * Every `category` is a key of CATEGORIES in data.js (app.js drops a listing
 * whose category is not), and every `art` is a file in illustrations/ — the
 * suite checks both against the real files, because the first version of
 * this returned 'art-stage'-style names for categories that happened to
 * exist and one that did not.
 *
 * Parties and DJ nights file the way Revival's already do: music, drawn as
 * decks. Talks are stage with the lectern, the drawing art-match gives an
 * artist talk; Luma's are 'social' only because Luma as a whole is. */
const BOOKISH = /\b(books?|book ?(shops?|stores?|sellers?|launch(es)?|club|signing)|authors?|novel(s|ist|ists)?|memoirs?|poe(t|ts|try|ms?)|literary|literature|publish(er|ers|ing)|writers?|knopf|penguin random house|harpercollins|simon & schuster|house of anansi|mcclelland)\b/i;

export const RULES = [
  /* 'Douglas Stuart Toronto launch "John of John"' names neither a book nor
     an author; the quoted title and the page's "Another Story Bookshop and
     Knopf Canada … the launch of John of John by Douglas Stuart" do. */
  { name: 'book launch', category: 'books', art: 'art-books',
    test: (t, d) => /\blaunch(es|ed|ing)?\b/i.test(t)
      && (/["“][^"”]{2,}["”]/.test(t) || BOOKISH.test(d) || /\blaunch of .+ by [A-Z]/.test(d)) },
  { name: 'books', category: 'books', art: 'art-books', re: BOOKISH },
  /* \btalk\b missed 'The Walrus Talks Community Reborn'. */
  { name: 'talk', category: 'stage', art: 'art-lectern',
    re: /\b(talks?|lectures?|panels?|panel discussion|in conversation|conversations? with|speakers?|speaker series|fireside chats?|q ?& ?a|debates?)\b/i },
  { name: 'comedy', category: 'comedy', art: 'art-comedy',
    re: /\b(comed(y|ies|ian|ians|ic)|stand[- ]?up|improv|sketch (comedy|show)|open mic|roast)\b/i },
  { name: 'film', category: 'film', art: 'art-film',
    re: /\b(films?|screenings?|cinema|movies?|documentar(y|ies))\b/i },
  { name: 'festival', category: 'festival', art: 'art-festival',
    re: /\b(festivals?|fest|parades?|carnivals?|street part(y|ies)|block part(y|ies)|fairs?)\b/i },
  /* 'Toronto Rooftop Day Party', 'WHINE SLOW - Toronto's Sexiest Dancehall &
     Soca Party' — filed as Revival's "Afrobeats & Friends | Amapiano | R&B |
     Dancehall" already is. */
  { name: 'party', category: 'music', art: 'art-decks',
    re: /\b(part(y|ies)|day[- ]?part(y|ies)|djs?|dancehall|soca|bashment|afrobeats?|amapiano|reggaeton|dembow|r&b|rnb|hip[- ]?hop|disco|raves?|club nights?|dance (party|parties|night|nights|floor)|dancefloor|house music|techno|edm|day ?club)\b/i },
  { name: 'classical', category: 'music', art: 'art-violin',
    re: /\b(orchestras?|orchestral|symphon(y|ies|ic)|classical|baroque|chamber (music|ensemble|orchestra)|string quartets?|philharmonic|recitals?|violin(s|ist)?|cellos?|cellist)\b/i },
  { name: 'jazz', category: 'music', art: 'art-jazz-sax',
    re: /\b(jazz|bebop|big band|swing band)\b/i },
  { name: 'blues', category: 'music', art: 'art-blues', re: /\bblues\b/i },
  { name: 'folk', category: 'music', art: 'art-folk',
    re: /\b(folk|bluegrass|singer[- ]songwriters?|acoustic)\b/i },
  /* 'ARTCELL – Live in Toronto' is a band ("Doors Open: 6:00 PM Show 7PM");
     'UK Calling - Toronto' says only "alternative 80's show" on its page. */
  { name: 'music', category: 'music', art: 'art-music',
    re: /\b(live music|concerts?|bands?|gigs?|live in (toronto|concert)|in concert|(world|north american|canadian|album|farewell|reunion|anniversary|concert) tour|albums?|singers?|choirs?|choral|operas?|music|musicians?|rock|punk|metal|indie|tribute|karaoke|(19)?[5-9]0'?s|2000s)\b/i },
  { name: 'stage', category: 'stage', art: 'art-stage',
    re: /\b(theat(re|er|rical)|musicals?|ballet|circus|drag (show|brunch|night)s?|cabaret|burlesque|podcast|magic show|staged reading)\b/i },
  { name: 'food', category: 'food', art: 'art-food',
    re: /\b(tastings?|wines?|beers?|brew(ery|eries|ing|s)?|food|foodies?|culinary|chefs?|croissants?|baguettes?|bak(e|es|ery|eries|ing)|brunch(es)?|dinners?|suppers?|cook(ing|off)?|coffee|cocktails?|whisk(e)?y|cheese|pizza|tacos?|dumplings?|picnics?)\b/i },
  { name: 'flea', category: 'flea', art: 'art-flea',
    re: /\b(flea|vintage|thrift|antiques?|swap|collectibles?)\b/i },
  { name: 'market', category: 'market', art: 'art-market',
    re: /\b(markets?|marketplace|vendors?|bazaars?|makers'? (market|fair)|craft (fair|show|sale)s?|pop[- ]?ups?)\b/i },
  { name: 'museum', category: 'museum', art: 'art-museum', re: /\bmuseums?\b/i },
  { name: 'art', category: 'art', art: 'art-gallery',
    re: /\b(exhibit(s|ion|ions)?|galler(y|ies)|vernissage|art (show|fair|walk|crawl|opening)s?|artists?|murals?|installations?|sculptures?|paintings?|photography)\b/i },
  { name: 'drawing', category: 'dropin', art: 'art-dropin',
    re: /\b(draw(ing)?|sketch(ing)?|life drawing|paint(ing)? night|sip (and|&|n) paint)\b/i },
  { name: 'craft', category: 'dropin', art: 'art-pottery',
    re: /\b(workshops?|classes|pottery|ceramics?|crafts?|knit(ting)?|sew(ing)?|embroidery|terrariums?|candle[- ]making)\b/i },
  /* 'ExperienceTO: University of Toronto Historical Tour'. */
  { name: 'tour', category: 'architecture', art: 'art-architecture',
    re: /\b(tours?|walking tours?|architect(ure|ural)?|heritage|histor(y|ic|ical)|doors open)\b/i },
  { name: 'skating', category: 'outdoors', art: 'art-skates', re: /\bskat(e|es|ing)\b/i },
  { name: 'hike', category: 'outdoors', art: 'art-boots', re: /\b(hik(e|es|ing)|treks?)\b/i },
  { name: 'run', category: 'outdoors', art: 'art-run',
    re: /\b(run club|fun run|\d+ ?k (run|race)|marathons?|running)\b/i },
  { name: 'bike', category: 'outdoors', art: 'art-bicycle', re: /\b(bikes?|cycl(ing|ists?)|bicycles?)\b/i },
  { name: 'birds', category: 'outdoors', art: 'art-birdhouse', re: /\bbird(s|ing|watching)?\b/i },
  { name: 'paddle', category: 'outdoors', art: 'art-outdoors', re: /\b(canoe(ing)?|kayak(ing)?|paddl(e|ing)|swim(s|ming)?)\b/i },
  { name: 'outdoors', category: 'outdoors', art: 'art-trailsign',
    re: /\b(nature|ravines?|parks?|gardens?|trails?|walks?|walking|forests?|beach(es)?|outdoors?)\b/i },
  { name: 'civic', category: 'social', art: 'art-civic',
    re: /\b(town halls?|civic|democracy|community meetings?)\b/i },
  { name: 'social', category: 'social', art: 'art-social',
    re: /\b(meet[- ]?ups?|trivia|quiz|games? nights?|board games?|socials?|singles|language exchange)\b/i },
];

/* A venue's name, when the page says nothing else. Only kinds of room that
   are one thing: "The Concert Hall" is a music room; "Isabel Bader Theatre"
   has comedy on some nights, so it only counts once everything above has
   had its turn. */
const VENUE_RULES = [
  { name: 'venue: music room', category: 'music', art: 'art-music', re: /\b(concert hall|music hall|opera house)\b/i },
  { name: 'venue: cinema', category: 'film', art: 'art-film', re: /\b(cinema|cinematheque)\b/i },
  { name: 'venue: gallery', category: 'art', art: 'art-gallery', re: /\bgaller(y|ies)\b/i },
  { name: 'venue: museum', category: 'museum', art: 'art-museum', re: /\bmuseum\b/i },
  { name: 'venue: bookshop', category: 'books', art: 'art-books', re: /\b(book ?shop|book ?store|library)\b/i },
  { name: 'venue: theatre', category: 'stage', art: 'art-stage', re: /\b(theat(re|er)|playhouse)\b/i },
];

export const DEFAULT = { name: 'default', category: 'dropin', art: 'art-dropin' };

const hit = (rule, t, d) => (rule.test ? rule.test(t, d) : rule.re.test(t));

export function classifyEventbriteEvent(raw) {
  const title = String(raw.title ?? '');
  const desc = String(raw.description ?? '');
  const venue = String(raw.venue ?? '');
  const pick = (r) => ({ category: r.category, art: r.art, rule: r.name });
  for (const r of RULES) if (hit(r, title, desc)) return pick(r);
  for (const r of RULES) if (!r.test && r.re.test(desc)) return pick(r);
  for (const r of VENUE_RULES) if (r.re.test(venue)) return pick(r);
  return pick(DEFAULT);
}

/* Every drawing and category the classifier can hand out, for the suite. */
export const CLASSIFIER_OUTPUTS = [...RULES, ...VENUE_RULES, DEFAULT]
  .map(({ name, category, art }) => ({ name, category, art }));

/* ------------------------------------------------------------- the vetting */

/* Called by normalize with the raw event (title already cleaned). Returns
   { reject: why } or what normalize should publish in place of its own
   defaults: { category, art, entry, address }. */
const quote = (m) => `“${m[0]}”`;

/* The title-only part of the gate, which the listing page can already
   answer: an event it rules out is not worth fetching. run.mjs asks this
   before following a link (source.skipBeforeFollow), so a symposium costs
   Eventbrite no page load and still shows up in the report with its reason. */
export function titleProblem(title) {
  let m;
  if ((m = NETWORKING.exec(String(title ?? '')))) return `business or networking event (title says ${quote(m)})`;
  if ((m = PROFESSIONAL_TITLE.exec(String(title ?? '')))) return `conference, summit or professional event (title says ${quote(m)})`;
  return null;
}

/* Eventbrite describes a recurring event two ways on one page: a node for
   the date you are looking at, and a node for the whole series — "MOODY
   OFFICE: Caribbean Jazz Lounge", April 5 to December 27, which is a
   Sunday night, not a nine-month run. Past two weeks a span is a series, and
   the dated node beside it is the listing. */
const SERIES_DAYS = 14;

export function vetEventbrite(raw) {
  const title = String(raw.title ?? '');
  const desc = String(raw.description ?? '');

  if (/OnlineEventAttendanceMode$/i.test(String(raw.attendanceMode ?? ''))) {
    return { reject: 'online only (eventAttendanceMode)' };
  }
  const byTitle = titleProblem(title);
  if (byTitle) return { reject: byTitle };
  let m;
  if ((raw.types ?? []).includes('BusinessEvent')) return { reject: 'Eventbrite files it as a BusinessEvent' };
  if ((m = PROFESSIONAL_DESCRIPTION.exec(desc))) return { reject: `conference or professional event (description says ${quote(m)})` };

  const start = String(raw.startDate ?? '').slice(0, 10);
  const end = String(raw.endDate ?? '').slice(0, 10);
  const span = start && end ? (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000 : 0;
  if (span > SERIES_DAYS) return { reject: `a recurring series (${start} to ${end}), not one event` };

  const elsewhere = cityProblem(raw);
  if (elsewhere) return { reject: elsewhere };

  const price = eventbritePrice(raw.offers);
  if (!price.entry) return { reject: price.why };

  /* The page's streetAddress already reads "93 Charles St W, Toronto, ON
     M5S 2C7"; joined to locality and region it said Toronto twice. */
  const street = String(raw.streetAddress ?? '').trim();
  const locality = String(raw.locality ?? '').trim();
  const address = street
    ? (locality && !street.toLowerCase().includes(locality.toLowerCase()) ? `${street}, ${locality}, ON` : street)
    : null;

  const { category, art } = classifyEventbriteEvent(raw);
  return { category, art, entry: price.entry, ...(address ? { address } : {}) };
}
