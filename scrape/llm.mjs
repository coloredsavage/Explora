/* The fallback for pages that publish no structured data.
 *
 * Only reached when JSON-LD comes back empty, so on a well-marked-up site this
 * costs nothing. Runs at low effort: reading a page and filling in six fields
 * is not work that repays deep thinking. */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

const Extracted = z.object({
  events: z.array(
    z.object({
      title: z.string().describe('The name of the event as written'),
      startDate: z.string().nullable()
        .describe('ISO date, YYYY-MM-DD. Null if the page gives no date.'),
      endDate: z.string().nullable()
        .describe('ISO date for the last day of a multi-day event, else null'),
      time: z.string().nullable()
        .describe('Time of day as shown, e.g. "7–10pm". Null if not given.'),
      venue: z.string().nullable().describe('Venue name'),
      address: z.string().nullable().describe('Street address including city'),
      entry: z.string().nullable()
        .describe('What it costs to get in, e.g. "Free", "$25". Null if not stated.'),
      description: z.string().nullable()
        .describe('One or two sentences, in the words of the page'),
    }),
  ),
});

const SYSTEM = `You read event pages and return what is actually on them.

Rules:
- Only report events the page states. Never infer, complete, or invent a
  date, price, or address that is not written down.
- A field you cannot find is null. A null is more useful than a guess.
- Ignore navigation, newsletter signups, past events, and other venues'
  listings that happen to be linked.
- Dates must be ISO YYYY-MM-DD. If a year is not given, use the one that
  makes the date fall on or after today.

The description is the one field you write rather than copy. One or two
sentences on what actually happens at the thing — what a person would see or
do if they turned up. Plain and specific, the way you would tell a friend.

Leave out what the rest of the card already says: the date, the time, the
venue, the price. Leave out the credits — who created, produced, directed or
presented it — unless a name is the reason anyone would go. Leave out the
venue's own salesmanship: no "unforgettable", no "you won't want to miss".

If the page never says what happens, the description is null. A null is
better than a paragraph of credits.

Good: "Performers work through cold reads, callbacks and increasingly strange
direction, all of it improvised and different every night."
Bad: "A Bad Dog Theatre Company Production. Created by Bita Joudaki & Nicole
Passmore. Producers: Stephanie Malek & Alia Rasul. Dates: Fridays in
September. Time: 7pm."`;

export async function extractWithModel(text, { url, today, apiKey, summary }) {
  const client = new Anthropic(apiKey ? { apiKey } : {});

  const response = await client.messages.parse({
    model: 'claude-opus-5',
    max_tokens: 16000,
    system: SYSTEM,
    output_config: {
      format: zodOutputFormat(Extracted),
      effort: 'low',
    },
    messages: [{
      role: 'user',
      /* The page's own meta summary goes first when there is one. On a CMS
         the readable text opens with the whole navigation menu, and the
         summary is the part an editor actually wrote about this event. */
      content: [
        `Today is ${today}. This is ${url}.`,
        summary ? `\nThe page summarises itself as:\n${summary}` : '',
        `\nIts readable text:\n\n${text}`,
      ].join(''),
    }],
  });

  /* parsed_output is null when the model's answer failed validation */
  const parsed = response.parsed_output;
  if (!parsed) return [];

  return parsed.events.map((e) => ({ ...e, url, via: 'model' }));
}

/* ------------------------------------------------------------------ price */

/* Asked separately from the extractor above, and about one named event, so it
   cannot answer with a neighbouring listing's price on a page holding several.
   A price the page does not state is null: a plausible-looking guess is worse
   than the "Ticketed" it would replace, because someone acts on it. */
const Price = z.object({
  sameEvent: z.boolean()
    .describe('True only if this page is about the named event'),
  entry: z.string().nullable()
    .describe('Admission exactly as written, e.g. "Free", "$25", ' +
      '"Pay what you can". Null if the page does not state one.'),
  /* The quote is what makes a price checkable without opening the page. A
     figure on its own is unfalsifiable in a diff — "Free" for a museum reads
     the same whether it was read off the page or inferred from the absence of
     a price — and asking for the sentence also makes an answer that is not
     actually on the page harder to produce. */
  evidence: z.string().nullable()
    .describe('The sentence from the page stating this, quoted exactly as ' +
      'written. Null if entry is null.'),
});

const PRICE_SYSTEM = `You read one event page and report what it costs to get in.

Rules:
- Report only what the page states. Never infer a price from a venue's other
  events, a membership rate, a nearby listing, or what such a thing usually
  costs.
- The base admission for a general adult, not a concession, member or group
  rate, and not an optional extra like a workshop, catalogue or firing fee.
- If the page states no admission price, entry is null. Null is the right
  answer far more often than a number is, and is always better than a guess.
- If the page is not about the named event, set sameEvent false and entry null.
- Quote the sentence you took the price from in evidence, word for word from
  the page. If you cannot quote it, you did not read it: return null.`;

export async function extractPriceWithModel(text, { url, title, apiKey }) {
  const client = new Anthropic(apiKey ? { apiKey } : {});

  const response = await client.messages.parse({
    model: 'claude-opus-5',
    max_tokens: 2000,
    system: PRICE_SYSTEM,
    output_config: { format: zodOutputFormat(Price), effort: 'low' },
    messages: [{
      role: 'user',
      content: `The event is "${title}". This is the readable text of ${url}.\n\n${text}`,
    }],
  });

  const parsed = response.parsed_output;
  if (!parsed || !parsed.sameEvent) return { entry: null, evidence: null };
  return { entry: parsed.entry, evidence: parsed.evidence };
}
