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

const asDate = (v) => {
  if (!v) return null;
  const d = String(v).slice(0, 10);
  return ISO.test(d) ? d : null;
};

export function normalize(raw, source, { today, checked }) {
  const title = (raw.title ?? '').trim();
  const start = asDate(raw.startDate);
  const end = asDate(raw.endDate);
  const venue = (raw.venue ?? source.defaultVenue ?? '').trim();
  const address = (raw.address ?? source.defaultAddress ?? '').trim();

  const reject = (why) => ({ ok: false, why, title: title || '(untitled)' });

  if (!title) return reject('no title');
  if (!start) return reject('no usable start date');
  if (start < today) return reject(`already past (${start})`);
  if (!venue) return reject('no venue');
  if (!address) return reject('no address');
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
      ...(raw.entry ? { entry: raw.entry.trim() } : {}),
      venue,
      address,
      url: raw.url ?? source.url,
      source: raw.url ?? source.url,
      checked,
      description: (raw.description ?? '').trim() || `Listed by ${source.name}.`,
      schedule,
      scrapedFrom: source.id,
      via: raw.via,
    },
  };
}

/** Last line of defence before anything is written out. */
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
