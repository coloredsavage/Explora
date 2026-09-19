/* Street festivals and block parties the board does not have, read out of
 * the City's noise exemption permits.
 *
 * Why permits. The City publishes a Festivals & Events feed that is exactly
 * the aggregator this calendar wants, and it cannot be read: every route to
 * it lands on secure.toronto.ca, which answers 403 to curl with any headers
 * you like, and the CKAN mirror returns HTTP 200 with the Access Denied page
 * as the body, so it looks like success. Meanwhile a street festival needs a
 * noise exemption whether or not anyone writes about it, and that dataset is
 * on the open CKAN host. It found the Bloorcourt Nuit Nuit Night Market, the
 * West of Spadina Block Party and Public Pier on the first run, none of which
 * any search turned up.
 *
 * Read through the datastore API, because that is the route the host offers.
 * Its robots.txt disallows the dataset download paths and allows /api/, in as
 * many words. The first draft of this went at the download URL: that rule is
 * a wildcard, which the old robots reader could not see and would have waved
 * through, and the new one refused the request before it was made. Querying
 * is better anyway — a limit and an offset, rather than 5.7MB of CSV for the
 * couple of dozen rows that matter.
 *
 * Why this proposes rather than publishes. These are permits, not listings.
 * The same table carries SHIP CHANNEL BRIDGE REHABILITATION and a staff
 * appreciation BBQ, and a permit is not evidence that anyone else is invited.
 * There is no price, no description and no URL — nothing a card could honestly
 * be built from, and nothing to link as the source the way every other listing
 * on this board does. So this prints a list for a person to take or leave. It
 * writes nothing and it never fails the build.
 *
 *   node scripts/propose-street-events.mjs
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { allowedBy, USER_AGENT } from '../scrape/robots.mjs';

const CKAN = 'https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action';
const DATASET = 'noise-exemption-permits';
const today = new Date().toISOString().slice(0, 10);

/* An allow-list, not a deny-list. Most of the 2,400 permits are construction
   and private functions, and the way to keep those out is to name the handful
   of words that mean "a thing in the street that anyone may turn up to"
   rather than try to enumerate everything that is not. A festival this misses
   is a listing nobody sees; a hospital generator this lets through is a
   listing that wastes someone's Saturday. */
const LOOKS_PUBLIC = /\b(festival|fest|block party|street party|night market|market|fair|parade|carnival|ribfest|art crawl|open streets|pedestrian sunday|jane's walk|culture days|buskerfest)\b/i;

/* Named events that carry one of those words and are still not a day out. */
const NOT_A_DAY_OUT = /\b(rehabilitation|construction|watermain|resurfac|bridge|generator|demolition|excavat|staff|employee|agm|annual general|private|wedding|funeral|memorial service)\b/i;

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const ask = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  /* The CKAN mirror of the City's blocked festivals feed answers 200 with an
     HTML denial page, and this host could learn the same trick. A 200 is not
     the same as data. */
  if (body.trimStart().startsWith('<')) throw new Error('answered 200 with HTML, not JSON');
  const parsed = JSON.parse(body);
  if (parsed?.success === false) throw new Error(parsed?.error?.message ?? 'the API said no');
  return parsed;
};

/* Only one resource on this dataset is loaded into the datastore and so
   actually queryable; the rest are files. Resolved rather than hard-coded —
   the names carry a date range and are renamed when the window moves. */
async function currentResource() {
  const pkg = (await ask(`${CKAN}/package_show?id=${DATASET}`))?.result;
  const live = (pkg?.resources ?? []).find((r) => r.datastore_active && /current/i.test(r.name ?? ''));
  if (!live?.id) throw new Error('no datastore-backed resource on the dataset');
  return { id: live.id, refreshed: pkg.last_refreshed ?? 'unknown' };
}

async function allPermits(resourceId) {
  const out = [];
  for (let offset = 0; offset < 20000; offset += 1000) {
    const page = (await ask(`${CKAN}/datastore_search?resource_id=${resourceId}&limit=1000&offset=${offset}`))?.result;
    const records = page?.records ?? [];
    out.push(...records);
    if (records.length < 1000 || out.length >= (page.total ?? 0)) break;
  }
  return out;
}

/* What is already on the board, hand-written and polled alike, so a permit
   for something the calendar carries is not proposed a second time. */
function onTheBoard() {
  const ctx = vm.createContext({});
  for (const f of ['price.js', 'data.js', 'scraped.js']) {
    vm.runInContext(readFileSync(`${process.cwd()}/${f}`, 'utf8'), ctx, { filename: f });
  }
  const events = vm.runInContext('EVENTS', ctx).concat(vm.runInContext('SCRAPED', ctx));
  return events.map((e) => norm(e.title));
}

/* One permit per occurrence, and a festival takes several — setup, the event,
   tear down — so collapse on name and day. */
const key = (p) => `${norm(p['Event/Project/Activity Name'])}|${String(p.StartDateTime).slice(0, 10)}`;

async function main() {
  const fetchText = async (u) => {
    const r = await fetch(u, { headers: { 'User-Agent': USER_AGENT } });
    return r.ok ? r.text() : null;
  };
  const robots = await allowedBy(fetchText, `${CKAN}/datastore_search`);
  if (!robots.allowed) { console.log(`\nrobots.txt disallows ${robots.rule}`); return; }

  let where;
  let permits;
  try {
    where = await currentResource();
    permits = await allPermits(where.id);
  } catch (err) { console.log(`\nCould not read the permits: ${err.message}`); return; }

  const known = onTheBoard();
  const seen = new Set();
  const proposals = [];

  for (const p of permits) {
    const name = String(p['Event/Project/Activity Name'] ?? '').trim();
    const start = String(p.StartDateTime ?? '');
    if (!name || start.slice(0, 10) < today) continue;
    if (!LOOKS_PUBLIC.test(name) || NOT_A_DAY_OUT.test(name)) continue;

    const k = key(p);
    if (seen.has(k)) continue;
    seen.add(k);

    const n = norm(name);
    if (known.some((t) => t === n || t.includes(n) || n.includes(t))) continue;

    proposals.push({
      name,
      date: start.slice(0, 10),
      time: start.slice(11, 16),
      where: String(p.Address ?? p.LocationName ?? p.ParkName ?? '').trim(),
      ward: String(p.Ward ?? '').trim(),
    });
  }

  proposals.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  console.log(`\n${permits.length} permits · refreshed ${String(where.refreshed).slice(0, 10)} · `
    + `${proposals.length} street event${proposals.length === 1 ? '' : 's'} not on the board\n`);
  for (const p of proposals) {
    console.log(`  ${p.date} ${p.time}  ${p.name.slice(0, 44).padEnd(46)}${p.where.slice(0, 40)}`);
  }
  if (proposals.length) {
    console.log('\nA permit is not a listing: no price, no description, no page to cite.'
      + '\nConfirm each against the organiser before adding it to data.js.');
  }
}

/* A report, not a gate — the poll should not fail because the City's open
   data portal was down. */
main().catch((err) => console.log(`\nCould not read the permits: ${err.message}`));
