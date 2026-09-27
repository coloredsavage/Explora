#!/usr/bin/env node
/* Poll each source once, and write what survived to scraped.js.
 *
 *   node scrape/run.mjs                 # live, needs playwright chromium
 *   node scrape/run.mjs --offline       # replay scrape/fixtures, no network
 *   node scrape/run.mjs --dry-run       # report only, write nothing
 *
 * The model fallback runs only when a page has no JSON-LD and ANTHROPIC_API_KEY
 * is set; without a key those pages are simply skipped and reported. */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enabledSources } from './sources.mjs';
import { fromJsonLd, readableText, candidateLinks, metaDescription, readsAsDescription } from './extract.mjs';
import { normalize, validate, stripSiteSuffix, disambiguateIds, collapseSubsumed, silentSources } from './normalize.mjs';
import { allowedBy, USER_AGENT } from './robots.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = new Set(process.argv.slice(2));
const OFFLINE = argv.has('--offline');
const DRY = argv.has('--dry-run');

/* One name, defined beside the rules it is matched against. */
const UA = USER_AGENT;

/* A hard stop on model calls per run, because nothing else was one. Seven
   sources with follow caps of ten to twenty is up to 121 pages, and on a bad
   day every one of them is a paid call. Past this the poll keeps going and
   takes whatever structured data it can read for free; it does not fail, and
   it says in the report that it stopped asking. */
const MODEL_CALL_BUDGET = Number(process.env.MODEL_CALL_BUDGET || 40);
let modelCalls = 0;
const today = new Date().toISOString().slice(0, 10);

const report = { kept: [], dropped: [], skipped: [], errors: [] };
const startOf = (e) => (e.schedule.kind === 'day' ? e.schedule.date : e.schedule.start);

/* ------------------------------------------------------------- the sources */

async function harvest(source, pages) {
  const out = [];
  for (const { url, html } of pages) {
    /* The page's own summary of itself. On a CMS the readable text opens with
       the entire navigation menu, and this is the part an editor wrote about
       this event — so the model gets it as well as the body, and it is the
       last resort if nothing writes a description at all. */
    const meta = metaDescription(html);
    let raws = fromJsonLd(html);

    /* Structured data is authoritative for the facts and frequently silent on
       the prose. Bad Dog's event pages carry an Event node with name, dates,
       location and image and no description at all, so the model — the only
       thing here that can write one — was never reached, and the card fell
       back to "Listed by …" while the page described the show three ways.
       When that happens the model is asked for the prose and the JSON-LD
       keeps everything else. */
    /* A description that is really a logistics block counts as none. Luma's
       Event nodes carry one — "📍 Trinity Bellwoods Park … 🕒 3:00-5:00p.m."
       — so raws arrived with descriptions, the page never looked short of
       prose, and the model was never asked while the card showed a meeting
       point it already displayed twice. */
    raws = raws.map((r) => ({
      ...r,
      description: r.description && readsAsDescription(r.description) ? r.description : null,
    }));

    const noProse = raws.length > 0
      && raws.every((r) => !r.description)
      && !readsAsDescription(meta);

    if (raws.length === 0 || noProse) {
      if (!process.env.ANTHROPIC_API_KEY) {
        if (raws.length === 0) report.skipped.push(`${url} — no JSON-LD and no ANTHROPIC_API_KEY`);
        continue;
      }
      if (modelCalls >= MODEL_CALL_BUDGET) {
        if (raws.length === 0) report.skipped.push(`${url} — model budget spent`);
        continue;
      }
      try {
        modelCalls += 1;
        const { extractWithModel } = await import('./llm.mjs');
        const fromModel = await extractWithModel(readableText(html), { url, today, summary: meta });
        if (raws.length === 0) {
          raws = fromModel;
        } else {
          /* Keep the structured facts, borrow only the words.
             The two sides name the same event differently: Bad Dog's JSON-LD
             calls it "The Audition  — Bad Dog Theatre Company - Toronto's Best
             Improv", because the node's name is the page title, while a model
             reading the page returns "The Audition". Matching those literally
             found nothing and the prose was thrown away. Both sides lose the
             site suffix first, and then one title matching the start of the
             other is enough — a page's structured name and its prose name
             agree about the beginning even when they disagree about the end. */
          const norm = (x) => stripSiteSuffix(String(x ?? '').trim(), source.name)
            .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          const said = fromModel.filter((e) => e.description).map((e) => [norm(e.title), e.description]);
          const proseFor = (title) => {
            const t = norm(title);
            if (!t) return null;
            const hit = said.find(([k]) => k === t)
              || said.find(([k]) => k.length >= 8 && (k.startsWith(t) || t.startsWith(k)));
            return hit ? hit[1] : null;
          };
          raws = raws.map((r) => ({ ...r, description: r.description ?? proseFor(r.title) }));
        }
      } catch (err) {
        report.errors.push(`${url} — model extraction failed: ${err.message}`);
        if (raws.length === 0) continue;
      }
    }

    for (const raw of raws) {
      const result = normalize(
        { ...raw, url: raw.url ?? url,
          description: raw.description || (readsAsDescription(meta) ? meta : null) },
        source, { today, checked: today });
      if (!result.ok) { report.dropped.push(`${source.id}: ${result.title} — ${result.why}`); continue; }

      const problems = validate(result.event);
      if (problems.length) { report.dropped.push(`${source.id}: ${result.event.title} — ${problems.join(', ')}`); continue; }

      out.push(result.event);
      report.kept.push(`${source.id}: ${result.event.title} (${result.event.via})`);
    }
  }
  return out;
}

/* What the file on disk says each source found last time. Parsed rather than
   imported: scraped.js is a module with a top-level const, and this only ever
   needs the array out of it. A file that is missing, truncated or not yet in
   this shape returns null, which the caller reads as "nothing to compare
   against" rather than as a source having gone quiet. */
async function previousCounts() {
  let text;
  try { text = await readFile(path.join(root, 'scraped.js'), 'utf8'); }
  catch { return null; }
  const open = text.indexOf('[');
  const close = text.lastIndexOf(']');
  if (open < 0 || close < open) return null;
  let prev;
  try { prev = JSON.parse(text.slice(open, close + 1)); }
  catch { return null; }
  if (!Array.isArray(prev)) return null;
  const counts = new Map();
  for (const e of prev) counts.set(e.scrapedFrom, (counts.get(e.scrapedFrom) ?? 0) + 1);
  return counts;
}

/* ------------------------------------------------------------ json sources */

/* A source with an `api` block is read from its own JSON rather than from
   its pages. No browser, no model, no follow cap — and no chance of the
   listing page hiding half its calendar behind a month selector, which is
   what the Bentway's was doing.

   robots.txt still decides. A JSON endpoint is a URL like any other, and
   until this run the rules that would cover one were the exact shapes
   robots.mjs could not read. */
async function apiRecords(source) {
  const { url, maxPages = 1 } = source.api;
  const fetchText = async (u) => {
    const res = await fetch(u, { headers: { 'User-Agent': UA } });
    return res.ok ? res.text() : null;
  };

  const robots = await allowedBy(fetchText, url);
  if (!robots.allowed) {
    report.skipped.push(`${url} — robots.txt disallows ${robots.rule}`);
    return [];
  }

  const out = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const paged = `${url}${url.includes('?') ? '&' : '?'}page=${page}`;
    let res;
    try { res = await fetch(paged, { headers: { 'User-Agent': UA, Accept: 'application/json' } }); }
    catch (err) { report.errors.push(`${paged} — ${err.message}`); break; }

    /* WordPress answers 400 past the last page rather than an empty array,
       so a run out of pages is the end of the feed and not a failure. */
    if (res.status === 400 && page > 1) break;
    if (!res.ok) { report.errors.push(`${paged} — HTTP ${res.status}`); break; }

    let body;
    try { body = await res.json(); }
    catch (err) { report.errors.push(`${paged} — not JSON: ${err.message}`); break; }

    /* Two shapes in the wild: WordPress core returns a bare array, The
       Events Calendar wraps it as { events, total_pages }. A source can name
       its own accessor if it is neither. */
    const batch = source.api.records
      ? source.api.records(body)
      : (Array.isArray(body) ? body : body?.events);
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);

    /* Page count comes from the header on core and from the body on the
       plugin; whichever answers, stop when the feed says there is no more. */
    const total = Number(res.headers.get('x-wp-totalpages') ?? body?.total_pages);
    if (Number.isFinite(total) && total > 0 && page >= total) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return out;
}

async function harvestApi(source, records) {
  const out = [];
  for (const rec of records) {
    let raw;
    try { raw = source.api.map(rec); }
    catch (err) { report.errors.push(`${source.id} — map failed: ${err.message}`); continue; }
    /* A map returning null has read the record and decided against it —
       already past, no location it could print. Not worth reporting one by
       one; the feed carries years of them. */
    if (!raw) continue;

    const result = normalize({ ...raw, url: raw.url ?? source.url }, source, { today, checked: today });
    if (!result.ok) { report.dropped.push(`${source.id}: ${result.title} — ${result.why}`); continue; }

    const problems = validate(result.event);
    if (problems.length) { report.dropped.push(`${source.id}: ${result.event.title} — ${problems.join(', ')}`); continue; }

    out.push(result.event);
    report.kept.push(`${source.id}: ${result.event.title} (${result.event.via})`);
  }
  return out;
}

/* --------------------------------------------------------------- fetching */

/* Offline replays a fixture for a json source the same way it does for a
   page, so the shape of a feed is something the suite can hold still. */
async function offlineRecords(source) {
  try {
    const raw = await readFile(path.join(root, 'scrape', 'fixtures', `${source.id}.api.json`), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function offlinePages(source) {
  const dir = path.join(root, 'scrape', 'fixtures');
  let names = [];
  try { names = await readdir(dir); } catch { return []; }
  const mine = names.filter((n) => n === `${source.id}.html` || n.startsWith(`${source.id}.`));
  return Promise.all(mine.sort().map(async (n) => ({
    url: `${source.url}#${n}`,
    html: await readFile(path.join(dir, n), 'utf8'),
  })));
}

async function livePages(source, browser) {
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  const fetchText = async (u) => {
    const res = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return res && res.ok() ? page.content() : null;
  };

  const pages = [];
  const visit = async (url) => {
    const robots = await allowedBy(fetchText, url);
    if (!robots.allowed) { report.skipped.push(`${url} — robots.txt disallows ${robots.rule}`); return null; }
    const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    if (!res || !res.ok()) { report.errors.push(`${url} — HTTP ${res ? res.status() : 'no response'}`); return null; }
    const html = await page.content();
    pages.push({ url, html });
    return html;
  };

  const index = await visit(source.url);
  if (index) {
    for (const link of candidateLinks(index, source.url, source.followLinks, source.maxFollow ?? 0)) {
      await new Promise((r) => setTimeout(r, 1500));   /* one page every 1.5s */
      await visit(link);
    }
  }
  await ctx.close();
  return pages;
}

/* ------------------------------------------------------------------- main */

async function main() {
  let browser = null;
  if (!OFFLINE) {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
  }

  const events = [];
  for (const source of enabledSources()) {
    try {
      let found;
      if (source.api) {
        const records = OFFLINE ? await offlineRecords(source) : await apiRecords(source);
        if (records.length === 0) report.skipped.push(`${source.id} — nothing fetched`);
        found = await harvestApi(source, records);
      } else {
        const pages = OFFLINE ? await offlinePages(source) : await livePages(source, browser);
        if (pages.length === 0) report.skipped.push(`${source.id} — nothing fetched`);
        found = await harvest(source, pages);
      }
      if (source.maxEvents && found.length > source.maxEvents) {
        /* soonest first, so a cap keeps what is most use */
        found.sort((a, b) => startOf(a).localeCompare(startOf(b)));
        report.skipped.push(`${source.id} — capped at ${source.maxEvents} of ${found.length} events`);
        found = found.slice(0, source.maxEvents);
      }
      events.push(...found);
    } catch (err) {
      report.errors.push(`${source.id} — ${err.message}`);
    }
  }
  if (browser) await browser.close();

  /* The same event arrives more than once: the index page lists it and the
     page it links to describes it, and until the title suffix was stripped
     the two even had different ids. Collapse them on title-and-date, keeping
     the copy that came from the event's own page over the one scraped off
     the index, and the fuller description between equals. */
  const norm = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const key = (e) => {
    const d = e.schedule.date ?? e.schedule.start ?? '';
    /* Title and date alone would merge two different things that share a
       name on one day — a leisure swim at two pools, an artist talk the
       gallery and the library each list at their own address. The venue
       keeps those apart. It costs the occasional pair of listings for one
       event carried by two sources, which is clutter; merging two real
       events loses one off the board, which is worse. A recurring show is
       untouched either way: same title, same venue, different date, so
       every Thursday keeps its own entry. */
    return norm(e.title) + '|' + d + '|' + norm(e.venue);
  };
  const better = (a, b) => {
    const deep = (e) => (e.url && e.url !== e.scrapedFromUrl && e.url.replace(/\/$/, '').split('/').length > 4 ? 1 : 0);
    if (deep(a) !== deep(b)) return deep(a) > deep(b) ? a : b;
    /* Of two pages at the same depth, the one whose slug is the event's name
       is the event's own page. The Bentway published Public Trust on its
       after-school page as well as its own, both five segments deep, and
       description length picked the after-school one — so the listing that
       survived sent readers to the wrong page. Title against slug separates
       them: "public-trust" shares both its words with the title and
       "bentway-after-school" shares none. */
    const slugHit = (e) => {
      const words = new Set(String(e.title ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []);
      const parts = String(e.url ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
      return words.size ? parts.filter((w) => words.has(w)).length / words.size : 0;
    };
    if (slugHit(a) !== slugHit(b)) return slugHit(a) > slugHit(b) ? a : b;
    return (a.description || '').length >= (b.description || '').length ? a : b;
  };
  const byKey = new Map();
  let collapsed = 0;
  for (const e of events) {
    const k = key(e);
    if (byKey.has(k)) { byKey.set(k, better(byKey.get(k), e)); collapsed += 1; }
    else byKey.set(k, e);
  }
  if (collapsed) report.skipped.push(`${collapsed} duplicate${collapsed === 1 ? '' : 's'} collapsed`);
  events.length = 0;
  events.push(...byKey.values());

  /* The rule above keeps two things with one name at two addresses apart, on
     purpose. One project published across several of a source's own pages
     looks exactly like that and is not; see collapseSubsumed. */
  const subsumed = collapseSubsumed(events, better);
  if (subsumed.dropped) {
    report.skipped.push(`${subsumed.dropped} listing${subsumed.dropped === 1 ? '' : 's'} folded into a fuller copy of the same event`);
  }

  /* The dedupe above kept some listings apart that the id would put back
     together; see disambiguateIds. */
  const ids = disambiguateIds(events);
  for (const id of ids.shared) {
    report.skipped.push(`listings shared the id ${id} — told apart by venue`);
  }

  /* keep the file stable between runs so an unchanged poll is an empty diff */
  events.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const body = events.length
    ? events.map((e) => '  ' + JSON.stringify(e, null, 2).replace(/\n/g, '\n  ')).join(',\n')
    : '';
  const file = `/* Generated by scrape/run.mjs — do not edit by hand.
   Hand-written listings live in data.js; these are polled from the sources
   in scrape/sources.mjs and merged at load. */

const SCRAPED = [\n${body}\n];\n`;

  console.log(`\nkept ${report.kept.length}   dropped ${report.dropped.length}   skipped ${report.skipped.length}   errors ${report.errors.length}   model calls ${modelCalls}/${MODEL_CALL_BUDGET}`);
  for (const [label, list] of [['kept', report.kept], ['dropped', report.dropped], ['skipped', report.skipped], ['errors', report.errors]]) {
    if (list.length) console.log(`\n${label}:\n  ` + list.join('\n  '));
  }

  /* The failure this poll cannot see on its own; see silentSources. Offline
     replays fixtures and has no bearing on what the sources hold, so it is
     exempt. To land a poll where a source really has gone quiet, name it:
       ALLOW_SILENT_SOURCES=bentway,evergreen node scrape/run.mjs */
  let silent = [];
  if (!OFFLINE) {
    const before = await previousCounts();
    if (before) {
      const now = new Map();
      for (const e of events) now.set(e.scrapedFrom, (now.get(e.scrapedFrom) ?? 0) + 1);
      const allowed = new Set((process.env.ALLOW_SILENT_SOURCES || '')
        .split(',').map((x) => x.trim()).filter(Boolean));
      silent = silentSources(before, now, enabledSources().map((x) => x.id), allowed);
    }
  }

  if (silent.length) {
    console.error(`\n${silent.length} source${silent.length === 1 ? '' : 's'} went quiet:`);
    for (const { id, had } of silent) console.error(`  ${id} — ${had} last run, none this one`);
    console.error('\nscraped.js not written. Check the errors above — a source that was'
      + '\nproducing and now is not usually means the poller broke, not the city.'
      + '\nIf it really has gone quiet, name it and run again:'
      + `\n  ALLOW_SILENT_SOURCES=${silent.map((x) => x.id).join(',')}`);
    process.exitCode = 1;
    return;
  }

  if (DRY) { console.log('\n--dry-run: scraped.js not written'); return; }
  await writeFile(path.join(root, 'scraped.js'), file);
  console.log(`\nwrote scraped.js with ${events.length} event${events.length === 1 ? '' : 's'}`);

  /* A source that errors should not quietly empty the calendar */
  if (report.errors.length && events.length === 0) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
