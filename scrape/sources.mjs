/* Where the poller looks, and how each result should be filed.
 *
 * Adding a source is meant to be a few lines here. `category` and `art` decide
 * how its events appear; `defaultVenue`/`defaultAddress` fill the gaps for
 * sites that only give a venue name in prose. Set `enabled: false` to park a
 * source without deleting what you learned about it. */

export const SOURCES = [
  {
    id: 'wygo',
    name: 'Wygo',
    url: 'https://wygo.world/o/wygo',
    enabled: true,
    category: 'dropin',
    art: 'art-star',
    /* Wygo runs one-off happenings across the city, so there is no single
       venue to fall back on; anything without a location is dropped. */
    defaultVenue: null,
    defaultAddress: null,
    /* Follow links that look like individual event pages on the same host. */
    followLinks: /^https:\/\/wygo\.world\/(?!o\/)[a-z0-9-]+$/i,
    maxFollow: 12,
  },
  {
    id: 'luma',
    name: 'Luma',
    url: 'https://lu.ma/toronto',
    enabled: true,
    category: 'dropin',
    art: 'art-mic',
    defaultVenue: null,
    defaultAddress: null,
    /* Event slugs are short and live at the root; the city page is not one. */
    followLinks: /^https:\/\/lu\.ma\/(?!toronto$|discover|signin|create)[a-z0-9-]{4,}$/i,
    maxFollow: 20,
    maxEvents: 12,
  },
  {
    id: 'eventbrite',
    name: 'Eventbrite',
    url: 'https://www.eventbrite.ca/d/canada--toronto/free--events/',
    /* Parked: the search page answers HTTP 405 to a headless browser and
       yields no links, so it refuses automated access regardless of what
       robots.txt allows. Eventbrite has an API — that is the sanctioned
       route if this source is worth having. */
    enabled: false,
    category: 'dropin',
    art: 'art-tent',
    defaultVenue: null,
    defaultAddress: null,
    followLinks: /^https:\/\/www\.eventbrite\.ca\/e\/[a-z0-9-]+-tickets-\d+/i,
    maxFollow: 20,
    maxEvents: 12,
  },
];

export const enabledSources = () => SOURCES.filter((s) => s.enabled !== false);
