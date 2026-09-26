/* robots.txt, honoured by both the poller and the discovery tool.
 *
 * A missing or unparseable robots.txt is not a prohibition; an explicit
 * Disallow is.
 *
 * This used to compare `pathname.startsWith(rule)`, which honoured the
 * simplest rule and silently ignored every other kind — and an ignored rule
 * reads as permission, which is the wrong way round for a file whose whole
 * job is saying no. Three shapes went straight through:
 *
 *   Disallow: /*?format=json-pretty   the query string was never looked at,
 *                                     and `*` was matched as a literal star
 *   Disallow: /en/events?*            same
 *   Disallow: /*.pdf                  same
 *
 * The first of those is not hypothetical. The Bad Dog note in sources.mjs
 * says "robots.txt disallows /*?format=json, so do NOT switch to the JSON
 * feed even though it answers" — a rule this file could not enforce, left
 * standing by a comment and whoever read it. The Piston and the Rex publish
 * the same rule, and Culture Days disallows /en/events?*.
 *
 * So: wildcards, end-anchors, the query string, and Allow. */

/* The token a site would name if it wanted to address this crawler in
 * particular. Exported as the full string too, so the poller and discovery
 * send exactly the name they are matched on. */
export const PRODUCT_TOKEN = 'ExploraCalendarBot';
export const USER_AGENT = `${PRODUCT_TOKEN}/1.0 (+https://github.com/coloredsavage/Explora)`;

const cache = new Map();

/* One group per user-agent token. Consecutive User-agent lines share the
 * group that follows them, which is how a site addresses several crawlers
 * with one set of rules. */
function parse(txt) {
  const groups = new Map();
  let agents = [];
  let readingAgents = false;

  for (const line of (txt ?? '').split('\n')) {
    const stripped = line.split('#')[0];
    const colon = stripped.indexOf(':');
    if (colon < 0) continue;
    const key = stripped.slice(0, colon).trim().toLowerCase();
    const value = stripped.slice(colon + 1).trim();

    if (key === 'user-agent') {
      if (!readingAgents) { agents = []; readingAgents = true; }
      const token = value.toLowerCase();
      agents.push(token);
      if (!groups.has(token)) groups.set(token, []);
    } else if (key === 'allow' || key === 'disallow') {
      readingAgents = false;
      /* "Disallow:" with nothing after it is the explicit way to say that
         nothing is disallowed, so it contributes no rule rather than a rule
         matching everything. An empty Allow says nothing either. */
      if (!value) continue;
      for (const token of agents) groups.get(token).push({ allow: key === 'allow', pattern: value });
    }
  }
  return groups;
}

/* `*` matches any run of characters and a trailing `$` anchors the end.
   Everything else is literal, including the `?` that starts a query string —
   which is why it has to be escaped before `*` is expanded. */
function toRegExp(pattern) {
  let body = pattern;
  let anchored = false;
  if (body.endsWith('$')) { anchored = true; body = body.slice(0, -1); }
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + (anchored ? '$' : ''));
}

/* RFC 9309: the most specific rule wins, measured by the length of the
   pattern, and Allow wins a tie. That ordering is what lets a site write
   "Disallow: /wp-admin/" beside "Allow: /wp-admin/admin-ajax.php" and mean
   it — the arrangement on half the WordPress sites this calendar reads. */
function mostSpecific(rules, target) {
  let best = null;
  for (const rule of rules) {
    if (!toRegExp(rule.pattern).test(target)) continue;
    if (!best
      || rule.pattern.length > best.pattern.length
      || (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)) best = rule;
  }
  return best;
}

export async function allowedBy(fetchText, url, agent = PRODUCT_TOKEN) {
  const parsed = new URL(url);
  const { origin } = parsed;

  if (!cache.has(origin)) {
    let groups = new Map();
    try { groups = parse(await fetchText(`${origin}/robots.txt`)); }
    catch { /* treat an unreadable robots.txt as no rules */ }
    cache.set(origin, groups);
  }

  /* A group naming this crawler outranks the catch-all, which is the whole
     point of a site naming it. Falling back to `*` is the general case. */
  const groups = cache.get(origin);
  const rules = groups.get(String(agent).toLowerCase()) ?? groups.get('*') ?? [];

  /* The query string is part of what a rule matches. Leaving it off is how
     "Disallow: /*?format=json-pretty" used to come back allowed. */
  const hit = mostSpecific(rules, parsed.pathname + parsed.search);
  if (!hit || hit.allow) return { allowed: true, rule: null };
  return { allowed: false, rule: hit.pattern };
}
