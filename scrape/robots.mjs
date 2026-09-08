/* robots.txt, honoured by both the poller and the discovery tool.
 *
 * Only the `User-agent: *` group is read, which is the group a general
 * crawler is bound by. A missing or unparseable robots.txt is not a
 * prohibition; an explicit Disallow is. */

const cache = new Map();

export async function allowedBy(fetchText, url) {
  const { origin, pathname } = new URL(url);

  if (!cache.has(origin)) {
    const rules = [];
    try {
      const txt = await fetchText(`${origin}/robots.txt`);
      let applies = false;
      for (const line of (txt ?? '').split('\n')) {
        const [rawKey, ...rest] = line.split('#')[0].split(':');
        const key = rawKey.trim().toLowerCase();
        const value = rest.join(':').trim();
        if (key === 'user-agent') applies = value === '*';
        else if (applies && key === 'disallow' && value) rules.push(value);
      }
    } catch { /* treat an unreadable robots.txt as no rules */ }
    cache.set(origin, rules);
  }

  const rules = cache.get(origin);
  const hit = rules.find((rule) => pathname.startsWith(rule));
  return { allowed: !hit, rule: hit ?? null };
}
