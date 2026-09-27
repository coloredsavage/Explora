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

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NETWORKING } from './filters.mjs';

/* ------------------------------------------------------------------ gates */

/* The conference end of the feed, which Luma's list was never written for:
   'Ted Rogers Centre for Heart Research: 2026 Heart Failure Symposium',
   'Young Professionals Leadership Summit 2026', 'Global Data Centre & Cloud
   Expo Canada'. Stems and plurals, because Eventbrite titles are written
   by thousands of people and none of them agree on either. */
export const PROFESSIONAL_TITLE = new RegExp('\\b(' + [
  /* "Summit" is a business word in a title — 'The Small Business Summit' —
     unless it is the top of something: 'Hike to the Summit'. */
  'symposi(um|ums|a)', 'conferences?', '(?<!\\bthe )summits?', 'keynotes?',
  'professional development', '(young )?professionals', 'trade ?shows?',
  'seminars?', 'webinars?', 'leadership', 'entrepreneur(s|ship|ial)?',
  'investors?', 'investing', 'real estate', 'small business(es)?',
  'business (leaders?|owners?|event|events|network(ing)?|growth|awards?|breakfast|luncheon|lunch)',
  'executives?', 'ceos?', 'sales (training|summit|kickoff)', 'certification', 'accreditation',
  'cpd', 'ceus?', 'continuing education', 'industry night',
  'data (centre|center)s?', 'cloud (computing|expo|summit)', 'cyber ?security', 'blockchain', 'crypto',
  /* An expo, convention or forum on its own is as likely to be a comic
     expo, an anime convention or a community forum on transit as a trade
     show, so those words only count when an industry qualifies them:
     'Global Data Centre & Cloud Expo', 'Franchise Expo', 'Career Fair'. */
  '(tech|technology|industry|trade|b2b|business|franchise|fintech|ai|it|saas|data|cloud|cyber|supply chain|logistics|manufacturing|construction|mining|energy|healthcare|health ?tech|pharma|medical|dental|hr|payroll|insurance|mortgage|wealth|career|job|hiring) (expos?|conventions?|forums?|fairs?)',
].join('|') + ')\\b', 'i');

/* Titles that name nothing but a brand — 'researchED Toronto - From
   Evidence to More Equitable Outcomes' — give themselves away in the first
   line of the page instead: "world-class keynote speakers and educators".
   Narrower than the title list, because prose mentions things in passing. */
/* Not "conference" or "summit": in prose those are a hike reaching the
   summit, or a band that played a conference once. They stay in the title
   list, where 'Small Business Summit' is what they mean. */
export const PROFESSIONAL_DESCRIPTION = /\b(keynotes?|professional development|continuing education|cpd (credits|hours)|ceus?|networking (event|events|opportunit(y|ies)|reception|session|lunch|breakfast)|symposi(um|a)|trade shows?|b2b|thought leaders?|industry leaders|c-suite)\b/i;

/* Toronto as the city draws it. normalize.mjs's IN_TOWN also accepts
   Mississauga — on purpose, because Luma's Salmon Run Hike on the Credit is
   on the board through it — which is how 'DOC Wine Imports Annual Portfolio
   Wine Tasting' at 3045 Southcreek Road, Mississauga got through. For
   Eventbrite, which lists the whole GTA, the page's own addressLocality
   decides, and only the city and its former boroughs count. */
const TORONTO_LOCALITY = /^(toronto|old toronto|downtown toronto|scarborough|etobicoke|north york|east york|york)$/i;
const ELSEWHERE = /^(mississauga|brampton|vaughan|markham|richmond hill|oakville|burlington|hamilton|milton|pickering|ajax|whitby|oshawa|newmarket|aurora|king city|caledon|concord|woodbridge|thornhill|maple|stouffville|halton hills|georgetown|bolton|niagara.*|kitchener|waterloo|guelph|barrie)$/i;

/* addressLocality as organisers type it: "Toronto, ON", "Toronto, Ontario,
   Canada", "City of Toronto". Only the municipality is compared. */
export function localityName(value) {
  let s = String(value ?? '').trim();
  for (let prev = null; prev !== s;) {
    prev = s;
    s = s.replace(/\s*,?\s*\b(on|ont|ontario|canada)\.?\s*$/i, '').trim();
  }
  return s.replace(/^(the\s+)?city\s+of\s+/i, '').trim();
}

function cityProblem(raw) {
  const given = String(raw.locality ?? '').trim();
  const locality = localityName(given);
  if (locality) return TORONTO_LOCALITY.test(locality) ? null : `not in Toronto (${given})`;
  /* No locality: look for a municipality standing as its own part of the
     address, so "Markham St, Toronto" is still Toronto and "…, Markham, ON"
     is not. */
  const parts = String(raw.address ?? '').split(',')
    .map((p) => localityName(p.replace(/\b[A-Z]\d[A-Z]\s*\d[A-Z]\d\b/i, '').replace(/\b(on|ont|ontario)\b/i, '').trim()));
  const other = parts.find((p) => ELSEWHERE.test(p));
  if (other) return `not in Toronto (${other})`;
  if (!parts.some((p) => TORONTO_LOCALITY.test(p))) return `no Toronto locality in the address (${raw.address ?? 'none'})`;
  return null;
}

/* ------------------------------------------------------------------ price */

/* One price field, read strictly. Returns null when the field is absent,
   { n } for a number this can stand behind, or { bad } saying why not.

   The first version stripped everything but digits and dots and called the
   rest a number: 'TBD' and '' came out as 0 and so as Free, '-5' as $5 and
   '12,50' as $1250. An unreadable price is unreadable, never Free. A comma
   decimal ('12,50') is read as one; a thousands comma ('1,250.00') as one;
   anything else with a comma, and anything negative, is refused. */
export function readAmount(v) {
  if (v === undefined || v === null) return null;
  const shown = JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { bad: `an unreadable price (${shown})` };
    return v < 0 ? { bad: `a negative price (${shown})` } : { n: v };
  }
  if (typeof v !== 'string') return { bad: `an unreadable price (${shown})` };
  let s = v.trim();
  if (!s) return { bad: 'an empty price ("")' };
  /* A sign either side of the currency mark: '-5', '-$5', '$-5'. */
  const SIGN = /^[-\u2212\u2013]\s*/;
  let negative = SIGN.test(s);
  s = s.replace(SIGN, '')
    .replace(/^(?:CA\$|C\$|CAD\s*\$?|\$)\s*/i, '')
    .replace(/\s*CAD$/i, '')
    .trim();
  if (SIGN.test(s)) {
    if (negative) return { bad: `an unreadable price (${shown})` };
    negative = true;
    s = s.replace(SIGN, '');
  }
  let n = null;
  let m;
  if (/^\d+(\.\d+)?$/.test(s)) n = Number(s);
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) n = Number(s.replace(/,/g, ''));
  else if ((m = /^(\d+),(\d{1,2})$/.exec(s))) n = Number(`${m[1]}.${m[2]}`);
  if (n === null || !Number.isFinite(n)) return { bad: `an unreadable price (${shown})` };
  if (negative) return { bad: `a negative price (${shown})` };
  return { n };
}
const isZero = (n) => n !== null && n < 0.005;

/* Written the way the rest of the board writes a price: "Free", "$12",
   "$19.70". price.js buckets on the leading "Free" or the first dollar
   figure, and normalize's ceiling reads the same figure. */
export const formatPrice = (n) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`)
  .replace(/\.00$/, '');

const GONE = /(SoldOut|OutOfStock)$/i;

/* The price of an Eventbrite event from its page's offers.
 *
 * Free only when every ticket still on sale is $0. Otherwise the cheapest
 * ticket on sale that costs something — never "$0", and never "Free" for an
 * event whose free tier is a waitlist beside a $50 seat.
 *
 * Eventbrite publishes one AggregateOffer with lowPrice and highPrice and no
 * per-ticket list. That settles two cases: 0–0 is free, and a lowPrice above
 * zero is the cheapest paid ticket. It cannot settle 0–$76: there is a free
 * tier and at least one paid one, and the cheapest paid price is nowhere on
 * the page. That is a price nobody can read, so the event is dropped with
 * that reason rather than published as Free or as a guess.
 *
 * An offer marked SoldOut or OutOfStock is not a price anyone can pay, so it
 * takes no part. An offer with child offers is a summary of them, so the
 * children are read and the summary's own low/high is not; currency and
 * availability pass down from parent to child. Every offer that counts must
 * name its currency, and it must be CAD. One unreadable or negative figure on
 * an offer that counts drops the event: it could be the cheapest ticket.
 *
 * Returns { entry } or { why }. */
export function eventbritePrice(offers) {
  const leaves = [];
  const walk = (o, inherited) => {
    for (const x of [].concat(o ?? [])) {
      if (!x || typeof x !== 'object') continue;
      const ctx = {
        currency: x.priceCurrency ?? inherited.currency,
        availability: x.availability ?? inherited.availability,
      };
      const kids = [].concat(x.offers ?? []).filter((k) => k && typeof k === 'object');
      if (kids.length) walk(kids, ctx);
      else leaves.push({ offer: x, ...ctx });
    }
  };
  walk(offers, {});
  if (!leaves.length) return { why: 'no offers in the event page’s JSON-LD, so no readable price' };

  const open = leaves.filter((l) => !GONE.test(String(l.availability ?? '').trim()));
  if (!open.length) return { why: 'every ticket is sold out or unavailable (SoldOut/OutOfStock)' };

  const tickets = [];            /* individual prices: Offer.price */
  const lows = [];
  const highs = [];
  for (const { offer } of open) {
    for (const [field, into] of [['price', tickets], ['lowPrice', lows], ['highPrice', highs]]) {
      const r = readAmount(offer[field]);
      if (!r) continue;
      if (r.bad) return { why: `${r.bad} in the offers’ ${field}, so no readable price` };
      into.push(r.n);
    }
  }
  const all = [...tickets, ...lows, ...highs];
  if (!all.length) return { why: 'offers carry no readable price' };

  const unnamed = open.find((l) => !String(l.currency ?? '').trim());
  if (unnamed) return { why: 'an offer names no currency (priceCurrency missing), so its price is not known to be dollars' };
  const foreign = open.map((l) => String(l.currency).trim()).find((c) => c.toUpperCase() !== 'CAD');
  if (foreign) return { why: `priced in ${foreign}, not CAD` };

  if (all.every(isZero)) return { entry: 'Free' };

  /* Everything known to be the price of a paid ticket: an individual price
     above zero, or a lowPrice above zero (every ticket costs at least that). */
  const paid = [...tickets, ...lows].filter((n) => !isZero(n));
  const freeTier = [...tickets, ...lows].some(isZero);
  if (freeTier && tickets.filter((n) => !isZero(n)).length === 0) {
    const top = highs.length ? ` (up to ${formatPrice(Math.max(...highs))})` : '';
    return { why: `free and paid tickets${top}; the cheapest paid ticket is not in the offers` };
  }
  if (!paid.length) return { why: 'offers give only a highest price, so the cheapest ticket is not readable' };
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
/* "Book" is also what every ticket page tells you to do. 'Book now', 'Book
   your tickets', 'Book a table' put a costume night and a product launch in
   books, so the word counts only when it is not a booking verb. 'Booking'
   never matched, and still does not. */
const BOOK_WORD = String.raw`(?<!\b(?:to|please|must|and|or|&) )\bbooks?\b(?!\s+(?:now|your|yours|a|an|the|tickets?|seats?|online|here|today|early|ahead|in advance|with us|through|via|at|by)\b)`;
const BOOK_PLACES = String.raw`book ?(?:shops?|stores?|sellers?)`;
const IMPRINTS = String.raw`knopf|penguin random house|penguin|random house|harpercollins|harper ?collins|simon (?:&|and) schuster|house of anansi|anansi|mcclelland(?: (?:&|and) stewart)?|doubleday|coach house|biblioasis|ecw press|arsenal pulp|book\*hug|viking|hamish hamilton|scholastic|hachette|macmillan|farrar|norton|bloomsbury|dundurn|cormorant|goose lane|breakwater|nightwood|talonbooks|invisible publishing`;
const BOOKISH = new RegExp(String.raw`(?:${BOOK_WORD}|\b(?:${BOOK_PLACES}|book ?(?:launch(?:es)?|club|signing)|authors?|novel(?:s|ist|ists)?|memoirs?|poe(?:t|ts|try|ms?)|literary|literature|publish(?:er|ers|ing)|writers?|${IMPRINTS})\b)`, 'i');

/* What makes a launch a book launch: somewhere to buy it, someone who wrote
   it, the kind of book it is, who published it, or "<title> by <Name>". A
   quoted name in the title is not enough on its own — a product launch has
   one too. */
const BOOK_CONTEXT = new RegExp(String.raw`(?:${BOOK_WORD}|\b(?:${BOOK_PLACES}|authors?|co-?authors?|novel(?:s|ist)?|memoirs?|poetry|poems|essays|essay collection|short stories|non-?fiction|fiction|publish(?:er|ers|ed by)|literary|reading and signing|signing|${IMPRINTS})\b)`, 'i');
const BY_NAME = /(?:["“][^"”]{2,}["”]|\blaunch of\b[^.]{2,80}?)\s+by\s+[A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+)+/u;

export const RULES = [
  /* 'Douglas Stuart Toronto launch "John of John"' names neither a book nor
     an author; the page's "Another Story Bookshop and Knopf Canada … the
     launch of John of John by Douglas Stuart" does. */
  { name: 'book launch', category: 'books', art: 'art-books',
    test: (t, d) => /\blaunch(es|ed|ing)?\b/i.test(t)
      && (BOOK_CONTEXT.test(t) || BOOK_CONTEXT.test(d) || BY_NAME.test(t) || BY_NAME.test(d)) },
  { name: 'books', category: 'books', art: 'art-books', re: BOOKISH },
  /* \btalk\b missed 'The Walrus Talks Community Reborn'. */
  { name: 'talk', category: 'stage', art: 'art-lectern',
    re: /\b(talks?|lectures?|panels?|panel discussion|in conversation|conversations? with|speakers?|speaker series|fireside chats?|q ?& ?a|debates?)\b/i },
  /* A comic is a comedian; a comic expo or a comic book is not. */
  { name: 'comedy', category: 'comedy', art: 'art-comedy',
    re: /\b(comed(y|ies|ian|ians)|comic(?!s?[- ](expos?|cons?|conventions?|books?|arts?|strips?|shops?|stores?|fairs?))|stand[- ]?up|improv|sketch (comedy|show)|open mic|roast)\b/i },
  { name: 'film', category: 'film', art: 'art-film',
    re: /\b(films?|screenings?|cinema|movies?|documentar(y|ies))\b/i },
  { name: 'festival', category: 'festival', art: 'art-festival',
    re: /\b(festivals?|fest|parades?|carnivals?|street part(y|ies)|block part(y|ies)|fairs?)\b/i },
  /* 'Toronto Rooftop Day Party', 'WHINE SLOW - Toronto's Sexiest Dancehall &
     Soca Party' — filed as Revival's "Afrobeats & Friends | Amapiano | R&B |
     Dancehall" already is. */
  /* Not every party has decks: a tea party is food, a watch party is film. */
  { name: 'party', category: 'music', art: 'art-decks',
    re: /\b((?<!\b(tea|garden|watch|viewing|pizza|dinner|birthday|slumber|pyjama|pajama|knitting|craft|book|reading|puzzle|potluck|search|lunch|luncheon|picnic|cocktail|dinner) )part(y|ies)|day[- ]?part(y|ies)|djs?|dancehall|soca|bashment|afrobeats?|amapiano|reggaeton|dembow|r&b|rnb|hip[- ]?hop|disco|raves?|club nights?|dance (party|parties|night|nights|floor)|dancefloor|house music|techno|edm|day ?club)\b/i },
  { name: 'classical', category: 'music', art: 'art-violin',
    re: /\b(orchestras?|orchestral|symphon(y|ies|ic)|classical|baroque|chamber (music|ensemble|orchestra)|string quartets?|philharmonic|recitals?|violin(s|ist)?|cellos?|cellist)\b/i },
  { name: 'jazz', category: 'music', art: 'art-jazz-sax',
    re: /\b(jazz|bebop|big band|swing band)\b/i },
  { name: 'blues', category: 'music', art: 'art-blues', re: /\bblues\b/i },
  { name: 'folk', category: 'music', art: 'art-folk',
    re: /\b(folk|bluegrass|singer[- ]songwriters?|acoustic)\b/i },
  /* 'Rock Climbing' and 'Metal Casting Workshop' are not gigs. */
  /* 'ARTCELL – Live in Toronto' is a band ("Doors Open: 6:00 PM Show 7PM");
     'UK Calling - Toronto' says only "alternative 80's show" on its page. */
  { name: 'music', category: 'music', art: 'art-music',
    re: /\b(live music|concerts?|bands?|gigs?|live in (toronto|concert)|in concert|(world|north american|canadian|album|farewell|reunion|anniversary|concert) tour|albums?|singers?|choirs?|choral|operas?|music|musicians?|rock(?![- ]?(climb\w*|gyms?|walls?|painting|hunting|garden|pools?|balancing|collect\w*))|punk|(?<!\b(sheet|scrap|precious) )metal(?![- ]?(casting|work\w*|smith\w*|detect\w*|clay|art|fabricat\w*|jewel\w*|stamping|etching))|indie|tribute|karaoke|(19)?[5-9]0'?s|2000s)\b/i },
  { name: 'stage', category: 'stage', art: 'art-stage',
    re: /\b(theat(re|er|rical)|musicals?|ballet|circus|drag (show|brunch|night)s?|cabaret|burlesque|podcast|magic show|staged reading)\b/i },
  { name: 'food', category: 'food', art: 'art-food',
    re: /\b(tastings?|wines?|beers?|brew(ery|eries|ing|s)?|food|foodies?|culinary|chefs?|croissants?|baguettes?|bak(e|es|ery|eries|ing)|brunch(es)?|dinners?|suppers?|cook(ing|off)?|coffee|teas?|high tea|afternoon tea|cocktails?|whisk(e)?y|cheese|pizza|tacos?|dumplings?|picnics?)\b/i },
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
   Sunday night, not a nine-month run. Past two weeks a span is a series
   whatever else is on the page, and vet drops it. */
const SERIES_DAYS = 14;

const dayOf = (v) => String(v ?? '').slice(0, 10);
const spanOf = (raw) => {
  const start = dayOf(raw.startDate);
  const end = dayOf(raw.endDate);
  if (!start || !end) return 0;
  const d = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000;
  return Number.isFinite(d) ? d : 0;
};

/* A short series is the same thing at a smaller scale: a three-night run's
   series node, October 1 to 3, next to the dated node for October 1 would put
   a range card for the run on the board beside the night's own card. So of
   nodes describing one event, a node whose dates span more than a day and
   contain another node's date is the series, and the dated node is the
   listing.

   Called by harvest (source.pageNodes) twice: with every Event node read from
   one page, and — because Eventbrite also links the series and the dated
   occurrence as two event pages with two numbers, as the live listing did
   for MOODY OFFICE on 2026-09-27 — with the published listings of one title
   at one venue across the source's pages.
   Returns { keep, dropped: [{ title, why, node }] }. */
export function settlePageNodes(raws) {
  if (!Array.isArray(raws) || raws.length < 2) return { keep: raws ?? [], dropped: [] };
  const keep = [];
  const dropped = [];
  for (const r of raws) {
    const start = dayOf(r.startDate);
    const end = dayOf(r.endDate);
    const dated = spanOf(r) > 0 && raws.find((o) => o !== r
      && dayOf(o.startDate) >= start && dayOf(o.startDate) <= end
      && spanOf(o) < spanOf(r));
    if (dated) {
      dropped.push({ title: r.title ?? '(untitled)', node: r,
        why: `series node (${start} to ${end}) beside its dated node (${dayOf(dated.startDate)}); the dated one is the listing` });
    } else keep.push(r);
  }
  return { keep, dropped };
}

/* ----------------------------------------------------- already hand-listed */

/* data.js carries some Eventbrite events by hand — The Reheat Podcast, with
   a `submitted` partner tag — and app.js concatenates the hand-written list
   and scraped.js without deduping. So an event whose url, or whose event
   number (the trailing digits of /e/…-tickets-<id>), already appears in
   data.js is not scraped again. */
const DATA_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data.js');

export function eventbriteId(url) {
  try {
    const u = new URL(String(url ?? '').trim());
    if (!/(^|\.)eventbrite\.[a-z.]+$/i.test(u.hostname)) return null;
    return /\/e\/[^/]*?-(\d{6,})\/?$/.exec(u.pathname)?.[1] ?? null;
  } catch { return null; }
}
const bareUrl = (url) => {
  try {
    const u = new URL(String(url ?? '').trim());
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}`;
  } catch { return null; }
};

/* Every Eventbrite url and event number in a copy of data.js. */
export function handListedIndex(text) {
  const urls = new Set();
  const ids = new Set();
  for (const m of String(text ?? '').matchAll(/https?:\/\/(?:www\.)?eventbrite\.[a-z.]+\/e\/[^\s'"`<>)]+/gi)) {
    const b = bareUrl(m[0]);
    if (b) urls.add(b);
    const id = eventbriteId(m[0]);
    if (id) ids.add(id);
  }
  return { urls, ids };
}

let handListed = null;
const handIndex = () => {
  if (!handListed) {
    try { handListed = handListedIndex(readFileSync(DATA_JS, 'utf8')); }
    catch { handListed = { urls: new Set(), ids: new Set() }; }
  }
  return handListed;
};

/* The drop reason, or null. */
export function alreadyHandListed(url, index = handIndex()) {
  if (!url) return null;
  const id = eventbriteId(url);
  if ((id && index.ids.has(id)) || index.urls.has(bareUrl(url))) {
    return `already hand-listed in data.js (event ${id ?? bareUrl(url)})`;
  }
  return null;
}

/* What the listing page alone can rule out, before a page is fetched. */
export const skipBeforeFollow = (listed) => alreadyHandListed(listed?.url) ?? titleProblem(listed?.title);

export function vetEventbrite(raw) {
  const title = String(raw.title ?? '');
  const desc = String(raw.description ?? '');

  if (/OnlineEventAttendanceMode$/i.test(String(raw.attendanceMode ?? ''))) {
    return { reject: 'online only (eventAttendanceMode)' };
  }
  const hand = alreadyHandListed(raw.url);
  if (hand) return { reject: hand };
  const byTitle = titleProblem(title);
  if (byTitle) return { reject: byTitle };
  let m;
  if ((raw.types ?? []).includes('BusinessEvent')) return { reject: 'Eventbrite files it as a BusinessEvent' };
  if ((m = PROFESSIONAL_DESCRIPTION.exec(desc))) return { reject: `conference or professional event (description says ${quote(m)})` };

  const span = spanOf(raw);
  if (span > SERIES_DAYS) return { reject: `a recurring series (${dayOf(raw.startDate)} to ${dayOf(raw.endDate)}), not one event` };

  const elsewhere = cityProblem(raw);
  if (elsewhere) return { reject: elsewhere };

  const price = eventbritePrice(raw.offers);
  if (!price.entry) return { reject: price.why };

  /* The page's streetAddress already reads "93 Charles St W, Toronto, ON
     M5S 2C7"; joined to locality and region it said Toronto twice. */
  const street = String(raw.streetAddress ?? '').trim();
  /* "Toronto, ON" or "City of Toronto" as the locality is joined as
     Toronto, so the card does not read "Toronto, ON, ON". */
  const locality = localityName(raw.locality);
  const address = street
    ? (locality && !street.toLowerCase().includes(locality.toLowerCase()) ? `${street}, ${locality}, ON` : street)
    : null;

  const { category, art } = classifyEventbriteEvent(raw);
  return { category, art, entry: price.entry, ...(address ? { address } : {}) };
}
