/* Getting events out of a page.
 *
 * Order matters: JSON-LD is exact and survives redesigns, so it is tried
 * first and the language model is only paid for what it cannot answer. */

/** Every JSON-LD blob on the page, flattened out of @graph wrappers. */
export function jsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let parsed;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue;                       /* a broken blob is not a broken page */
    }
    for (const node of [].concat(parsed)) {
      if (node && Array.isArray(node['@graph'])) out.push(...node['@graph']);
      else if (node) out.push(node);
    }
  }
  return out;
}

const isEvent = (node) => {
  const t = node?.['@type'];
  return [].concat(t ?? []).some((x) => typeof x === 'string' && /Event$/i.test(x));
};

/** schema.org/Event -> our raw shape. Returns [] when the page has none. */
export function fromJsonLd(html) {
  return jsonLdBlocks(html).filter(isEvent).map((e) => ({
    title: text(e.name),
    startDate: e.startDate ?? null,
    endDate: e.endDate ?? null,
    venue: text(e.location?.name),
    address: addressOf(e.location),
    url: text(e.url),
    description: text(e.description),
    entry: offerText(e.offers),
    via: 'json-ld',
  }));
}

function text(v) {
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v)) return text(v[0]);
  return null;
}

function addressOf(loc) {
  const a = loc?.address;
  if (!a) return null;
  if (typeof a === 'string') return a.trim();
  return [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode]
    .filter(Boolean).join(', ') || null;
}

function offerText(offers) {
  const o = [].concat(offers ?? [])[0];
  if (!o) return null;
  const price = o.price ?? o.lowPrice;
  if (price === undefined || price === null || price === '') return null;
  return Number(price) === 0 ? 'Free' : `$${price}`;
}

/** The visible words of a page, for the model to read when JSON-LD is absent. */
/* The page's own summary of itself. Squarespace, WordPress and most CMSes
   write one, and it is almost always the description a human editor typed —
   cleaner than anything recoverable from the body, which on these pages opens
   with a thousand characters of navigation. og: first, because it is the one
   written for sharing; the plain meta description second. */
export function metaDescription(html) {
  const pick = (re) => {
    const m = re.exec(html);
    return m ? m[1] : null;
  };
  const raw =
    pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i) ||
    pick(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:description["']/i) ||
    pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
    pick(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  if (!raw) return null;
  const t = raw
    .replace(/&amp;amp;/g, '&').replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ').replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&mdash;/g, '—')
    .replace(/\s+/g, ' ').trim();
  if (t.length <= 40) return null;      /* a stub is worse than nothing */

  /* A lot of meta descriptions are the credit block and the logistics, which
     is everything the card already shows and nothing about the event. Bad
     Dog's reads "A Bad Dog Theatre Company Production Created by: … Producers:
     … Dates: … Time: … Location: …" before it reaches a word about the show,
     and trimmed to fit a card it is all preamble. Two or more of those labels
     up front means this is not a description, and a plain "Listed by …" is
     more honest than a paragraph of names. */
  const labels = (t.slice(0, 240).match(
    /\b(created by|produced by|producers?|directed by|starring|cast|dates?|time|location|venue|tickets?|price|admission|doors|presented by)\s*:/gi
  ) || []).length;
  return labels >= 2 ? null : t;
}

export function readableText(html, limit = 12000) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

/* A site's own furniture. These match the shape of an event slug on most
   sites — /create is indistinguishable from /liminal-coworking by pattern
   alone — so they are excluded by name. Following them wastes a fetch and,
   worse, makes a source look like it publishes nothing. */
const FURNITURE = new RegExp('/(' + [
  'create', 'new', 'signin', 'sign-in', 'signup', 'sign-up', 'login', 'log-in',
  'logout', 'register', 'account', 'settings', 'profile', 'dashboard', 'home',
  'about', 'contact', 'help', 'faq', 'support', 'pricing', 'plans', 'blog',
  'careers', 'jobs', 'press', 'privacy', 'terms', 'legal', 'cookies',
  'discover', 'explore', 'search', 'browse', 'calendar', 'events', 'app',
  'download', 'feedback', 'sitemap', 'overview', 'manifesto', 'team', 'partners',
  'organizers', 'for-organizers', 'privacy-policy', 'terms-of-service', 'community',
].join('|') + ')/?$', 'i');

/** Same-host links that look like individual event pages. */
export function candidateLinks(html, base, pattern, max) {
  if (!pattern) return [];
  const found = new Set();
  const re = /href=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let url;
    try { url = new URL(m[1], base).toString(); } catch { continue; }
    if (pattern.test(url) && !FURNITURE.test(new URL(url).pathname)
        && url !== base && url !== base.replace(/\/$/, '')) found.add(url);
    if (found.size >= max) break;
  }
  return [...found];
}
