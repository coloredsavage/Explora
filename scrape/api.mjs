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
