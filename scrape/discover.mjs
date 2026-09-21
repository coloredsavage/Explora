#!/usr/bin/env node
/* Look at a source once and report the cheapest way to read it.
 *
 *   node scrape/discover.mjs            # every enabled source
 *   node scrape/discover.mjs wygo       # just one
 *
 * Answers, per site, in order of preference:
 *   1. Does it publish JSON-LD?           -> free, exact, no model
 *   2. Does its JavaScript call a JSON API? -> free, usually cleaner than the page
 *   3. Neither                             -> a hand-written adapter, or the model
 *
 * A single-page app usually falls into (2): the page you see is assembled from
 * a request you can read directly. */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { enabledSources, allSources } from './sources.mjs';
import { jsonLdBlocks, readableText, candidateLinks, fromJsonLd } from './extract.mjs';
import { allowedBy, USER_AGENT } from './robots.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith('-'));
const sources = args.includes('--all') ? allSources() : enabledSources();
/* One name, defined beside the rules it is matched against. */
const UA = USER_AGENT;
const today = new Date().toISOString().slice(0, 10);

/* Does this JSON look like a list of events? */
function scoreJson(value) {
  const rows = Array.isArray(value) ? value
    : Array.isArray(value?.data) ? value.data
    : Array.isArray(value?.events) ? value.events
    : Array.isArray(value?.results) ? value.results
    : Array.isArray(value?.items) ? value.items
    : null;
  if (!rows || rows.length === 0) return null;

  const keys = new Set(rows.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : [])));
  const has = (re) => [...keys].some((k) => re.test(k));
  const points =
    (has(/date|start|begins|when/i) ? 2 : 0) +
    (has(/name|title|headline/i) ? 2 : 0) +
    (has(/venue|location|place|address|where/i) ? 1 : 0) +
    (has(/price|cost|ticket|offer/i) ? 1 : 0);
  return points >= 3 ? { rows: rows.length, keys: [...keys].slice(0, 20), points } : null;
}

const browser = await chromium.launch();
const outDir = path.join(root, 'scrape', 'discovery');
await mkdir(outDir, { recursive: true });

for (const source of sources) {
  if (only.length && !only.includes(source.id)) continue;

  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  const apis = [];

  page.on('response', async (res) => {
    const type = res.headers()['content-type'] ?? '';
    if (!type.includes('json')) return;
    try {
      const body = await res.json();
      const score = scoreJson(body);
      if (score) apis.push({ url: res.url(), status: res.status(), ...score });
    } catch { /* not parseable, not interesting */ }
  });

  const report = { source: source.id, url: source.url };
  try {
    const fetchText = async (u) => {
      const r = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return r && r.ok() ? page.content() : null;
    };
    report.robots = await allowedBy(fetchText, source.url);

    const res = await page.goto(source.url, { waitUntil: 'networkidle', timeout: 45000 });
    report.status = res ? res.status() : null;
    const html = await page.content();

    /* Structure is only half of whether a source is worth having. The other
       half is whether anything it says is still true — see the freshness
       block below. */
    const dates = [];
    const collect = (markup) => {
      for (const e of fromJsonLd(markup)) {
        const d = String(e.startDate ?? '').slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dates.push(d);
      }
    };
    collect(html);

    const ld = jsonLdBlocks(html);
    report.jsonLd = {
      blocks: ld.length,
      events: ld.filter((n) => /Event$/i.test([].concat(n['@type'] ?? []).join(''))).length,
      types: [...new Set(ld.map((n) => [].concat(n['@type'] ?? []).join('/')))].slice(0, 10),
    };
    report.jsonApis = apis.sort((a, b) => b.points - a.points).slice(0, 5);
    const links = candidateLinks(html, source.url, source.followLinks, source.maxFollow ?? 0);
    report.followable = links.length;

    /* The index page is the wrong place to judge a site. An events listing is
       often a bare list of links whose detail pages carry the structured data
       — which is exactly what Wygo does — so sample a couple of them before
       concluding there is nothing to read. */
    report.samples = [];
    for (const link of links.slice(0, 3)) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const r = await page.goto(link, { waitUntil: 'networkidle', timeout: 45000 });
        const sub = await page.content();
        collect(sub);
        const subLd = jsonLdBlocks(sub);
        report.samples.push({
          url: link,
          status: r ? r.status() : null,
          events: subLd.filter((n) => /Event$/i.test([].concat(n['@type'] ?? []).join(''))).length,
          types: [...new Set(subLd.map((n) => [].concat(n['@type'] ?? []).join('/')))].slice(0, 6),
        });
      } catch (err) {
        report.samples.push({ url: link, error: err.message });
      }
    }

    report.dates = dates;
    report.textSample = readableText(html, 600);
    report.blocked = /just a moment|checking your browser|cf-chl|access denied/i.test(html)
      || (report.status !== null && report.status >= 400);
  } catch (err) {
    report.error = err.message;
  }
  await ctx.close();

  const sampleEvents = (report.samples ?? []).reduce((n, s) => n + (s.events ?? 0), 0);

  /* The Paradise Theatre trap, which the handover describes and nothing here
     could see. paradiseonbloor.com serves real ScreeningEvent JSON-LD with
     offers and prices — the ideal fast-path source by every structural
     measure — and the nodes on its homepage were dated eighteen months in the
     past. normalize would drop every one as already past and the source would
     yield nothing, after discovery had called it perfect.

     A source is only worth enabling if it is both relevant and current, and
     currency is a fact about its dates rather than its markup. */
  const seen = (report.dates ?? []).slice().sort();
  const ahead = seen.filter((d) => d >= today);
  report.freshness = seen.length
    ? { events: seen.length, upcoming: ahead.length, oldest: seen[0], newest: seen[seen.length - 1] }
    : null;

  const staleFeed = seen.length > 0 && ahead.length === 0;

  const verdict = report.error ? `could not load — ${report.error}`
    : report.robots && !report.robots.allowed ? `robots.txt disallows ${report.robots.rule} — the poller will skip this`
    : report.status === 404 ? 'HTTP 404 — the URL is wrong or the page moved, not a refusal'
    : report.status !== null && report.status >= 400 ? `HTTP ${report.status} to a headless browser — refusing automated access`
    : report.blocked ? 'looks like a bot challenge — this is the case a VPS might fix'
    : staleFeed ? `STALE — ${seen.length} events marked up and not one in the future, newest ${seen[seen.length - 1]}. `
      + 'The markup is fine and the calendar behind it is not; every listing would be dropped as already past'
    : report.jsonLd?.events > 0 ? `JSON-LD on the index, ${report.jsonLd.events} events — free and exact, no key needed`
    : sampleEvents > 0 ? `JSON-LD on the event pages (${sampleEvents} in ${report.samples.length} sampled) — free and exact, no key needed`
    : report.jsonApis?.length ? `a JSON API at ${report.jsonApis[0].url} — free, write a small adapter`
    : report.followable === 0 ? 'no event links and no structured data — check the URL is the right listing page'
    : 'no structured data on the index or the pages sampled — needs an adapter, or the model';

  console.log(`\n${source.id}${source.enabled === false ? '  [parked]' : ''}  ${source.url}`);
  console.log(`  status     ${report.status ?? '—'}`);
  console.log(`  robots     ${report.robots ? (report.robots.allowed ? 'allowed' : 'DISALLOWED ' + report.robots.rule) : '—'}`);
  console.log(`  links      ${report.followable ?? 0} event pages to follow`);
  console.log(`  json-ld    ${report.jsonLd ? `${report.jsonLd.blocks} blocks, ${report.jsonLd.events} events` : '—'}`);
  for (const smp of report.samples ?? []) {
    console.log(`  sampled    ${smp.url}`);
    console.log(`             ${smp.error ? 'error: ' + smp.error : `HTTP ${smp.status}, ${smp.events} events, types: ${smp.types.join(', ') || 'none'}`}`);
  }
  console.log(`  freshness  ${report.freshness
    ? `${report.freshness.upcoming} of ${report.freshness.events} dated events still ahead (${report.freshness.oldest} … ${report.freshness.newest})`
    : 'no dated events found to judge'}`);
  console.log(`  json apis  ${report.jsonApis?.length ? report.jsonApis.map((a) => `${a.url} (${a.rows} rows)`).join('\n             ') : 'none that look like events'}`);
  console.log(`  verdict    ${verdict}`);

  await writeFile(path.join(outDir, `${source.id}.json`), JSON.stringify(report, null, 2));
  console.log(`  written    scrape/discovery/${source.id}.json`);
}

await browser.close();
