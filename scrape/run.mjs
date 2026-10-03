#!/usr/bin/env node
/* Poll each source once, and write what survived to scraped.js.
 *
 *   node scrape/run.mjs                 # live, needs playwright chromium
 *   node scrape/run.mjs --offline       # replay scrape/fixtures, no network;
 *                                       # writes to the temp dir, never scraped.js
 *   node scrape/run.mjs --dry-run       # report only, write nothing
 *
 * The model fallback runs only when a page has no JSON-LD and ANTHROPIC_API_KEY
 * is set; without a key those pages are simply skipped and reported. */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { enabledSources, allSources } from './sources.mjs';
import { fromJsonLd, readableText, candidateLinks, metaDescription, readsAsDescription,
  sectionProse, sectionText, echoesTitle } from './extract.mjs';
import { normalize, validate, stripSiteSuffix, disambiguateIds, collapseSubsumed, silentSources, shrunkSources } from './normalize.mjs';
import { allowedBy, USER_AGENT } from './robots.mjs';
import { load as loadDescriptions, save as saveDescriptions, writtenFor, restsAsNothing,
  isPlaceholder, needsWriting } from './descriptions.mjs';

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

/* Today, read from the clock when a poll asks rather than once at import.
   Everything that decides "already past" takes it as a parameter, so the
   suite can pin the date and a fixture dated October does not start failing
   in October. Only main() and the dry run read the real clock. */
export const todayIso = () => new Date().toISOString().slice(0, 10);

export const report = { kept: [], dropped: [], skipped: [], errors: [], coverage: [], followFailures: {} };

/* Pages read this run whose listing has no description, url -> {title, text}.
   Drained into scrape/descriptions.json at the end of main(); the batch
   script picks it up from there. */
export const descriptionQueue = new Map();

/* The pause between event pages: 1.5s, and never under a second in a real
   poll whatever the environment says. A value that is not a number is
   ignored rather than read as zero. Only the suite (EXPLORA_TEST=1) may go
   lower, to replay a listing through livePages against a fake browser
   without waiting 30s. */
const DEFAULT_FOLLOW_DELAY_MS = 1500;
export const MIN_FOLLOW_DELAY_MS = 1000;
export function followDelayMs(env = process.env) {
  const raw = env.FOLLOW_DELAY_MS;
  const n = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
  const asked = Number.isFinite(n) && n >= 0 ? n : DEFAULT_FOLLOW_DELAY_MS;
  return env.EXPLORA_TEST === '1' ? asked : Math.max(asked, MIN_FOLLOW_DELAY_MS);
}
const FOLLOW_DELAY_MS = followDelayMs();

/* Following an event page can fail — a timeout, a 403, a 404. One failure is
   that page lost. Three in a row is the site refusing or falling over, and
   the rest of the source's links are left alone rather than hammered. And a
   source that could not read more than a third of what it set out to read
   is not published as though it had: see followVerdict. */
export const FOLLOW_BREAKER = 3;
export const FAILED_SHARE = 1 / 3;
const startOf = (e) => (e.schedule.kind === 'day' ? e.schedule.date : e.schedule.start);

/* ------------------------------------------------------------- the sources */

export async function harvest(source, pages, { today = todayIso() } = {}) {
  const out = [];
  for (const { url, html, isIndex } of pages) {
    /* A listing-only source's index page is a list of links and nothing
       more. Eventbrite's names twenty events with no price on any of them;
       publishing those would put twenty "Price not listed" cards up beside
       the priced copies read from the event pages. */
    if (source.listingOnly && isIndex) continue;
    /* The page's own summary of itself. On a CMS the readable text opens with
       the entire navigation menu, and this is the part an editor wrote about
       this event — so the model gets it as well as the body, and it is the
       last resort if nothing writes a description at all. */
    let raws = fromJsonLd(html);

    /* A source can say which of one page's nodes are the listing — on an
       Eventbrite page, the dated node and not the series beside it. */
    if (source.pageNodes && raws.length > 1) {
      const settled = source.pageNodes(raws);
      for (const d of settled.dropped) report.dropped.push(`${source.id}: ${d.title} — ${d.why}`);
      raws = settled.keep;
    }

    /* A page's meta description belongs to the page. On an event page that is
       the event, and it has been the last resort for prose since the start. On
       a listing page it is the site talking about itself — Luma's city page
       says "Discover the hottest events in Toronto, and get notified of new
       events before they sell out", and once the ItemList there became
       readable that sentence was handed to all twenty events as their
       description.

       One event on the page, it is about that event. Twenty, it is not about
       any of them. */
    /* And nulled when it is only the title again, for the same reason the
       JSON-LD description is below: Eventbrite sets all three to the event's
       name, and meta is the last resort further down (`raw.description ||
       meta`), so leaving it would put the title back as the description
       after the work above had taken it out. */
    const metaRaw = raws.length > 1 ? null : metaDescription(html);
    const meta = metaRaw && raws.length === 1 && echoesTitle(metaRaw, raws[0].title) ? null : metaRaw;

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

    /* A description that is only the title again is no description. On
       Eventbrite that is every page: the Event node's `description`, the meta
       description and og:description are all set to the event's own name, so
       the board showed "Best Croissant & Best Baguette in Toronto - The 2026
       Competition" as its own description while the page's first paragraph
       sat unread. Dropping it here is what lets the fallbacks below run —
       `descriptionFrom` for a source that cannot ask the model, the model
       itself for one that can. */
    raws = raws.map((r) => (echoesTitle(r.description, r.title) ? { ...r, description: null } : r));

    /* The page's own prose, for a source whose structured data has none and
       which never asks the model (noModel). Only consulted when there is
       nothing better, and it returns null rather than guessing. */
    if (source.descriptionFrom) {
      raws = raws.map((r) => (r.description
        ? r
        : { ...r, description: source.descriptionFrom(html, r.title) ?? null }));
    }

    const noProse = raws.length > 0
      && raws.every((r) => !r.description)
      && !readsAsDescription(meta);

    /* A source whose facts must come from structured data never reaches the
       model. An event page with nothing to read is reported, by name. */
    if (source.noModel && raws.length === 0) {
      report.dropped.push(`${source.id}: ${url} — no Event JSON-LD on the event page`);
      continue;
    }

    if ((raws.length === 0 || noProse) && !source.noModel) {
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

    /* Keep this page's readable text for anything that is about to be filed
       with no description of its own. scripts/write-descriptions.mjs reads
       the queue and asks the model, on the Batch API, after the poll — the
       page is already fetched here, so "check the site first" costs nothing
       beyond holding the text. */
    for (const raw of raws) {
      if (raw.description && !needsWriting(raw.description, raw.title)) continue;
      const u = raw.url ?? url;
      if (!u || descriptionQueue.has(u)) continue;
      /* Never an index page's text, and this matters because the answer is
         used to DROP listings. A listing harvested off a venue's index keeps
         that index as its url — Bad Dog's "Super Hot Date Night" is
         baddogtheatre.com/whats-on — so queueing it hands the model a page
         listing twenty shows and asks what one of them is. It answered
         NOTHING, correctly, and acting on that would have taken a real
         listing off the board for a question it was never asked.
         "This page says nothing about the event" is only a fact about the
         event's own page. */
      if (isIndex) continue;
      /* The whole readable page, navigation and all.
         
         Trimming it looked obviously right and measured as a regression. Bad
         Dog's event pages spend their first 420 characters on the site menu,
         so a reduction that dropped nav, header, footer and anything classed
         "menu" cut 2,100 characters to 600 — and took the show's own
         paragraph with it, on four pages out of six. The model was never
         confused by the menu; it reads past it. Leave the text alone. */
      /* The poster goes in the queue only when the page gave no words of its
         own. Measured on four Eventbrite pages, attaching it where there is
         already prose changed the description not at all and cost 27% more
         input; on the Emmet Ray, where the page says only the title, it is
         the entire description. So: no prose, send the picture. */
      const wordless = !raw.description || echoesTitle(raw.description, raw.title);
      descriptionQueue.set(u, {
        title: raw.title ?? '',
        text: readableText(html, 6000),
        ...(wordless && raw.image ? { image: raw.image } : {}),
        own: true,
      });
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

  /* The same question across pages: one title at one venue published as a
     range and as a day inside it is a series and its dated occurrence, read
     from two event pages. The day is the listing. */
  if (source.pageNodes && out.length > 1) {
    const norm = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const groups = new Map();
    for (const e of out) {
      const k = `${norm(e.title)}|${norm(e.venue)}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    const gone = new Set();
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const nodes = group.map((e) => ({ title: e.title, event: e,
        startDate: e.schedule.date ?? e.schedule.start, endDate: e.schedule.end ?? e.schedule.date }));
      for (const d of source.pageNodes(nodes).dropped) {
        gone.add(d.node.event);
        const line = `${source.id}: ${d.node.event.title} (${d.node.event.via})`;
        const at = report.kept.lastIndexOf(line);
        if (at >= 0) report.kept.splice(at, 1);
        report.dropped.push(`${source.id}: ${d.title} — ${d.why}, on another event page`);
      }
    }
    if (gone.size) return out.filter((e) => !gone.has(e));
  }
  return out;
}

/* What the file on disk says each source found last time. Parsed rather than
   imported: scraped.js is a module with a top-level const, and this only ever
   needs the array out of it. A file that is missing, truncated or not yet in
   this shape returns null, which the caller reads as "nothing to compare
   against" rather than as a source having gone quiet. */
export async function previousListings() {
  let text;
  try { text = await readFile(path.join(root, 'scraped.js'), 'utf8'); }
  catch { return null; }
  const open = text.indexOf('[');
  const close = text.lastIndexOf(']');
  if (open < 0 || close < open) return null;
  let prev;
  try { prev = JSON.parse(text.slice(open, close + 1)); }
  catch { return null; }
  return Array.isArray(prev) ? prev : null;
}

const countBySource = (events) => {
  const counts = new Map();
  for (const e of events) counts.set(e.scrapedFrom, (counts.get(e.scrapedFrom) ?? 0) + 1);
  return counts;
};

/* A failed source keeps what it had: its listings from the last scraped.js,
   less any that have since finished. */
export function carryForward(previous, sourceId, today = todayIso()) {
  if (!Array.isArray(previous)) return [];
  const lastDay = (e) => e.schedule?.end ?? e.schedule?.date ?? e.schedule?.start ?? '';
  return previous.filter((e) => e && e.scrapedFrom === sourceId && lastDay(e) >= today);
}

/* Whether a source read enough of what it set out to read to be published.
   A page not read is a failed follow (an error, a refused or missing page, a
   robots.txt refusal) or one the breaker left alone; more than a third of the
   follows unread and the source counts as failed. */
export function followVerdict(pages) {
  const planned = pages?.followed ?? 0;
  const failed = pages?.followFailures ?? 0;
  const abandoned = pages?.followAbandoned ?? 0;
  const unread = failed + abandoned;
  if (!planned || unread / planned <= FAILED_SHARE) return { failed: false, planned, unread };
  return {
    failed: true, planned, unread,
    why: `${unread} of ${planned} event pages unread (${failed} failed`
      + `${abandoned ? `, ${abandoned} left after ${FOLLOW_BREAKER} failures in a row` : ''}), more than a third`,
  };
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

async function harvestApi(source, records, { today = todayIso() } = {}) {
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

export async function offlinePages(source) {
  const dir = path.join(root, 'scrape', 'fixtures');
  let names = [];
  try { names = await readdir(dir); } catch { return []; }
  const mine = names.filter((n) => n === `${source.id}.html` || n.startsWith(`${source.id}.`));
  return Promise.all(mine.sort().map(async (n) => ({
    url: `${source.url}#${n}`,
    html: await readFile(path.join(dir, n), 'utf8'),
    isIndex: n === `${source.id}.html`,
  })));
}

/* Every listing page a source is read from: `url`, then any `alsoIndex`.
 *
 * One definition, because two places need the same answer and they are 250
 * lines apart — livePages, to know which pages to visit and to mark them
 * isIndex, and main(), to know which urls are listings rather than events
 * when collapseSubsumed folds duplicates. A source whose extra indexes were
 * known to one and not the other would have its listing pages harvested as
 * if they were events. */
export function indexUrls(source) {
  return [source.url, ...(source.alsoIndex ?? [])];
}

export async function livePages(source, browser) {
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  const fetchText = async (u) => {
    const res = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return res && res.ok() ? page.content() : null;
  };

  const pages = [];
  /* `networkidle` by default, because an index page is often the one thing
     here that genuinely needs the JavaScript to have run — Luma renders its
     event anchors client-side, and waiting only for domcontentloaded there
     would read an empty list and report the source as quiet.

     A source can override it for the pages it FOLLOWS, which is a different
     problem: an event page whose JSON-LD is in the initial HTML needs none
     of the ad and analytics traffic that keeps the network busy, and waiting
     for quiet on a heavy page just times out. Eventbrite lost five event
     pages that way on 2026-10-03 — two of them listings the dry run had
     kept, so the cost was real listings, not just time. See `followWait`. */
  const visit = async (url, { wait = 'networkidle', timeout = 45000 } = {}) => {
    const robots = await allowedBy(fetchText, url);
    if (!robots.allowed) { report.skipped.push(`${url} — robots.txt disallows ${robots.rule}`); return null; }
    const res = await page.goto(url, { waitUntil: wait, timeout });
    if (!res || !res.ok()) { report.errors.push(`${url} — HTTP ${res ? res.status() : 'no response'}`); return null; }
    const html = await page.content();
    /* Every listing page, not just source.url. Marking an extra index as an
       event page would send its ItemList through harvest as if the twenty
       names on it were twenty events, which for a listingOnly source is
       precisely what line 78 exists to prevent. */
    pages.push({ url, html, isIndex: INDEXES.includes(url) });

    return html;
  };

  const INDEXES = indexUrls(source);
  const index = await visit(source.url);
  if (index) {
    /* What the page offered against what the cap let through. Luma's city
       page offered thirty-four links and three were reachable in the rendered
       DOM, which is the shape of every silent breakage here so far: the source
       answers, the numbers are small, and nothing says so. */
    /* Links from the markup as well as from the anchors.

       Luma's city page renders three <a> tags to events and describes twenty
       in its ItemList, each with its own url. Those twenty are the events; the
       three are whatever happened to be on screen. Taking urls from the
       structured data too is what lets the rest of them be read at all — and
       reading them is the only way they get a description of their own, since
       the ItemList carries dates and places but no prose. */
    /* A listing-only source publishes nothing from its index, so every
       event named there has to be accounted for: followed, or dropped with
       the reason. Tracking links also drops their query strings, which is
       how one Eventbrite event arrives as three urls. */
    const bare = (u) => {
      if (!source.listingOnly) return u;
      try { const x = new URL(u); x.search = ''; x.hash = ''; return x.toString(); } catch { return u; }
    };
    /* The extra listing pages, read the same way and pooled with the first.
       A failure here is one page's worth of links lost, not the source: the
       index that matters is source.url, and `visit` has already reported
       whatever went wrong. */
    const extra = [];
    for (const u of INDEXES.slice(1)) {
      await new Promise((r) => setTimeout(r, FOLLOW_DELAY_MS));
      try {
        const html = await visit(u);
        if (html) extra.push([u, html]);
      } catch (err) { report.errors.push(`${u} — ${err.message.split('\n')[0]}`); }
    }

    const listed = [index, ...extra.map(([, html]) => html)].flatMap((h) => fromJsonLd(h));
    const fromMarkup = listed
      .map((e) => bare(String(e.url ?? '').trim()))
      .filter((u) => u && source.followLinks && source.followLinks.test(u));
    const anchors = [[source.url, index], ...extra]
      .flatMap(([u, h]) => candidateLinks(h, u, source.followLinks, Infinity))
      .map(bare);
    /* And one event under two hosts — Eventbrite links the same event as
       .ca and .com — is one page to read, not two: the first url wins, which
       is the listing's own JSON-LD. Keyed on the event's number, the only
       part of the url that is the event's. */
    const eventKey = (u) => {
      if (!source.listingOnly) return u;
      try { return /-(\d{6,})\/?$/.exec(new URL(u).pathname)?.[1] ?? u; } catch { return u; }
    };
    /* A source can rule an event out from the listing alone — Eventbrite's
       conferences, by title — and then it is not fetched at all. */
    const ruledOut = new Map();
    if (source.skipBeforeFollow) {
      for (const e of listed) {
        const u = bare(String(e.url ?? '').trim());
        const why = u ? source.skipBeforeFollow(e) : null;
        if (why) ruledOut.set(eventKey(u), why);
      }
    }
    const seenKeys = new Set();
    const all = [...new Set([...fromMarkup, ...anchors])]
      .filter((u) => !ruledOut.has(eventKey(u)))
      .filter((u) => { const k = eventKey(u); if (seenKeys.has(k)) return false; seenKeys.add(k); return true; });
    const take = all.slice(0, source.maxFollow ?? 0);
    pages.offered = all.length + ruledOut.size;
    pages.followed = take.length;
    pages.listed = listed.length;
    pages.listedEvents = listed.map((e) => ({ title: e.title, url: bare(String(e.url ?? '').trim()) }));
    if (source.listingOnly) {
      const followed = new Set(take.map(eventKey));
      for (const e of listed) {
        const u = bare(String(e.url ?? '').trim());
        const name = e.title ?? '(untitled)';
        if (!u) report.dropped.push(`${source.id}: ${name} — listed with no event url`);
        else if (ruledOut.has(eventKey(u))) report.dropped.push(`${source.id}: ${name} — ${ruledOut.get(eventKey(u))} (not fetched)`);
        else if (!source.followLinks || !source.followLinks.test(u)) report.dropped.push(`${source.id}: ${name} — url does not look like an event page (${u})`);
        else if (!followed.has(eventKey(u))) report.dropped.push(`${source.id}: ${name} — past the follow cap of ${source.maxFollow}`);
      }
    }
    pages.followFailures = 0;
    pages.followAbandoned = 0;
    let inARow = 0;
    for (let i = 0; i < take.length; i += 1) {
      const link = take[i];
      /* The breaker: three failures in a row and the rest are left unread,
         each accounted for, rather than fetched into a site that is refusing. */
      if (inARow >= FOLLOW_BREAKER) {
        const rest = take.slice(i);
        pages.followAbandoned = rest.length;
        report.errors.push(`${source.id} — stopped following after ${FOLLOW_BREAKER} failed event pages in a row; ${rest.length} left unread`);
        if (source.listingOnly) {
          for (const u of rest) {
            const named = listed.find((e) => e.url && eventKey(bare(String(e.url).trim())) === eventKey(u));
            report.dropped.push(`${source.id}: ${named?.title ?? u} — not fetched: stopped after ${FOLLOW_BREAKER} failed event pages in a row`);
          }
        }
        break;
      }
      await new Promise((r) => setTimeout(r, FOLLOW_DELAY_MS));   /* one page every 1.5s */
      /* One page timing out is that page lost, not the whole source. It
         used to throw out of here and take every page already read with it;
         now it is counted, and the count decides whether the source's result
         can be trusted (followVerdict). */
      const before = pages.length;
      try { await visit(link, { wait: source.followWait ?? 'networkidle' }); }
      catch (err) { report.errors.push(`${link} — ${err.message.split('\n')[0]}`); }
      if (pages.length === before) {
        pages.followFailures += 1;
        inARow += 1;
        if (source.listingOnly) {
          const named = listed.find((e) => e.url && eventKey(bare(String(e.url).trim())) === eventKey(link));
          report.dropped.push(`${source.id}: ${named?.title ?? link} — event page could not be read (see errors and skipped)`);
        }
      } else inARow = 0;
    }
    report.followFailures[source.id] = pages.followFailures;
  }
  await ctx.close();
  return pages;
}

/* ------------------------------------------------------------------- main */

/* One source, start to finish: read it, harvest it, and decide whether the
   result can be published. Exported so the suite can run a source against a
   fake browser exactly as a poll does. `previous` is the last scraped.js's
   listings, for a source that fails. */
export async function pollSource(source, { browser = null, offline = false, previous = null, today = todayIso() } = {}) {
  let found;
  /* Declared out here because the coverage line below reads it, and an
     api source never sets it. Leaving it inside the else made every source
     throw a ReferenceError before events.push, so seven of them returned
     nothing and the silent-source guard stopped the run — which is the
     guard working, on a fault of mine. */
  let pages = null;
  let carried = false;
  if (source.api) {
    const records = offline ? await offlineRecords(source) : await apiRecords(source);
    if (records.length === 0) report.skipped.push(`${source.id} — nothing fetched`);
    found = await harvestApi(source, records, { today });
  } else {
    pages = offline ? await offlinePages(source) : await livePages(source, browser);
    if (pages.length === 0) report.skipped.push(`${source.id} — nothing fetched`);
    /* Too many event pages unread and what was read is a partial set that
       would silently replace a whole one. The source is treated as failed
       and keeps its listings from the last run — what a failed source has
       always done — instead of publishing the part it managed. */
    const verdict = followVerdict(pages);
    if (verdict.failed) {
      found = carryForward(previous, source.id, today);
      carried = true;
      report.errors.push(`${source.id} — failed: ${verdict.why}. Kept its ${found.length} listing${found.length === 1 ? '' : 's'} from the last run instead of a partial set`);
    } else {
      found = await harvest(source, pages, { today });
    }
  }
  if (!carried && source.maxEvents && found.length > source.maxEvents) {
    /* soonest first, so a cap keeps what is most use */
    found.sort((a, b) => startOf(a).localeCompare(startOf(b)));
    report.skipped.push(`${source.id} — capped at ${source.maxEvents} of ${found.length} events`);
    found = found.slice(0, source.maxEvents);
  }
  /* What the source offered against what came back. A source that answers
     with a page full of links and yields a handful of listings has usually
     broken in a way nothing else here reports: Luma sat at three of
     thirty-four for weeks and every run said success. */
  if (pages && pages.offered != null) {
    const failed = pages.followFailures ?? 0;
    report.coverage.push(
      `${source.id} — ${pages.offered} link${pages.offered === 1 ? '' : 's'} on the page, `
      + `${pages.followed} to read, ${failed} failed`
      + `${pages.followAbandoned ? `, ${pages.followAbandoned} left by the breaker` : ''}, `
      + `${found.length} ${carried ? 'carried over from the last run' : 'kept'}`);
  }
  return found;
}

/* The silent- and shrunk-source checks, with the exemptions applied. A
   source that says it may go quiet — Eventbrite, which can block the poller
   at any time — does not stop the run by doing so. Only its own listings are
   lost; every other source's still come from this poll. */
export function quietSources(before, events, sources, allowSilent = '') {
  const now = countBySource(events);
  const allowed = new Set(String(allowSilent || '').split(',').map((x) => x.trim()).filter(Boolean));
  for (const s of sources) if (s.mayGoQuiet) allowed.add(s.id);
  const ids = sources.map((x) => x.id);
  return {
    silent: silentSources(before, now, ids, allowed),
    shrunk: shrunkSources(before, now, ids, allowed),
  };
}

async function main() {
  let browser = null;
  if (!OFFLINE) {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
  }

  const today = todayIso();
  const previous = OFFLINE ? null : await previousListings();
  const events = [];
  for (const source of enabledSources()) {
    try {
      events.push(...await pollSource(source, { browser, offline: OFFLINE, previous, today }));
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
  /* Which urls are listing pages rather than events: exactly the ones this
     repo configured as sources, including each source's extra indexes. */
  const indexes = new Set(allSources().flatMap(indexUrls).map((u) => String(u ?? '').replace(/\/$/, '')));
  const isIndexUrl = (u) => indexes.has(String(u ?? '').replace(/\/$/, ''));
  const subsumed = collapseSubsumed(events, better, isIndexUrl);
  if (subsumed.dropped) {
    report.skipped.push(`${subsumed.dropped} listing${subsumed.dropped === 1 ? '' : 's'} folded into a fuller copy of the same event`);
  }

  /* The descriptions written since the last poll, and the pages that turned
     out to have none.
     
     Applied here rather than in harvest because it is not a fact about a
     source: every listing on the board goes through the same two questions.
     Does a description written for this url exist? Then use it. Has this
     page been read and found to say nothing about its own event? Then the
     listing comes off the board, because "Listed by Grossman's Tavern." is
     not a description of anything and a card carrying it tells a reader
     nothing they did not already see in the title. */
  const descriptions = await loadDescriptions(root);
  let rewritten = 0;
  const undescribed = [];
  for (const e of events) {
    const url = e.source || e.url;
    if (!url || !needsWriting(e.description, e.title)) continue;
    const written = writtenFor(descriptions, url);
    if (written) { e.description = written; rewritten += 1; continue; }
    /* A page with nothing to say costs the listing its description, not its
       place on the board. Grossman's publishes a band, a date and a time and
       nothing else, 69 times out of 70 — and that still answers "what is on
       tonight", which is what the board is for. Dropping those would have
       taken a third of it, and Toronto's oldest blues bar with it.
       `nothing` means stop asking, not remove. */
    if (isPlaceholder(e.description) && restsAsNothing(descriptions, url, today)) undescribed.push(e);
  }
  /* The venue's own line, for listings still carrying nothing. Applied after
     the written lookup, never over it: a description of this event always
     beats a description of the room it is in. The batch still asks about
     these — see needsWriting's venue-line clause — so an Emmet Ray poster
     can replace it later, and the store's `nothing` marker is what stops
     the asking for a venue like Grossman's that genuinely has none. */
  const lineFor = new Map(allSources().filter((x) => x.venueLine).map((x) => [x.id, x.venueLine]));
  let housed = 0;
  for (const e of events) {
    if (e.description) continue;
    const line = lineFor.get(e.scrapedFrom);
    if (line) { e.description = line; housed += 1; }
  }
  if (housed) report.skipped.push(`${housed} listing${housed === 1 ? '' : 's'} described by their venue's own line`);
  if (rewritten) report.skipped.push(`${rewritten} description${rewritten === 1 ? '' : 's'} written from the page`);
  if (undescribed.length) {
    report.skipped.push(`${undescribed.length} listing${undescribed.length === 1 ? '' : 's'} published with no description — their pages have none`);
  }

  /* What this run read, for the batch script to ask about after the poll.
     Only urls still without a description: one the model has since written,
     or one already written off, is not asked again. */
  for (const [url, v] of descriptionQueue) {
    if (descriptions.written[url] || descriptions.nothing[url]) continue;
    descriptions.queued[url] = v;
  }
  for (const url of Object.keys(descriptions.queued)) {
    if (descriptions.written[url] || descriptions.nothing[url]) delete descriptions.queued[url];
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
  const followLines = Object.entries(report.followFailures).map(([id, n]) => `${id} — ${n} failed follow${n === 1 ? '' : 's'}`);
  for (const [label, list] of [['coverage', report.coverage], ['failed follows', followLines], ['kept', report.kept], ['dropped', report.dropped], ['skipped', report.skipped], ['errors', report.errors]]) {
    if (list.length) console.log(`\n${label}:\n  ` + list.join('\n  '));
  }

  /* The failure this poll cannot see on its own; see silentSources. Offline
     replays fixtures and has no bearing on what the sources hold, so it is
     exempt. To land a poll where a source really has gone quiet, name it:
       ALLOW_SILENT_SOURCES=bentway,evergreen node scrape/run.mjs */
  let silent = [];
  let shrunk = [];
  if (!OFFLINE && previous) {
    ({ silent, shrunk } = quietSources(countBySource(previous), events, enabledSources(), process.env.ALLOW_SILENT_SOURCES));
  }

  /* Loud, and not fatal. See shrunkSources. */
  if (shrunk.length) {
    console.error(`\n${shrunk.length} source${shrunk.length === 1 ? '' : 's'} lost most of what they had:`);
    for (const { id, had, has } of shrunk) console.error(`  ${id} — ${had} last run, ${has} this one`);
    console.error('\nStill written, because a calendar does empty out. But a source that was'
      + '\nproducing and now barely is has usually broken rather than gone quiet:'
      + '\ncheck the log above for what it actually read.');
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
  /* Offline replays fixtures, which say nothing about what the sources hold
     today. Written over scraped.js it replaced the whole board with the two
     fixture sources' dozen events — which is what happened on the Eventbrite
     branch. So it goes to the temp dir, where it can be read and cannot be
     committed by accident. */
  const target = OFFLINE ? path.join(os.tmpdir(), 'explora-scraped.offline.js') : path.join(root, 'scraped.js');
  await writeFile(target, file);
  console.log(`\nwrote ${OFFLINE ? target : 'scraped.js'} with ${events.length} event${events.length === 1 ? '' : 's'}`);

  /* The queue, for the batch script to read after the poll. Never from an
     offline replay: those pages are trimmed fixtures, and queueing them
     would ask the model to describe an event from a page that was never the
     whole page. */
  if (!OFFLINE) {
    await saveDescriptions(root, descriptions);
    const waiting = Object.keys(descriptions.queued).length;
    if (waiting) console.log(`${waiting} listing${waiting === 1 ? '' : 's'} with no description, queued for scripts/write-descriptions.mjs`);
  }

  /* A source that errors should not quietly empty the calendar */
  if (report.errors.length && events.length === 0) process.exitCode = 1;
}

/* Run only when invoked, so scrape/dry-run-eventbrite.mjs can reuse harvest
   and livePages without starting a poll that writes scraped.js. */
const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) main().catch((err) => { console.error(err); process.exitCode = 1; });
