#!/usr/bin/env node
/* Write the descriptions the sources did not, from the pages the poll already
 * read — on the Batch API, at half price.
 *
 *   node scripts/write-descriptions.mjs            # collect, then submit
 *   node scripts/write-descriptions.mjs --collect   # only apply a finished batch
 *   node scripts/write-descriptions.mjs --submit    # only send a new one
 *   node scripts/write-descriptions.mjs --dry-run   # say what it would do
 *
 * Two phases, a day apart, because that is what the Batch API is: you submit
 * and come back. Most batches finish inside an hour and the ceiling is 24,
 * so the poll does not wait on it — tonight's run collects last night's
 * answers and queues tonight's questions. A description arriving a day late
 * costs nothing; blocking a poll on it would.
 *
 * Haiku 4.5, and the batch halves it again. The work is bounded — read a page
 * and say what the event is, in two sentences — and every answer is checked
 * here before it is kept: a refusal, a wrapper sentence, something longer
 * than a paragraph or shorter than a clause is thrown away rather than
 * published. That is the same standard the price extractor is held to, and
 * it is why the cheap model is the right one for this and not for prices: a
 * thin description is a worse card, a wrong price sends someone to a door
 * with the wrong money.
 *
 * The model is also allowed to say there is nothing to write. That answer is
 * the useful half of this script — see NOTHING below, and `nothing` in
 * scrape/descriptions.mjs. */

import Anthropic from '@anthropic-ai/sdk';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { load, save, isPlaceholder } from '../scrape/descriptions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry-run');
const ONLY_COLLECT = argv.has('--collect');
const ONLY_SUBMIT = argv.has('--submit');

const MODEL = 'claude-haiku-4-5';
const today = () => new Date().toISOString().slice(0, 10);

/* The exact token the model returns when a page says nothing about its own
   event. A sentinel rather than an empty answer, so "it had nothing to say"
   is distinguishable from "the call failed" — those two must not be treated
   alike, because one drops a listing and the other should retry. */
const NOTHING = 'NOTHING';

const SYSTEM = `You write one- or two-sentence descriptions of events for a
Toronto listings calendar, from the text of the event's own page.

Say what the event IS and what someone attending would experience. Write
plainly, in the third person, present tense. 200 characters is about right
and 320 is the maximum.

Do not include: the date, the time, the price, the address, the venue name,
ticket or booking instructions, age restrictions, or the event's own title
repeated back. All of those are already on the card, beside your sentence.

Do not open with "This event", "Join us", "Come and" or the event's name.
Start with the substance.

Write nothing you did not read on the page. Do not infer what a band
probably sounds like from its name, or what a night is probably like from
its venue. If the page gives a title, a date and nothing else about what the
event actually is, reply with exactly ${NOTHING} and no other text. ${NOTHING}
is the correct and expected answer for a large share of these pages; a
plausible sentence invented from a title is the one answer that is worse than
none.`;

/* The board as published, read the way build-seo.mjs reads it. */
async function board() {
  const ctx = vm.createContext({});
  for (const f of ['price.js', 'data.js', 'scraped.js']) {
    try { vm.runInContext(await readFile(path.join(root, f), 'utf8'), ctx, { filename: f }); }
    catch (e) { if (f !== 'scraped.js') throw e; }
  }
  const EVENTS = vm.runInContext('EVENTS', ctx);
  const SCRAPED = vm.runInContext('typeof SCRAPED !== "undefined" ? SCRAPED : []', ctx);
  return EVENTS.concat(Array.isArray(SCRAPED) ? SCRAPED : []);
}

/* An answer is kept only if it reads like a description. The model is cheap
   and occasionally chatty; this is the gate, not the prompt. */
export function acceptable(text, title) {
  const t = String(text ?? '').trim();
  if (!t || t === NOTHING) return null;
  if (t.length < 40 || t.length > 400) return null;
  /* It explained itself instead of answering. */
  if (/^(here|sure|certainly|i |based on|the page|this page|unfortunately)\b/i.test(t)) return null;
  /* It could not read the page and said so in prose rather than with the
     sentinel, which would otherwise be published as the description. */
  if (/\b(no (further )?(information|details)|does not (say|provide|contain)|insufficient)\b/i.test(t)) return null;
  /* It opened with the title after being told not to. */
  const bare = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (title && bare(t).startsWith(bare(title).slice(0, 24)) && bare(title).length > 12) return null;
  return t;
}

async function collect(store, client) {
  if (!store.pending) { console.log('nothing pending'); return false; }
  const { id, ids } = store.pending;

  const batch = await client.messages.batches.retrieve(id);
  if (batch.processing_status !== 'ended') {
    console.log(`batch ${id} is ${batch.processing_status} — ${batch.request_counts.processing} still processing; leaving it`);
    return false;
  }

  let wrote = 0; let none = 0; let failed = 0; let ignored = 0;
  for await (const r of await client.messages.batches.results(id)) {
    const url = ids[r.custom_id];
    if (!url) continue;
    if (r.result.type !== 'succeeded') { failed += 1; continue; }

    const block = r.result.message.content.find((b) => b.type === 'text');
    const raw = block ? block.text.trim() : '';
    const title = store.queued[url]?.title;
    const good = acceptable(raw, title);

    if (good) { store.written[url] = { text: good, at: today() }; wrote += 1; }
    /* NOTHING only counts against the event's own page. `own` is set by the
       poll and is absent on anything queued before that distinction existed,
       which is treated as not-own: a verdict that would drop a listing is
       not worth guessing at. Those simply go unasked next time, because the
       poll no longer queues index pages at all. */
    else if (raw === NOTHING && store.queued[url]?.own) { store.nothing[url] = today(); none += 1; }
    else if (raw === NOTHING) { ignored += 1; }
    /* Anything else — a refused answer, a wrapper sentence, a paragraph — is
       neither written nor written off. The URL stays unqueued and comes back
       next time the poll finds it still has no description. */
    else failed += 1;

    delete store.queued[url];
  }

  store.pending = null;
  console.log(`collected ${id}: ${wrote} written, ${none} had nothing to say, ${failed} unusable`
    + (ignored ? `, ${ignored} said nothing about a page that was not the event's own (ignored)` : ''));
  return true;
}

async function submit(store, client) {
  const listings = await board();
  const byUrl = new Map();
  for (const e of listings) {
    const url = e.source || e.url;
    if (!url) continue;
    if (!isPlaceholder(e.description)) continue;
    if (store.written[url] || store.nothing[url]) continue;
    if (!store.queued[url]?.text) continue;      /* the poll has not read it yet */
    byUrl.set(url, e);
  }

  if (!byUrl.size) { console.log('nothing to ask about'); return false; }

  const requests = [];
  const ids = {};
  let n = 0;
  for (const [url, e] of byUrl) {
    const key = `d${n++}`;
    ids[key] = url;
    requests.push({
      custom_id: key,
      params: {
        model: MODEL,
        max_tokens: 300,
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: `Event title: ${e.title}\nPage: ${url}\n\nThe readable text of that page:\n\n${store.queued[url].text}`,
        }],
      },
    });
  }

  console.log(`${requests.length} listing${requests.length === 1 ? '' : 's'} with no description and a page read`);
  if (DRY) {
    for (const [, url] of Object.entries(ids).slice(0, 10)) console.log(`   ${byUrl.get(url).title}  (${url})`);
    console.log('--dry-run: no batch submitted');
    return false;
  }

  const batch = await client.messages.batches.create({ requests });
  store.pending = { id: batch.id, at: today(), ids };
  console.log(`submitted ${batch.id} with ${requests.length} requests (collect it on the next run)`);
  return true;
}

async function main() {
  const store = await load(root);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('no ANTHROPIC_API_KEY — descriptions not written');
    return;
  }
  const client = new Anthropic();

  let changed = false;
  if (!ONLY_SUBMIT) changed = (await collect(store, client)) || changed;
  /* Only one batch in flight at a time: a second would ask the same
     questions again, and both would write the same answers. */
  if (!ONLY_COLLECT && !store.pending) changed = (await submit(store, client)) || changed;
  else if (!ONLY_COLLECT && store.pending) console.log('a batch is already in flight — not submitting another');

  if (changed && !DRY) await save(root, store);
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('write-descriptions.mjs')) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
