/* The descriptions the sources did not write, and the ones nobody can.
 *
 * Why this file exists at all: scraped.js is regenerated from scratch every
 * poll, so a description written into it is gone by tomorrow morning. This is
 * the same shape as scrape/price-attempts.json — a small committed JSON file
 * the poll reads and writes, keyed on something that survives a re-poll.
 *
 * Keyed on the listing's source URL, not its id. An id carries the date
 * (`grossmans-the-moving-violations-2026-10-03`), so a weekly residency gets
 * a new one every week and would be rewritten every week for the same night.
 * The URL is the event's page and does not move.
 *
 * Three states per URL, and the third is the point:
 *
 *   written  — a description, rewritten from the page's own text.
 *   nothing  — the page was read and genuinely says nothing about the event.
 *              Grossman's "The Moving Violations" has a title, a date and a
 *              door time and not one word about who they are, on the board
 *              or on its own page. Those listings are dropped rather than
 *              published as "Listed by Grossman's Tavern."
 *   queued   — the page text, waiting for the next batch.
 *
 * `nothing` is dated and expires (NOTHING_RESTS_DAYS), because a venue that
 * posts the blurb a week before the show should not be written off for ever
 * on the strength of one early read. */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const STORE = 'scrape/descriptions.json';

/* How long a "this page says nothing" verdict stands before the page is read
   again. Thirty days matches the price recheck's backoff, for the same
   reason: long enough not to re-ask every night, short enough that a page
   which gains a description is picked up within the month. */
export const NOTHING_RESTS_DAYS = 30;

const EMPTY = { written: {}, nothing: {}, queued: {}, pending: null };

export async function load(root) {
  try {
    const raw = JSON.parse(await readFile(path.join(root, STORE), 'utf8'));
    return { ...EMPTY, ...raw };
  } catch { return { ...EMPTY }; }
}

export async function save(root, store) {
  /* Sorted keys, so an unchanged run is an empty diff rather than a reshuffle. */
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
  const out = {
    written: sorted(store.written),
    nothing: sorted(store.nothing),
    queued: sorted(store.queued),
    pending: store.pending ?? null,
  };
  await writeFile(path.join(root, STORE), JSON.stringify(out, null, 2) + '\n');
}

const daysBetween = (a, b) => Math.floor((Date.parse(a) - Date.parse(b)) / 86400000);

/* Has this page been read and found to say nothing, recently enough to trust? */
export function restsAsNothing(store, url, today) {
  const at = store.nothing?.[url];
  return Boolean(at) && daysBetween(today, at) < NOTHING_RESTS_DAYS;
}

/* The description a listing should carry, or null to leave it alone. */
export function writtenFor(store, url) {
  const hit = store.written?.[url];
  return hit && hit.text ? hit.text : null;
}

/* Which listings still need a description written.
 *
 * Deliberately not "every listing the audit flags". `opens with the title`
 * and `very short` are often the honest answer from a venue that wrote one
 * good line, and rewriting those spends money to make them longer rather
 * than better. This is the set where the source wrote nothing at all: the
 * "Listed by <venue>" placeholder normalize falls back to, and the empty
 * ones. */
export function isPlaceholder(description) {
  const d = String(description ?? '').trim();
  return d === '' || /^Listed by /.test(d);
}
