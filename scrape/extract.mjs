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
  'download', 'feedback', 'sitemap',
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
