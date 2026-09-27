#!/usr/bin/env node
/* Poll Eventbrite alone and report what would be kept and what dropped,
 * without touching anything in the repository.
 *
 *   npm run dry-run:eventbrite                 # live: listing + event pages
 *   npm run dry-run:eventbrite -- --offline    # replay scrape/fixtures
 *   npm run dry-run:eventbrite -- --out DIR    # where the report goes
 *
 * It runs the real code — the source entry from sources.mjs, and harvest()
 * and livePages() from run.mjs — so what it reports is what a poll would do.
 * What it does not do is run.mjs's main(), which is the only thing that
 * writes scraped.js. An earlier version of this branch replaced scraped.js
 * with a dry run's dozen events, which would have emptied the board; the
 * report now goes to the temp directory, and a destination inside the
 * repository is refused outright. */

import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* Where the report may go: anywhere but the repository. */
export function reportDir(requested) {
  const dir = path.resolve(requested || path.join(os.tmpdir(), 'explora-eventbrite-dry-run'));
  const rel = path.relative(root, dir);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error(`refusing to write a dry run inside the repository (${dir})`);
  }
  return dir;
}

async function main() {
  const args = process.argv.slice(2);
  const offline = args.includes('--offline');
  const outAt = args.indexOf('--out');
  const dir = reportDir(outAt >= 0 ? args[outAt + 1] : null);

  const { SOURCES } = await import('./sources.mjs');
  const { harvest, livePages, offlinePages, report } = await import('./run.mjs');
  const source = SOURCES.find((s) => s.id === 'eventbrite');

  let browser = null;
  let pages;
  try {
    if (offline) {
      pages = await offlinePages(source);
    } else {
      const { chromium } = await import('playwright');
      browser = await chromium.launch();
      pages = await livePages(source, browser);
    }
  } finally {
    if (browser) await browser.close();
  }
  const kept = await harvest(source, pages);

  const mine = (list) => list.filter((x) => x.startsWith(`${source.id}:`))
    .map((x) => x.slice(source.id.length + 1).trim());
  const dropped = mine(report.dropped);
  const summary = {
    mode: offline ? 'offline (fixtures)' : 'live',
    ranAt: new Date().toISOString(),
    listing: source.url,
    listedOnIndex: pages.listed ?? null,
    linksOffered: pages.offered ?? null,
    followed: pages.followed ?? null,
    eventPagesRead: pages.filter((p) => !p.isIndex).length,
    eventPageUrls: pages.filter((p) => !p.isIndex).map((p) => p.url),
    kept: kept.length,
    dropped: dropped.length,
    errors: report.errors,
    skipped: report.skipped,
    keptEvents: kept.map((e) => ({
      title: e.title,
      date: e.schedule.kind === 'day' ? e.schedule.date : `${e.schedule.start} to ${e.schedule.end}`,
      time: e.schedule.time ?? null,
      entry: e.entry,
      category: e.category,
      art: e.art,
      venue: e.venue,
      address: e.address,
      url: e.url,
    })),
    droppedEvents: dropped,
  };

  /* The promise the source makes: every event the listing names is either
     read or dropped with a reason. Checked here rather than trusted. */
  const accounted = new Set([...kept.map((e) => e.title), ...dropped.map((d) => d.split(' — ')[0])]);
  summary.listedEvents = (pages.listedEvents ?? []).map((e) => ({ ...e, accounted: accounted.has(e.title) }));
  summary.unaccounted = summary.listedEvents.filter((e) => !e.accounted).map((e) => e.title);
  summary.extraLinks = pages.listedEvents
    ? kept.filter((e) => !pages.listedEvents.some((l) => l.title === e.title)).map((e) => `${e.title} (${e.url})`)
    : [];

  console.log(`\nEventbrite dry run (${summary.mode})`);
  console.log(`listed on the index ${summary.listedOnIndex ?? '-'}   links ${summary.linksOffered ?? '-'}   followed ${summary.followed ?? '-'}   event pages read ${summary.eventPagesRead}   kept ${summary.kept}   dropped ${summary.dropped}   errors ${summary.errors.length}`);
  console.log('\nkept:');
  for (const e of summary.keptEvents) {
    console.log(`  ${e.title}\n      ${e.date}${e.time ? ' ' + e.time : ''} · ${e.entry} · ${e.category} · ${e.art}\n      ${e.venue}, ${e.address}`);
  }
  console.log('\ndropped:');
  for (const d of dropped) console.log(`  ${d}`);
  if (summary.errors.length) console.log('\nerrors:\n  ' + summary.errors.join('\n  '));
  if (summary.extraLinks.length) console.log('\nkept from links not in the listing’s JSON-LD:\n  ' + summary.extraLinks.join('\n  '));
  console.log(summary.unaccounted.length
    ? `\nNOT ACCOUNTED FOR (neither kept nor dropped):\n  ${summary.unaccounted.join('\n  ')}`
    : `\nevery event on the listing was kept or dropped with a reason`);

  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `eventbrite-${offline ? 'offline' : 'live'}.json`);
  await writeFile(file, JSON.stringify(summary, null, 2) + '\n');
  console.log(`\nreport written to ${file} (outside the repository; scraped.js untouched)`);
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) main().catch((err) => { console.error(err); process.exitCode = 1; });
