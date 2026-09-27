import { matchArt, variantOf } from './art-match.mjs';

/* Raw extraction -> the shape data.js speaks, or nothing at all.
 *
 * Everything here is a gate. An entry that cannot be described honestly —
 * no title, no date, no venue — is dropped rather than published half-known,
 * which is the same standard the hand-written listings are held to. */

const slug = (s) => s.toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '')
  .slice(0, 48);

/* Entities arrive in every field, not only the prose, and this was only ever
   applied to the prose. Bad Dog's titles come through as "Narrative Process
   &amp; Sweet Sweet Friends", so the entity reached the card, the slug and
   the event page's URL, while the description beside it read correctly. One
   decoder, used by every field that reaches a card.

   The named list alone was not enough. WordPress writes the numeric forms —
   Grossman's Tavern lists "The Swingin&#8217; Blackjacks" and "Sat &#038;
   Sun", and its zero-padded &#039; does not match a rule looking for &#39;.
   So numerics are decoded by value rather than enumerated.

   Decoding &lt; and &gt; here is safe, and worth saying why: nothing renders
   these as markup. app.js puts a title on the page with textContent, and
   build-seo escapes every field through esc() on its way into HTML. A title
   is data all the way to the edge; this only stops the entity being printed
   at a reader. */
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026',
  laquo: '\u00AB', raquo: '\u00BB', deg: '\u00B0',
};

/* A codepoint that is not printable is worse than the entity that named it,
   so anything in the control ranges is left exactly as it arrived. */
const codepoint = (n, original) => {
  if (!Number.isInteger(n) || n < 32 || (n >= 127 && n < 160) || n > 0x10ffff) return original;
  try { return String.fromCodePoint(n); } catch { return original; }
};

const decodeEntities = (s) => String(s)
  /* Some feeds escape their newlines twice, so the text arrives carrying a
     literal backslash-n rather than a line break. Collapsing whitespace
     cannot see those. */
  .replace(/\\[nrt]/g, ' ')
  /* And some arrive with their entities half-eaten — the library's feed
     says "PowerPointnbsp;classes.nbsp;", an &nbsp; that lost both ends
     somewhere upstream. Left alone it reads as a typo in the middle of a
     sentence on the card. */
  .replace(/&?nbsp;?/g, ' ')
  /* Ampersand first, so a double-encoded "&amp;#039;" gets down to an
     apostrophe rather than stopping half way. */
  .replace(/&amp;/g, '&')
  .replace(/&#(\d+);/g, (m, n) => codepoint(Number(n), m))
  .replace(/&#x([0-9a-f]+);/gi, (m, n) => codepoint(parseInt(n, 16), m))
  .replace(/&([a-z]+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m);

/* A single-line field: decoded, and with the whitespace an entity may have
   just turned into a space collapsed back down. */
const clean = (s) => decodeEntities(s ?? '').replace(/\s+/g, ' ').trim();

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/* The site's own promise is "free, cheap, or at least worth the fare", and
   nothing in here was holding the poller to it — a $50 workshop had made the
   board. Whether something dear is worth the fare is a judgement, and the
   hand-written listings in data.js make it: Art Toronto at $35 and TIFF at
   $30 are there because someone decided they were worth it. Nothing here
   touches those. This is only the gate on what arrives automatically, which
   should not be quietly adding things the calendar would not have chosen.
   Above this, a listing is reported as dropped rather than published. */
const CEILING = 35;

/* Counting a run in progress as current is right, and it let in something
   that is not an event: the Bentway's "Waterfront ReConnect" pieces run from
   December 2023 to March 2027, so they would answer "what should we do
   today" every day for three more years and crowd out the things that only
   happen once.

   The line has to go somewhere, and the hand-written listings say where. The
   longest run anyone has chosen to put on this board by hand is 295 days —
   an exhibition — so a year and a bit is comfortably above every editorial
   decision already made and comfortably below a permanent installation.
   Above this a listing is reported as dropped, not published. */
const LONGEST_RUN_DAYS = 400;

/* The same reading as priceOf in price.js: a line starting "Free", or
   pay-what-you-can, is free whatever else it mentions, and otherwise the
   first dollar figure is the door price. */
function tooDear(entry) {
  const t = String(entry ?? '').trim().toLowerCase();
  if (!t) return null;
  if (t.startsWith('free')) return null;
  if (/pay[- ]what[- ]you[- ](can|want|wish|choose)|\bpwyc\b/.test(t)) return null;
  const m = t.match(/\$\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return n > CEILING ? n : null;
}

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

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

/* normalize itself only ever accepts ISO, and that strictness is the point:
   a date it cannot read is a listing it drops rather than guesses at. But a
   JSON API is not obliged to send ISO — the Bentway's ACF fields say
   "September 19, 2026" — so an adapter needs somewhere to turn a written
   date into one this file will take. Written dates only; anything ambiguous
   between day-first and month-first is refused rather than guessed. */
export function asIsoDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (ISO.test(s.slice(0, 10))) return s.slice(0, 10);

  const m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s);
  if (!m) return null;
  const month = MONTHS.findIndex((name) => name.startsWith(m[1].toLowerCase()));
  if (month < 0) return null;
  const day = Number(m[2]);
  if (day < 1 || day > 31) return null;
  const iso = `${m[3]}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  /* A date that does not exist — February 31 — round-trips to something
     else through Date, so check rather than trust it. */
  const back = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(back.getTime()) || back.toISOString().slice(0, 10) !== iso ? null : iso;
}

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
  const title = stripSiteSuffix(clean(raw.title), source.name);
  const start = asDate(raw.startDate);
  const end = asDate(raw.endDate);
  const venue = clean(raw.venue ?? source.defaultVenue);
  let address = dedupeAddress(venue, clean(raw.address ?? source.defaultAddress));

  const reject = (why) => ({ ok: false, why, title: title || '(untitled)' });

  if (!title) return reject('no title');
  if (source.exclude && source.exclude.test(title)) return reject('excluded by this source’s filter');
  if (FOR_CHILDREN.test(title) || FOR_CHILDREN.test(String(raw.description ?? ''))) {
    return reject('programming for children');
  }
  if (!start) return reject('no usable start date');
  /* A run that began before today and has not finished is on today, which
     is the question this calendar answers. Comparing the start alone threw
     away every exhibition and every festival already under way: Public Pier
     runs September 18th to October 3rd and was refused on the 19th for
     having started on the 18th. What makes something past is its last day,
     not its first.

     An end before the start is nonsense rather than a long run, so it does
     not extend anything; the gate further down rejects that outright. */
  const lastDay = end && end >= start ? end : start;
  if (lastDay < today) return reject(`already past (${lastDay})`);

  const runDays = Math.round((Date.parse(`${lastDay}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000);
  if (runDays > LONGEST_RUN_DAYS) return reject(`runs ${runDays} days — a fixture, not an event`);
  if (!venue) return reject('no venue');
  if (PLACEHOLDER.test(venue)) return reject(`placeholder venue (${venue})`);
  if (CITY_ONLY.test(venue)) return reject(`venue is just the city (${venue})`);
  if (!address) return reject('no address');
  if (PLACEHOLDER.test(address)) return reject(`placeholder address (${address})`);
  if (NOT_A_PLACE.test(`${address} ${venue}`)) return reject(`not somewhere you can go (${venue})`);
  if (NOT_AN_EVENT.test(title) && !IS_AN_EVENT_ANYWAY.test(title)) return reject('an announcement that nothing is on');

  const dear = tooDear(raw.entry);
  if (dear) return reject(`$${dear} is past what this calendar is for`);
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
      /* The source's symbol is the fallback, not the answer. Stamping one
         per source is how every Bentway event became a roller skate,
         including an artist talk; see art-match.mjs. */
      art: matchArt(raw) ?? variantOf(source.art, title),
      ...(raw.entry ? { entry: tidyPrice(raw.entry) } : {}),
      venue,
      address,
      ...(raw.image ? { image: raw.image } : {}),
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

/* Two listings that the dedupe deliberately kept apart can still arrive with
   the same id, because the key it collapses on carries the venue and the id
   does not — the id is source, title and date. The Bentway's "Public Trust"
   arrives three times on one day: the umbrella listing, the library's day of
   it, and the after-school strand, at three addresses. Three listings by the
   key, one id between them.

   An id is not decoration. build-seo writes each event to /event/<id>/ and
   app.js dedupes the board on it, so two of those three were overwritten at
   build time and dropped at render time. Nobody saw them.

   Where an id is shared, the venue that already told the listings apart goes
   into it. An id that collides with nothing is left exactly as it was, so no
   event page that has already been published moves. Mutates in place and
   returns what it changed, for the run's report. */
/* One event, published by one source across several of its own pages.

   The Bentway put Public Trust on five: the project page, the library page, an
   after-school page, the index, and a dated one. Title-and-date-and-venue told
   them apart — correctly, by its own rule, because two things sharing a name on
   one day at different addresses are usually two things. Here they were one,
   and the board showed the same name twice on the same day.

   Two ways a listing can be a lesser copy of another:

   Containment. A shorter title that is the start of a longer one, at a venue
   the other already names — "Public Trust" against "Public Trust — Toronto
   Public Library, Fort York branch", whose venue list contains the first's.
   Two genuinely different events at two venues never satisfy this: neither
   venue contains the other.

   Depth. A listing whose url sits at the top of the site never reached an
   event page of its own; it is the index's one-line version. The Bentway's
   index gave the Paul Ramírez Jonas talk the venue "The Bentway" and no time,
   while its own page gave the library branch and 6–7:30pm, and neither venue
   string contains the other — so containment alone kept two copies of one
   talk. Identical title, identical schedule, same source, one of them an index
   line: the same event, described worse. Two real events sharing a name on one
   day would each have their own page, so this cannot merge them.

   Not `source` for that test: a listing's `source` is the page it was read
   from, which for a followed event page is its own url, so comparing the two
   calls everything an index line.

   Same source only. Two sources carrying one event is a different problem,
   left alone, because their titles and venues are written by different people
   and containment means less across them. */
export function collapseSubsumed(events, prefer) {
  const norm = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const dateOf = (e) => e.schedule?.date ?? e.schedule?.start ?? '';
  const covers = (a, b) => {
    const [x, y] = [norm(a), norm(b)];
    return x === y || x.includes(y) || y.includes(x);
  };
  const depth = (e) => (e.url ? e.url.replace(/\/$/, '').split('/').length : 0);
  const shallow = (e) => depth(e) <= 4;

  /* The whole schedule, not just its first day. Grouping on the start alone
     folded a three-week installation into a one-day event at a library that
     opened on the same date, and took the installation's own page with it. */
  const groups = new Map();
  for (const e of events) {
    const s = e.schedule ?? {};
    const k = `${e.scrapedFrom}|${s.kind}|${dateOf(e)}|${s.end ?? ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }

  const dropped = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    /* Longest title first, so a shorter one is always tested against a title
       that could contain it; deepest url first among equals, so the fuller
       copy is the one the others fold into. */
    const order = [...group].sort((a, b) =>
      String(b.title).length - String(a.title).length || depth(b) - depth(a));
    const kept = [];
    for (const e of order) {
      const host = kept.find((k) => (
        (norm(k.title).startsWith(norm(e.title)) && covers(k.venue, e.venue))
        || (norm(k.title) === norm(e.title) && shallow(e) && !shallow(k))
      ));
      if (!host) { kept.push(e); continue; }
      const winner = prefer ? prefer(host, e) : host;
      if (winner !== host) Object.assign(host, winner);
      dropped.push(e);
    }
  }

  if (dropped.length) {
    const gone = new Set(dropped);
    const left = events.filter((e) => !gone.has(e));
    events.length = 0;
    events.push(...left);
  }
  return { dropped: dropped.length };
}

export function disambiguateIds(events) {
  const byId = new Map();
  for (const e of events) {
    if (!byId.has(e.id)) byId.set(e.id, []);
    byId.get(e.id).push(e);
  }

  const shared = [...byId.keys()].filter((id) => byId.get(id).length > 1);
  const taken = new Set([...byId.keys()].filter((id) => byId.get(id).length === 1));
  let changed = 0;

  for (const id of shared) {
    for (const e of byId.get(id)) {
      /* Venue first, and a counter only if that still is not enough: slug()
         truncates at 48 characters, so two long venue names sharing a prefix
         can land on the same suffix. */
      const base = `${id}-${slug(e.venue)}`;
      let next = base;
      for (let n = 2; taken.has(next); n += 1) next = `${base}-${n}`;
      taken.add(next);
      e.id = next;
      changed += 1;
    }
  }

  return { shared, changed };
}

/* The last gate, and the only one that looks beyond a single run.

   For five days the extractor answered 400 to every page it was handed, and
   every one of those was caught per-page and carried past. The run exited 0,
   opened its pull request, and the four sources that need the model were
   simply absent from it — a poll finding 6 events where the one before it
   found 32, reported as a success three times running. Only the fact that
   nobody merged those pull requests kept the board intact.

   Zero events was already guarded, and zero events is not what this looks
   like: whatever still reads for free comes through and carries the run. So
   the comparison that matters is per source and against the last run, rather
   than against nothing. A source that was producing and has stopped is either
   broken or finished for the season, and both want a person to look.

   `before` and `now` are id -> count. Only sources still being polled are
   considered: parking one in sources.mjs is a decision already taken and
   should not fail the next run. `allowed` is the override for a source that
   really has gone quiet. */
/* A source has to have been producing something before its silence means
   anything. The library yields one or two events on a good day and often
   none — its branch addresses vary, so it carries no default and an event
   that does not name its branch is dropped, which is most of them. Going
   from one to zero is noise, and a guard that stops a poll of 190 events
   over it is a guard people will learn to override without reading.

   Three is where a source stops being incidental. The collapse this was
   written for was five, six and nine going to nothing at once. */
const A_REAL_BASELINE = 3;

export function silentSources(before, now, enabled, allowed = new Set()) {
  const out = [];
  for (const id of enabled) {
    const had = before.get(id) ?? 0;
    if (had >= A_REAL_BASELINE && !(now.get(id) > 0) && !allowed.has(id)) out.push({ id, had });
  }
  return out;
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
  let s = decodeEntities(text)
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
  const cutMidSentence = out.length > limit;
  if (cutMidSentence) out = out.slice(0, limit).replace(/\s+\S*$/, '');

  /* The ellipsis is only honest when the sentence was cut off. Stopping at a
     full stop and then adding one made eleven of the board's descriptions
     read as broken — "…seasonal observation for families…" is a whole
     sentence wearing a sign saying it is not. */
  if (!cutMidSentence && /[.!?]$/.test(out)) return out;
  return out.replace(/[\s.,;:]+$/, '') + '…';
}

/* This is not a children's calendar, and aggregating one by accident is worse
   than not having the listings: a parent cannot rely on four kids' events
   scattered among eighty, and everyone else has to read past them.

   Phrases rather than keywords, because the words are ambiguous and the
   phrases are not. A rule matching a bare \bkids\b drops Kids in the Hall,
   who are a comedy act Comedy Bar could plausibly book; "Family Day" is a
   public holiday that adults attend. What is unambiguous is an audience being
   named — "a program for young kids", "children's portraits", an age range in
   years. The description is read as well as the title, because "Little
   Discoveries" says nothing on its own and its page says young kids.

   Deliberately not excluded: "family". A family nature walk is a walk, and
   the Evergreen one is on the board for adults who want an easy hour. */
const FOR_CHILDREN = new RegExp([
  "\\bfor (?:young |little )?(?:kids|children|toddlers|babies)\\b",
  "\\b(?:young |little )?(?:kids|child|children)(?:'s|s')? (?:program|programme|class|workshop|session|hour|club|craft|story|portrait|photo|camp)",
  "\\bchildren's\\b",
  "\\btoddlers?\\b",
  "\\bpre-?school",
  "\\bstory ?time\\b",
  "\\bages? \\d+\\s*(?:[–—-]|to)\\s*\\d+\\b",
  "\\bunder \\d+s?\\b",
].join('|'), 'i');

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
