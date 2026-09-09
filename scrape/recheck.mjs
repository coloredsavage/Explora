#!/usr/bin/env node
/* Look up the prices that data.js is missing, from each listing's own source.
 *
 *   node scrape/recheck.mjs             # only listings with no known price
 *   node scrape/recheck.mjs --all       # every listing, to catch a change
 *   node scrape/recheck.mjs --dry-run   # report, write nothing
 *   node scrape/recheck.mjs --offline   # replay scrape/fixtures, no network
 *
 * The poller discovers new events into scraped.js and never looks at the
 * hand-written listings again. That is why thirteen of them said "Ticketed"
 * and nothing more: the price was published on the venue's page all along and
 * nobody went back for it. This closes that loop.
 *
 * It only ever proposes. The run edits data.js and the workflow opens a pull
 * request; a person still decides what the calendar claims something costs.
 * A wrong price is worse than a missing one — someone turns up with the wrong
 * money — so every rule here fails towards leaving the listing alone. */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { fromJsonLd, readableText } from './extract.mjs';
import { allowedBy } from './robots.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = new Set(process.argv.slice(2));
const ALL = argv.has('--all');
const DRY = argv.has('--dry-run');
const OFFLINE = argv.has('--offline');

const UA = 'ExploraCalendarBot/1.0 (+https://github.com/coloredsavage/Explora)';
const report = { found: [], changed: [], unchanged: [], nothing: [], skipped: [], errors: [] };

/* --------------------------------------------------------------- loading */

/* data.js and price.js are plain browser scripts. Running them in a vm is how
   this reads the same definitions the page does, rather than a copy. */
export async function loadSite(dir = root) {
  const ctx = vm.createContext({});
  for (const f of ['price.js', 'data.js']) {
    vm.runInContext(await readFile(path.join(dir, f), 'utf8'), ctx, { filename: f });
  }
  return {
    events: vm.runInContext('EVENTS', ctx),
    priceOf: vm.runInContext('priceOf', ctx),
  };
}

/* ------------------------------------------------------------- extracting */

/* Two events on one page, and the offer belongs to whichever one the listing
   is about. Compare on words, so "Art Toronto 2026" still matches "Art
   Toronto", but "Fall Members' Opening" does not match "Winter Solstice". */
export function bestMatch(candidates, title) {
  const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const want = words(title);
  if (!want.size) return null;

  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    const got = words(c.title);
    if (!got.size) continue;
    let hits = 0;
    for (const w of want) if (got.has(w)) hits++;
    /* against the shorter side, so a long page title does not dilute a match */
    const score = hits / Math.min(want.size, got.size);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore >= 0.6 ? best : null;
}

/* What we will accept as a price, having asked for one. Anything vaguer than
   this is not an answer — "varies", "see website", "from $20 depending" — and
   is left alone rather than written down as fact. */
export function acceptable(entry) {
  if (typeof entry !== 'string') return null;
  const t = entry.trim();
  if (!t || t.length > 60) return null;
  if (/^free\b/i.test(t)) return t;
  if (/^pay[- ]what[- ]you[- ](can|want|wish|choose)$/i.test(t)) return t;
  if (/^\$\s*\d/.test(t)) return t.replace(/(\$\d+)\.00\b/g, '$1');
  return null;
}

/* --------------------------------------------------------------- patching */

/* A surgical edit, not a rewrite. data.js is hand-ordered and full of comments
   that a regenerate would flatten, so this finds the one object and touches
   the one line. It returns null rather than guessing if the shape is not what
   it expects — a patcher that half-matches would corrupt verified data. */
export function patchEntry(src, id, entry) {
  const idLine = new RegExp(`^ {4}id: '${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}',$`, 'm');
  const m = idLine.exec(src);
  if (!m) return null;

  const close = src.indexOf('\n  },\n', m.index);
  if (close === -1) return null;
  const block = src.slice(m.index, close);
  const quoted = `'${entry.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

  const existing = /^ {4}entry: .*,$/m.exec(block);
  if (existing) {
    const patched = block.slice(0, existing.index) +
      `    entry: ${quoted},` +
      block.slice(existing.index + existing[0].length);
    return src.slice(0, m.index) + patched + src.slice(close);
  }

  /* new field goes where the others put it: straight after category */
  const cat = /^ {4}category: .*,$/m.exec(block);
  if (!cat) return null;
  const at = cat.index + cat[0].length;
  const patched = block.slice(0, at) + `\n    entry: ${quoted},` + block.slice(at);
  return src.slice(0, m.index) + patched + src.slice(close);
}

/* --------------------------------------------------------------- fetching */

async function priceFor(listing, html, url) {
  const onPage = fromJsonLd(html);
  const match = bestMatch(onPage, listing.title);
  const fromLd = match && acceptable(match.entry);
  if (fromLd) return { entry: fromLd, via: 'json-ld' };

  if (!process.env.ANTHROPIC_API_KEY) {
    report.skipped.push(`${listing.id} — no price in JSON-LD and no ANTHROPIC_API_KEY`);
    return null;
  }
  const { extractPriceWithModel } = await import('./llm.mjs');
  const said = await extractPriceWithModel(readableText(html), { url, title: listing.title });
  const ok = acceptable(said);
  if (!ok) {
    report.nothing.push(`${listing.id} — the page does not state a price`);
    return null;
  }
  return { entry: ok, via: 'model' };
}

/* ------------------------------------------------------------------- main */

async function main() {
  const { events, priceOf } = await loadSite();

  const targets = events.filter((ev) => {
    if (!ev.source) return false;
    return ALL || priceOf(ev) === 'unknown';
  });

  console.log(`${targets.length} listing${targets.length === 1 ? '' : 's'} to check` +
    (ALL ? ' (--all)' : ' with no known price'));
  if (!targets.length) return;

  let browser = null;
  let page = null;
  if (!OFFLINE) {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    const ctx = await browser.newContext({ userAgent: UA });
    page = await ctx.newPage();
  }

  let src = await readFile(path.join(root, 'data.js'), 'utf8');
  const fetchText = async (u) => {
    const res = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return res && res.ok() ? page.content() : null;
  };

  for (const listing of targets) {
    try {
      if (OFFLINE) { report.skipped.push(`${listing.id} — offline`); continue; }

      const robots = await allowedBy(fetchText, listing.source);
      if (!robots.allowed) {
        report.skipped.push(`${listing.id} — robots.txt disallows ${robots.rule}`);
        continue;
      }
      /* domcontentloaded, then a bounded wait for the network to settle.
         Waiting on networkidle outright loses the listing to any page that
         never goes idle — a chat widget or an analytics beacon is enough, and
         ago.ca's press releases are one: the first live run spent 45 seconds
         there and timed out with the price sitting in the HTML all along. */
      const res = await page.goto(listing.source, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!res || !res.ok()) {
        report.errors.push(`${listing.id} — HTTP ${res ? res.status() : 'no response'} at ${listing.source}`);
        continue;
      }
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

      const found = await priceFor(listing, await page.content(), listing.source);
      await new Promise((r) => setTimeout(r, 1500));      /* one page every 1.5s */
      if (!found) continue;

      const was = listing.entry ?? null;
      if (was === found.entry) { report.unchanged.push(`${listing.id} — still ${was}`); continue; }

      const next = patchEntry(src, listing.id, found.entry);
      if (!next) {
        report.errors.push(`${listing.id} — could not patch data.js; edit it by hand`);
        continue;
      }
      src = next;
      const line = `${listing.id} — ${was ? `${was} -> ${found.entry}` : `${found.entry}`} (${found.via})`;
      (was ? report.changed : report.found).push(line);
    } catch (err) {
      report.errors.push(`${listing.id} — ${err.message}`);
    }
  }
  if (browser) await browser.close();

  const wrote = report.found.length + report.changed.length;
  console.log(`\nfilled ${report.found.length}   changed ${report.changed.length}   ` +
    `unchanged ${report.unchanged.length}   no price on page ${report.nothing.length}   ` +
    `skipped ${report.skipped.length}   errors ${report.errors.length}`);
  for (const [label, list] of [
    ['filled in', report.found], ['changed', report.changed],
    ['unchanged', report.unchanged], ['no price on the page', report.nothing],
    ['skipped', report.skipped], ['errors', report.errors],
  ]) if (list.length) console.log(`\n${label}:\n  ` + list.join('\n  '));

  if (DRY) { console.log('\n--dry-run: data.js not written'); return; }
  if (!wrote) { console.log('\nNothing to write.'); return; }
  await writeFile(path.join(root, 'data.js'), src);
  console.log(`\nwrote data.js with ${wrote} price${wrote === 1 ? '' : 's'}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
