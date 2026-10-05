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
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { load, save, needsWriting, showKey } from '../scrape/descriptions.mjs';
import { allSources } from '../scrape/sources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry-run');
const ONLY_COLLECT = argv.has('--collect');
const ONLY_SUBMIT = argv.has('--submit');

/* Opus, and the reasoning is the opposite of #33's.
 *
 * That commit — "Stop spending Opus money on reading event listings" — moved
 * EXTRACTION to Haiku and was right to: six fields, every one checked by
 * normalize and validate afterwards, up to 121 pages a run, and a wrong
 * answer is dropped rather than published. Bounded work, high volume,
 * self-correcting.
 *
 * Writing a description is none of those things. There is no right answer to
 * check it against, nothing downstream catches a dull one, and the whole
 * value of the output is the part a cheap model loses. On six Bad Dog pages,
 * same prompt, same text: Haiku wrote "Graduates of the Bad Dog Academy's
 * longform improv studio series perform Harold and Armando formats, directed
 * by Alex Tindal"; Opus wrote the same thing and then "Pay-what-you-can at
 * the door, and free for Bad Dog students". It found the hour-long running
 * time on four of six, the ticket conditions on three, and on the page with
 * nothing to say it returned the sentinel where Haiku replied "I cannot
 * complete this task as the page provides only the event title..." in prose.
 *
 * And the volume is nothing like extraction's, because the store is keyed by
 * url and a description does not change: after the catch-up this writes only
 * new listings. $0.62 once, then about $2.77 a month at batch rates against
 * Haiku's $0.55. Two dollars a month is the right price for the difference
 * between a card worth reading and a card that is merely accurate.
 *
 * The descriptions on this board that read best were written this way — an
 * Opus session reading each page, in #36, when re-polling was too expensive.
 * This is that, on a schedule. */
const MODEL = 'claude-opus-5';
const today = () => new Date().toISOString().slice(0, 10);

/* The exact token the model returns when a page says nothing about its own
   event. A sentinel rather than an empty answer, so "it had nothing to say"
   is distinguishable from "the call failed" — those two must not be treated
   alike, because one drops a listing and the other should retry. */
const NOTHING = 'NOTHING';

/* The prompt, and what measuring it taught.
 *
 * It has been rewritten twice. The second version asked for specifics —
 * "prefer the specific, checkable thing", with the house voice shown in
 * examples — and strengthened the licence to answer NOTHING. On identical
 * input it then answered NOTHING for five pages out of six that the first
 * version had described perfectly well ("Bad Dog Academy's advanced improv
 * students perform Harold and Narrative Process formats, two structured
 * styles of long-form improvisation comedy"). Raising the bar and widening
 * the escape hatch in the same breath taught it to bail on any ordinary
 * page. Both were reverted.
 *
 * So this is the first version plus the one thing the second genuinely won
 * on: it stops the marketing. Where the old prompt wrote "Toronto's sharpest
 * improvisers ... loud, wild, and welcoming to single people who just want
 * to party", the rule below gets "Improvisers mine dating disasters and
 * romantic misfires for fast comedy."
 *
 * And it no longer forbids every concrete fact. "Do not include the date,
 * the price, the venue" was meant to stop the card being read back, and it
 * also stopped "runs to October 26", "no booking needed" and "free for
 * students" — the conditions that make a description worth reading. Restate
 * nothing; qualify freely. */
const SYSTEM = `You write one- or two-sentence descriptions of events for a
Toronto listings calendar, from the text of the event's own page.

Say what the event IS and what someone attending would experience. Write
plainly, in the third person, present tense. 200 characters is about right
and 320 is the maximum.

Do not restate the card. It already shows the title, the date, the start
time, the price and the venue, so do not open by repeating the title, do not
name the venue or its street, and do not simply recite those five facts back. You may include a condition a reader
could not otherwise see: that the season ends this month, that no booking is
needed, that it is free for some people and not others, that tickets are
released at a particular time and go quickly.

Do not write marketing. No "join us", "don't miss", "unforgettable",
"vibrant", "iconic", "a must for", no "sharpest" or "hottest", no second
person, no exclamation marks. Describe, do not sell.

Do not open with "This event", "Join us", "Come and" or the event's name.
Start with the substance.

Write nothing you did not read on the page. Do not infer what a band
probably sounds like from its name, or what a night is probably like from
its venue. If the page gives a title, a date and nothing else about what the
event actually is, reply with exactly ${NOTHING} and no other text.`;

/* The POLLED half of the board, and only that half.
 *
 * data.js is never offered to the model, and the reason is measured rather
 * than assumed. Asked to rewrite eight hand-written descriptions it already
 * had, Haiku produced worse copy every time: three of the eight opened with
 * the same sentence ("Local farmers and food producers sell..."), the season
 * end dates went missing, the AGO's "tickets are released online at 10am the
 * Monday before, two per person, and they go" became "with advance ticket
 * registration required", and St. Lawrence came back NOTHING against a
 * description that was fine. None of the 52 hand-written listings qualify
 * under needsWriting today, so this changes no behaviour — it is here so
 * that an ellipsis landing in data.js one day cannot hand somebody's own
 * writing to a cheap model to flatten. */
async function board() {
  const ctx = vm.createContext({});
  /* data.js is still loaded: scraped.js is read in the same context and the
     files share helpers. It is simply never returned. */
  for (const f of ['price.js', 'data.js', 'scraped.js']) {
    try { vm.runInContext(await readFile(path.join(root, f), 'utf8'), ctx, { filename: f }); }
    catch (e) { if (f !== 'scraped.js') throw e; }
  }
  const SCRAPED = vm.runInContext('typeof SCRAPED !== "undefined" ? SCRAPED : []', ctx);
  return Array.isArray(SCRAPED) ? SCRAPED : [];
}

/* An answer is kept only if it reads like a description. The model is cheap
   and occasionally chatty; this is the gate, not the prompt. */
export function acceptable(text, title) {
  const t = String(text ?? '').trim();
  if (!t || t === NOTHING) return null;
  if (t.length < 40 || t.length > 420) return null;
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

export const idFor = (url) => 'u' + createHash('sha1').update(url).digest('hex').slice(0, 24);

/* Collect any finished batch whose answers were never applied, mapping its
   custom_ids back through the queue. The safety net for a submit whose
   record did not survive. */
async function recover(store, client) {
  const known = new Map();
  for (const url of Object.keys(store.queued)) known.set(idFor(url), url);
  let found = 0;
  for await (const b of client.messages.batches.list({ limit: 20 })) {
    if (b.processing_status !== 'ended') continue;
    if (store.pending && b.id === store.pending.id) continue;
    let applied = 0;
    for await (const r of await client.messages.batches.results(b.id)) {
      const url = known.get(r.custom_id);
      if (!url || r.result.type !== 'succeeded') continue;
      if (store.written[url] || store.nothing[url]) continue;
      const text = (r.result.message.content.find((x) => x.type === 'text')?.text ?? '').trim();
      const good = acceptable(text, store.queued[url]?.title);
      if (good) { store.written[url] = { text: good, at: today() }; applied += 1; }
      else if (text === NOTHING && store.queued[url]?.own) { store.nothing[url] = today(); applied += 1; }
      if (applied) delete store.queued[url];
    }
    if (applied) { console.log(`recovered ${applied} from ${b.id}`); found += applied; }
  }
  return found;
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

    if (good) {
      store.written[url] = { text: good, at: today() };
      /* And against the show, so the other eleven nights of The Happy Pals
         read it instead of being asked again. */
      const k = store.queued[url]?.show;
      if (k) { (store.shows ??= {})[k] = { text: good, at: today() }; }
      wrote += 1;
    }
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

/* What the model is shown. The poster is attached only where the poll found
   the page wordless — see the queue in run.mjs — and it is introduced
   explicitly, because an unannounced image invites a description OF the
   picture rather than of the event. */
function userContent(url, title, q) {
  const text = `Event title: ${title}\nPage: ${url}\n\nThe readable text of that page:\n\n${q.text}`;
  if (!q.image) return text;
  return [
    { type: 'image', source: { type: 'url', url: q.image } },
    { type: 'text', text: `${text}\n\nThat page says nothing about the event in words. Its poster is attached. Read any writing ON the poster and use it. Do not describe the photograph — who is pictured, what they are wearing, what the room looks like — and if the poster carries no words beyond the title, reply ${NOTHING}.` },
  ];
}

const VENUE_LINES = allSources().map((x) => x.venueLine).filter(Boolean);

async function submit(store, client) {
  const listings = await board();
  const byUrl = new Map();
  const askedShows = new Set();
  for (const e of listings) {
    const url = e.source || e.url;
    if (!url) continue;
    if (!needsWriting(e.description, e.title, VENUE_LINES)) continue;
    if (store.written[url] || store.nothing[url]) continue;
    if (!store.queued[url]?.text) continue;      /* the poll has not read it yet */
    /* One request per show. Grossman's runs Action Sound Band twelve times
       and each night is its own url; asking twelve times buys twelve
       slightly different descriptions of one band. The first night's answer
       is recorded against the show and the rest read it. */
    const k = showKey(e.venue, e.title);
    if (k) {
      if (askedShows.has(k) || store.shows?.[k]) continue;
      askedShows.add(k);
      store.queued[url].show = k;
    }
    byUrl.set(url, e);
  }

  if (!byUrl.size) { console.log('nothing to ask about'); return false; }

  const requests = [];
  const ids = {};
  for (const [url, e] of byUrl) {
    /* The custom_id is a hash of the url, not a counter.
    
       A counter means the id->url map lives only in descriptions.json, and
       on 2026-10-03 a push race rolled that file back after a batch had
       already been submitted: paid for, finished, and unreadable, because
       nothing left could say which d0..d3 was which page. A hash can be
       recomputed from the queue on the next run, so an orphaned batch is
       always collectable. See --recover. */
    const key = idFor(url);
    ids[key] = url;
    requests.push({
      custom_id: key,
      params: {
        model: MODEL,
        max_tokens: 400,
        system: SYSTEM,
        /* Two sentences from a page already in front of it. Nothing here
           needs deliberation, and effort is what keeps this at batch prices
           rather than Opus prices. */
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: userContent(url, e.title, store.queued[url]) }],
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
  /* Anything finished that the store never recorded — see idFor. */
  if (argv.has('--recover')) changed = (await recover(store, client)) > 0 || changed;
  /* Only one batch in flight at a time: a second would ask the same
     questions again, and both would write the same answers. */
  if (!ONLY_COLLECT && !store.pending) changed = (await submit(store, client)) || changed;
  else if (!ONLY_COLLECT && store.pending) console.log('a batch is already in flight — not submitting another');

  if (changed && !DRY) await save(root, store);
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('write-descriptions.mjs')) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
