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
  makes the date fall on or after today.`;

export async function extractWithModel(text, { url, today, apiKey }) {
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
      content: `Today is ${today}. This is the readable text of ${url}.\n\n${text}`,
    }],
  });

  /* parsed_output is null when the model's answer failed validation */
  const parsed = response.parsed_output;
  if (!parsed) return [];

  return parsed.events.map((e) => ({ ...e, url, via: 'model' }));
}
