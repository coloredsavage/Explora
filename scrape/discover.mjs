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
import { enabledSources } from './sources.mjs';
import { jsonLdBlocks, readableText, candidateLinks } from './extract.mjs';
import { allowedBy } from './robots.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const UA = 'ExploraCalendarBot/1.0 (+https://github.com/coloredsavage/Explora)';

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

for (const source of enabledSources()) {
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

    const ld = jsonLdBlocks(html);
    report.jsonLd = {
      blocks: ld.length,
      events: ld.filter((n) => /Event$/i.test([].concat(n['@type'] ?? []).join(''))).length,
      types: [...new Set(ld.map((n) => [].concat(n['@type'] ?? []).join('/')))].slice(0, 10),
    };
    report.jsonApis = apis.sort((a, b) => b.points - a.points).slice(0, 5);
    report.followable = candidateLinks(html, source.url, source.followLinks, source.maxFollow ?? 0).length;
    report.textSample = readableText(html, 600);
    report.blocked = /just a moment|checking your browser|cf-chl|access denied/i.test(html);
  } catch (err) {
    report.error = err.message;
  }
  await ctx.close();

  const verdict = report.error ? `could not load — ${report.error}`
    : report.robots && !report.robots.allowed ? `robots.txt disallows ${report.robots.rule} — the poller will skip this`
    : report.blocked ? 'looks like a bot challenge — this is the case a VPS might fix'
    : report.jsonLd?.events > 0 ? `JSON-LD, ${report.jsonLd.events} events — free and exact, no key needed`
    : report.jsonApis?.length ? `a JSON API at ${report.jsonApis[0].url} — free, write a small adapter`
    : 'no structured data — needs an adapter written against the HTML, or the model';

  console.log(`\n${source.id}  ${source.url}`);
  console.log(`  status     ${report.status ?? '—'}`);
  console.log(`  robots     ${report.robots ? (report.robots.allowed ? 'allowed' : 'DISALLOWED ' + report.robots.rule) : '—'}`);
  console.log(`  links      ${report.followable ?? 0} event pages to follow`);
  console.log(`  json-ld    ${report.jsonLd ? `${report.jsonLd.blocks} blocks, ${report.jsonLd.events} events` : '—'}`);
  console.log(`  json apis  ${report.jsonApis?.length ? report.jsonApis.map((a) => `${a.url} (${a.rows} rows)`).join('\n             ') : 'none that look like events'}`);
  console.log(`  verdict    ${verdict}`);

  await writeFile(path.join(outDir, `${source.id}.json`), JSON.stringify(report, null, 2));
  console.log(`  written    scrape/discovery/${source.id}.json`);
}

await browser.close();
