/* Helpers for sources that publish JSON rather than a page.
 *
 * A JSON feed is the cheapest source there is: exact fields, no model call,
 * no follow cap, no rendering. What it is not is the shape normalize wants,
 * so each source's `api.map` turns one record into one `raw` and these are
 * the parts that every such map needs.
 *
 * Everything here returns null rather than a guess. A record this cannot
 * read is one listing missing, which is the same trade the rest of the
 * poller makes. */

/* Feeds carry HTML in their text fields — an excerpt wrapped in <p>, a price
   inside an <a> to the ticketing page. Entities are left alone: normalize
   decodes those, and doing it here as well would decode twice and turn a
   literal "&amp;amp;" into something it never said. */
export function stripTags(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6])>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* The same reading as priceOf in price.js and tooDear in normalize.mjs: a
   line that says free, or pay-what-you-can, is free whatever else it
   mentions, and otherwise the first dollar figure is the door price. Read
   from the source's own ticketing field, so it is quotable. */
export function priceFrom(value) {
  const t = stripTags(value);
  if (!t) return null;
  if (/^\s*free\b/i.test(t) || /pay[\s-]?what[\s-]?you[\s-]?can|\bPWYC\b/i.test(t)) return 'Free';
  const m = /\$\s?\d[\d,]*(?:\.\d{2})?/.exec(t);
  return m ? m[0].replace(/\s+/g, '') : null;
}

/* A Plus Code is a grid reference, not a place — "JJQ2+373 Toronto" is what
   the Bentway's feed carries for one of its Nuit Blanche entries. It passes
   a test for "mentions Toronto" while telling a reader nothing they could
   walk to, so it is refused here rather than published as an address. */
const PLUS_CODE = /^[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,}/i;

/* Feeds give one address string with the venue's name on the front:
   "The Bentway Skate Trail, 250 Fort York Boulevard, Toronto, ON, Canada".
   The card prints venue and address separately, so split on the first
   segment when it reads as a name rather than a street line. When it does
   not, the venue is left null and the source's own defaultVenue stands. */
export function splitPlace(value) {
  const whole = String(value ?? '').trim();
  if (!whole) return null;
  if (PLUS_CODE.test(whole)) return null;

  const parts = whole.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return { venue: null, address: whole };

  /* A street line opens with a number; a venue name does not. */
  const named = !/^\d/.test(parts[0]) && parts.length > 2;
  return named
    ? { venue: parts[0], address: parts.slice(1).join(', ') }
    : { venue: null, address: whole };
}

/* "10:00 am" + "12:00 pm" is how the card would write it anyway. One of the
   two missing is still worth showing; neither is nothing. */
export function timeRange(start, end) {
  const a = String(start ?? '').trim();
  const b = String(end ?? '').trim();
  if (a && b) return `${a} – ${b}`;
  return a || b || null;
}

/* ------------------------------------------------- The Events Calendar */

/* The WordPress plugin a great many Toronto venues run, and it exposes the
   whole calendar at /wp-json/tribe/events/v1/events with the fields already
   separated — title, start, end, cost, and a venue object. One shape, so one
   reader, and each source only has to say where to find it. */

/* The wall clock as the page wrote it. Deliberately read off the string
   rather than parsed into a Date: "2026-09-28T18:00:00-04:00" is six in the
   evening in Toronto, and putting it through a Date on a UTC runner makes it
   ten at night. */
export const clock = (value) => {
  const m = /\d{4}-\d{2}-\d{2}[ T](\d{2}):(\d{2})/.exec(String(value ?? ''));
  if (!m) return null;
  const hour = Number(m[1]);
  const suffix = hour >= 12 ? 'pm' : 'am';
  const h12 = hour % 12 || 12;
  return m[2] === '00' ? `${h12}${suffix}` : `${h12}:${m[2]}${suffix}`;
};

const dayAfter = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

export function fromTribe(rec) {
  if (rec.status && rec.status !== 'publish') return null;
  if (rec.hide_from_listings) return null;

  const start = String(rec.start_date ?? '');
  const end = String(rec.end_date ?? '');
  const startDay = start.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDay)) return null;

  /* A club night is one night. Renaissance runs 21:30 to 02:30, so its end
     date is the following morning — taken at face value that is a two-day
     festival, and the card would say so. A finish in the small hours of the
     next day belongs to the night it started. */
  const endDay = end.slice(0, 10);
  let range = null;
  if (endDay && endDay > startDay) {
    const endHour = Number(/[ T](\d{2}):/.exec(end)?.[1] ?? 99);
    const lateNight = endDay === dayAfter(startDay) && endHour < 6;
    if (!lateNight) range = endDay;
  }

  /* The venue object is often present but empty — Grossman's sends one with
     nothing in it, and the Emmet Ray names a room inside the pub rather than
     the pub. Neither can place someone on a street, so the source's own
     defaultVenue/defaultAddress stand instead. */
  const v = rec.venue ?? {};
  const placed = Boolean(v.venue && (v.address || v.city));

  return {
    title: rec.title,
    startDate: startDay,
    endDate: range,
    time: rec.all_day ? null : timeRange(clock(start), clock(end)),
    venue: placed ? v.venue : null,
    address: placed ? [v.address, v.city, v.province, v.zip].filter(Boolean).join(', ') : null,
    url: rec.url,
    /* The plugin's own cost field, which is the venue's own words. Left null
       when empty rather than assumed — a venue that is usually free is not
       the same as this night being free, and a wrong price sends someone to
       a door with the wrong money. */
    entry: rec.cost || null,
    description: stripTags(rec.description),
    via: 'api',
  };
}
