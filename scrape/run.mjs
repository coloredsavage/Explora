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
import { fromJsonLd, readableText, candidateLinks } from './extract.mjs';
import { normalize, validate } from './normalize.mjs';
import { allowedBy } from './robots.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = new Set(process.argv.slice(2));
const OFFLINE = argv.has('--offline');
const DRY = argv.has('--dry-run');

const UA = 'ExploraCalendarBot/1.0 (+https://github.com/coloredsavage/Explora)';
const today = new Date().toISOString().slice(0, 10);

const report = { kept: [], dropped: [], skipped: [], errors: [] };
const startOf = (e) => (e.schedule.kind === 'day' ? e.schedule.date : e.schedule.start);

/* ------------------------------------------------------------- the sources */

async function harvest(source, pages) {
  const out = [];
  for (const { url, html } of pages) {
    let raws = fromJsonLd(html);

    if (raws.length === 0) {
      if (!process.env.ANTHROPIC_API_KEY) {
        report.skipped.push(`${url} — no JSON-LD and no ANTHROPIC_API_KEY`);
        continue;
      }
      try {
        const { extractWithModel } = await import('./llm.mjs');
        raws = await extractWithModel(readableText(html), { url, today });
      } catch (err) {
        report.errors.push(`${url} — model extraction failed: ${err.message}`);
        continue;
      }
    }

    for (const raw of raws) {
      const result = normalize({ ...raw, url: raw.url ?? url }, source, { today, checked: today });
      if (!result.ok) { report.dropped.push(`${source.id}: ${result.title} — ${result.why}`); continue; }

      const problems = validate(result.event);
      if (problems.length) { report.dropped.push(`${source.id}: ${result.event.title} — ${problems.join(', ')}`); continue; }

      out.push(result.event);
      report.kept.push(`${source.id}: ${result.event.title} (${result.event.via})`);
    }
  }
  return out;
}

/* --------------------------------------------------------------- fetching */

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
      const pages = OFFLINE ? await offlinePages(source) : await livePages(source, browser);
      if (pages.length === 0) report.skipped.push(`${source.id} — nothing fetched`);

      let found = await harvest(source, pages);
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

  /* keep the file stable between runs so an unchanged poll is an empty diff */
  events.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const body = events.length
    ? events.map((e) => '  ' + JSON.stringify(e, null, 2).replace(/\n/g, '\n  ')).join(',\n')
    : '';
  const file = `/* Generated by scrape/run.mjs — do not edit by hand.
   Hand-written listings live in data.js; these are polled from the sources
   in scrape/sources.mjs and merged at load. */

const SCRAPED = [\n${body}\n];\n`;

  console.log(`\nkept ${report.kept.length}   dropped ${report.dropped.length}   skipped ${report.skipped.length}   errors ${report.errors.length}`);
  for (const [label, list] of [['kept', report.kept], ['dropped', report.dropped], ['skipped', report.skipped], ['errors', report.errors]]) {
    if (list.length) console.log(`\n${label}:\n  ` + list.join('\n  '));
  }

  if (DRY) { console.log('\n--dry-run: scraped.js not written'); return; }
  await writeFile(path.join(root, 'scraped.js'), file);
  console.log(`\nwrote scraped.js with ${events.length} event${events.length === 1 ? '' : 's'}`);

  /* A source that errors should not quietly empty the calendar */
  if (report.errors.length && events.length === 0) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
