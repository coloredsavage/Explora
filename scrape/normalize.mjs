/* Raw extraction -> the shape data.js speaks, or nothing at all.
 *
 * Everything here is a gate. An entry that cannot be described honestly —
 * no title, no date, no venue — is dropped rather than published half-known,
 * which is the same standard the hand-written listings are held to. */

const slug = (s) => s.toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '')
  .slice(0, 48);

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/* This is a Toronto calendar. A source can list anywhere — Wygo's first two
   hits were in Waterloo — so an address has to place the event in the city
   before it earns a card. */
const IN_TOWN = /\b(toronto|scarborough|etobicoke|north york|east york|york, on|mississauga|the islands|toronto islands)\b/i;

/* "TBD", "TBA", "Somewhere spooky in Kitchener-Waterloo" — a string is not an
   address just because it is non-empty. */
const PLACEHOLDER = /^\s*(tbd|tba|to be (announced|confirmed|determined)|unknown|n\/?a|various|somewhere\b.*)\s*$/i;

/* A calendar that answers "what should we do today" has no use for a webinar. */
const NOT_A_PLACE = /\b(online|virtual|webinar|zoom|livestream|remote|anywhere)\b/i;

/* Some things a venue publishes are announcements that there is nothing on.
   The Bentway posts "Skate Trail Closed" as an event, which is the precise
   opposite of one, and it was reaching the board. This is not per-source:
   nowhere is a closure something to do. A "closing party" or "closing night"
   is, so the word alone is not enough. */
const NOT_AN_EVENT = /\b(closed|closure|cancelled|canceled|postponed|sold out|rescheduled)\b/i;
const IS_AN_EVENT_ANYWAY = /\b(closing (party|night|reception|weekend)|close[sd]? out)\b/i;

/* "Toronto, ON" in the venue field is the city, not a place to meet. The card
   would read "Where: Toronto, ON, Toronto, ON". */
const CITY_ONLY = /^\s*(toronto|scarborough|etobicoke|north york|east york|ontario|canada|downtown( toronto)?)(\s*,\s*(on|ont|ontario|canada))*\s*$/i;

/* "250 Fort York Blvd, Toronto, ON M5V 3K9" -> "Toronto, ON". The postal code
   is deliberately left behind: it belongs to the source's own front door, not
   to whatever address is being repaired with it. */
function cityOf(defaultAddress) {
  if (!defaultAddress || !IN_TOWN.test(defaultAddress)) return null;
  const parts = defaultAddress.split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const city = parts[1];
  const region = (parts[2] || '').replace(/\s*[A-Z]\d[A-Z]\s*\d[A-Z]\d\s*$/i, '').trim();
  return region ? `${city}, ${region}` : city;
}

const asDate = (v) => {
  if (!v) return null;
  const d = String(v).slice(0, 10);
  return ISO.test(d) ? d : null;
};

/* A page title is often "The Audition — Bad Dog Theatre Company - Toronto's
   Best Improv": the event, then the site's name bolted on. Strip the tail
   only when it actually names the source, so a title that legitimately
   contains a dash keeps it. */
export function stripSiteSuffix(title, sourceName) {
  if (!sourceName) return title;
  const words = sourceName.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (!words.length) return title;
  const parts = title.split(/\s+[—–|]\s+/);
  if (parts.length < 2) return title;
  const head = parts[0].trim();
  const tail = parts.slice(1).join(' ').toLowerCase();
  const namesTheSource = words.every((w) => tail.includes(w));
  return namesTheSource && head.length >= 3 ? head : title;
}

export function normalize(raw, source, { today, checked }) {
  const title = stripSiteSuffix((raw.title ?? '').trim(), source.name);
  const start = asDate(raw.startDate);
  const end = asDate(raw.endDate);
  const venue = (raw.venue ?? source.defaultVenue ?? '').trim();
  let address = dedupeAddress(venue, (raw.address ?? source.defaultAddress ?? '').trim());

  const reject = (why) => ({ ok: false, why, title: title || '(untitled)' });

  if (!title) return reject('no title');
  if (source.exclude && source.exclude.test(title)) return reject('excluded by this source’s filter');
  if (!start) return reject('no usable start date');
  if (start < today) return reject(`already past (${start})`);
  if (!venue) return reject('no venue');
  if (PLACEHOLDER.test(venue)) return reject(`placeholder venue (${venue})`);
  if (CITY_ONLY.test(venue)) return reject(`venue is just the city (${venue})`);
  if (!address) return reject('no address');
  if (PLACEHOLDER.test(address)) return reject(`placeholder address (${address})`);
  if (NOT_A_PLACE.test(`${address} ${venue}`)) return reject(`not somewhere you can go (${venue})`);
  if (NOT_AN_EVENT.test(title) && !IS_AN_EVENT_ANYWAY.test(title)) return reject('an announcement that nothing is on');
  /* A page often gives a bare street address — "250 Fort York Blvd" — and the
     gate below reads the missing city as a missing Toronto. When the source
     is itself a Toronto venue, by its own defaultAddress, a bare address from
     it is a Toronto address, and the city is added so the card and its map
     link both read properly. The Bentway was losing every listing to this.
     Sources that range across the region carry no default — Wygo's first two
     hits were in Waterloo — so they are unaffected and still rejected. */
  if (!IN_TOWN.test(`${address} ${venue}`)) {
    const city = cityOf(source.defaultAddress);
    if (!city) return reject(`not in Toronto (${address})`);
    address = `${address}, ${city}`;
  }
  if (end && end < start) return reject('ends before it starts');

  const schedule = end && end !== start
    ? { kind: 'range', start, end }
    : { kind: 'day', date: start, ...(raw.time ? { time: raw.time.trim() } : {}) };

  return {
    ok: true,
    event: {
      id: `${source.id}-${slug(title)}-${start}`,
      title,
      category: source.category,
      art: source.art,
      ...(raw.entry ? { entry: tidyPrice(raw.entry) } : {}),
      venue,
      address,
      url: raw.url ?? source.url,
      source: raw.url ?? source.url,
      checked,
      description: trimDescription(raw.description ?? '') || `Listed by ${source.name}.`,
      schedule,
      scrapedFrom: source.id,
      via: raw.via,
    },
  };
}

/** Last line of defence before anything is written out. */
const tidyPrice = (s) => s.trim().replace(/(\$\d+)\.00\b/g, '$1');

/* Listings repeat the venue into the address — "Mentimeter North America Inc,
   Mentimeter North America Inc, Toronto". The card prints both, so strip the
   repetition rather than show it twice. */
function dedupeAddress(venue, address) {
  const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (norm(address) === norm(venue)) return address;   /* nothing else to show */

  const v = norm(venue);
  if (v && norm(address).startsWith(v)) {
    const cut = address.replace(/^\s*/, '').slice(venue.length).replace(/^[\s,–—-]+/, '');
    if (cut) return cut;
  }
  return address;
}

/* Event pages write to sell. The hand-written listings are a sentence or two,
   and a wall of marketing copy next to them looks like a different site. Keep
   whole sentences, and only as many as fit. */
function trimDescription(text, limit = 220) {
  let s = String(text)
    /* Some feeds escape their newlines twice, so the text arrives carrying a
       literal backslash-n rather than a line break. Collapsing whitespace
       cannot see those. */
    .replace(/\\[nrt]/g, ' ')
    /* And some arrive with their entities half-eaten — the library's feed
       says "PowerPointnbsp;classes.nbsp;", an &nbsp; that lost both ends
       somewhere upstream. Left alone it reads as a typo in the middle of a
       sentence on the card. */
    .replace(/&?nbsp;?/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/^\s*\[[^\]]*\]\s*/, '')          /* a leading "[Note: ...]" aside */
    .replace(/\s*\(https?:\/\/[^)]+\)/g, '')     /* inline link parentheses */
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= limit) return s;

  const sentences = s.split(/(?<=[.!?])\s+/);
  let out = '';
  for (const sentence of sentences) {
    if (out && (out + ' ' + sentence).length > limit) break;
    out = out ? out + ' ' + sentence : sentence;
    if (out.length >= limit) break;
  }
  /* One sentence can be longer than the whole budget — the loop above always
     takes the first, so cut it back to a word boundary. */
  if (out.length > limit) out = out.slice(0, limit).replace(/\s+\S*$/, '');

  return out.length < s.length ? out.replace(/[\s.,;:]+$/, '') + '…' : out;
}

export function validate(event) {
  const problems = [];
  const need = ['id', 'title', 'category', 'venue', 'address', 'url', 'source', 'checked', 'description'];
  for (const k of need) if (!event[k]) problems.push(`missing ${k}`);

  const s = event.schedule;
  if (!s) problems.push('missing schedule');
  else if (s.kind === 'day' && !ISO.test(s.date)) problems.push('bad day date');
  else if (s.kind === 'range' && !(ISO.test(s.start) && ISO.test(s.end))) problems.push('bad range');
  else if (!['day', 'range'].includes(s.kind)) problems.push(`unexpected kind ${s.kind}`);

  if (/[<>]/.test(event.title + event.description)) problems.push('markup leaked into text');
  return problems;
}
