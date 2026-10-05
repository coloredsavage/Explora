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

const EMPTY = { written: {}, shows: {}, nothing: {}, queued: {}, pending: null };

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
    shows: sorted(store.shows ?? {}),
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

/* One show, one description, however many nights it runs.
 *
 * Keyed on venue and title because that is what repeats. Grossman's puts
 * Action Sound Band on twelve times and the Happy Pals eleven; Comedy Bar
 * runs The Pro Show eleven times. Each night is its own url, so a store
 * keyed only on url pays to describe the same band twelve times and gets
 * twelve slightly different answers for one show. Thirty per cent of
 * everything needing a description is a repeat of something else in the
 * same list.
 *
 * Safe because the key is narrow: "Sunday Jam Night Hosted by Ken
 * Yoshioka" and "... Hosted by Rob Quail" are different titles and stay
 * apart, which is right — they are different nights with different hosts. */
export function showKey(venue, title) {
  const v = String(venue ?? '').trim().toLowerCase();
  const t = String(title ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return v && t ? `${v}|${t}` : null;
}

/* The description a listing should carry, or null to leave it alone. The
   url first, because a page that described itself is better evidence than
   another night of the same show; then the show. */
export function writtenFor(store, url, venue, title) {
  const byUrl = store.written?.[url];
  if (byUrl && byUrl.text) return byUrl.text;
  const k = showKey(venue, title);
  const byShow = k ? store.shows?.[k] : null;
  return byShow && byShow.text ? byShow.text : null;
}

/* Which listings need a description written.
 *
 * Three kinds, and the third is the one that is easy to argue yourself out
 * of.
 *
 *   nothing      — empty, or the "Listed by <venue>" placeholder normalize
 *                  falls back to when a source publishes no prose at all.
 *   truncated    — ends in an ellipsis. These are the ones that look fine in
 *                  a diff and are not: accurate and unhelpful. The croissant
 *                  competition read "On Sunday, October 4th, in front of a
 *                  panel of professionals, the finest bakeries in the Toronto
 *                  area will compete for the prizes of Best Croissant &
 *                  Best…" — a sentence that stops before it says what
 *                  happens. A whole short sentence beats most of a long one,
 *                  which is what a rewrite gets you and a longer budget does
 *                  not.
 *   title echo   — the prose begins by repeating the card's own title, so the
 *                  first words of the description tell the reader nothing
 *                  they have not already read directly above it.
 *
 * Still deliberately NOT "every listing the audit flags". `very short` is
 * often the honest answer from a venue that wrote one good line, and
 * `shouting` is a style complaint. Rewriting those spends money to make them
 * longer rather than better. */
export function isPlaceholder(description) {
  const d = String(description ?? '').trim();
  return d === '' || /^Listed by /.test(d);
}

export function needsWriting(description, title, venueLines = []) {
  const d = String(description ?? '').trim();
  if (isPlaceholder(d)) return 'no description';
  /* A venue line is a floor, not an answer. It describes the room, so a
     listing wearing one still wants a description of the event — the Emmet
     Ray's posters supply those. What stops the asking is the store's
     `nothing` marker, not this. */
  if (venueLines.includes(d)) return 'described only by its venue';
  if (/[…]$|\.\.\.$/.test(d)) return 'cut off mid-sentence';
  if (title) {
    const bare = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const t = bare(title);
    if (t.length > 12 && bare(d).startsWith(t)) return 'opens by repeating the title';
  }
  return null;
}
