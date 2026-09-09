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
    /* Luma's Toronto feed is mostly startup and tech networking. Filing it
       under its own category keeps it out of the way of the rest of the
       calendar and one click from hidden. */
    category: 'social',
    art: 'art-mic',
    /* Skim off the most obvious of it. Deliberately narrow: a book launch or
       a talk is worth keeping even when a software company is hosting. */
    exclude: /\b(networking|mixer|housewarming|happy hour|demo day|pitch (night|competition)|founders?|startups?|coworking|mastermind|fintech|saas|b2b|career fair|job fair|hiring|recruit|ama|office hours|speed dating)\b/i,
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

  /* ------------------------------------------------------------------------
     Candidates, parked until discovery says how each one is best read. Run
     `npm run discover -- --all` (or dispatch the workflow with discover
     ticked) to get a verdict for every one of them in a single pass, then
     enable the ones that come back with structured data.

     Venue-specific sources carry defaultVenue/defaultAddress: their listings
     often name only the event, and a fixed address is a fact about the venue
     rather than a guess about the event.
     ------------------------------------------------------------------------ */
  {
    id: 'harbourfront',
    name: 'Harbourfront Centre',
    url: 'https://harbourfrontcentre.com/whats-on/',
    /* Discovery: 200 and robots-allowed, but the event pages carry only
       WebPage/ImageObject/BreadcrumbList — no schema.org Event. Needs a
       hand-written adapter or the model. */
    enabled: false,
    category: 'art',
    art: 'art-gallery',
    defaultVenue: 'Harbourfront Centre',
    defaultAddress: '235 Queens Quay W, Toronto, ON M5J 2G8',
    followLinks: /^https:\/\/harbourfrontcentre\.com\/(events?|whats-on)\/[a-z0-9-]+\/?$/i,
    maxFollow: 20,
    maxEvents: 12,
  },
  {
    id: 'bentway',
    name: 'The Bentway',
    url: 'https://thebentway.ca/whats-on/',
    /* The old URL (/events/) 404'd, and so do /programming/ and /calendar/;
       /whats-on/ is the real listing page and always was. It is served
       whole — plain fetch sees all 24 links — and robots.txt disallows
       nothing. No Event JSON-LD anywhere on the event pages, only Yoast's
       WebPage, so this one reads through the model rather than the fast
       path. Worth the tokens: every page renders a Cost/Ticket field, which
       is a quotable primary source for a price. */
    enabled: true,
    category: 'architecture',
    art: 'art-skates',
    defaultVenue: 'The Bentway',
    defaultAddress: '250 Fort York Blvd, Toronto, ON M5V 3K9',
    /* Skip skate-trail-closed-N: they are dead notices that redirect back to
       the index, and there are two of them in every crawl. */
    followLinks: /^https:\/\/thebentway\.ca\/event\/(?!skate-trail-closed)[a-z0-9-]+\/?$/i,
    maxFollow: 20,
    maxEvents: 10,
  },
  {
    id: 'evergreen',
    name: 'Evergreen Brick Works',
    url: 'https://www.evergreen.ca/evergreen-brick-works/whats-on/',
    /* Both halves were wrong, which is why discovery saw a healthy 200 and
       nothing to follow: the old URL 301s here, and the old pattern looked
       for event pages at the root. They live under /evergreen-brick-work/ —
       singular 'work', no s — split across /events/ and /activities/.
       Server-rendered, nothing disallowed. The event pages do return a
       ld+json block, but it is Yoast WebPage/Breadcrumb with no Event node,
       so this reads through the model too — do not mistake the block for a
       fast path. About half the cards link off to third-party ticketing and
       are skipped, which is expected. Its index also carries expired and
       undated items; normalize.mjs already drops both. */
    enabled: true,
    category: 'dropin',
    art: 'art-ravine',
    defaultVenue: 'Evergreen Brick Works',
    defaultAddress: '550 Bayview Ave, Toronto, ON M4W 3X8',
    followLinks: /^https:\/\/www\.evergreen\.ca\/evergreen-brick-work\/(events|activities)\/[a-z0-9-]+\/?$/i,
    maxFollow: 20,
    maxEvents: 10,
  },
  {
    id: 'tpl',
    name: 'Toronto Public Library',
    url: 'https://tpl.bibliocommons.com/v2/events',
    /* Discovery: JSON-LD on the event pages, 1 of 1 sampled, types Library and
       Event. Free programs in every corner of the city — the closest match in
       spirit to what this calendar already carries. Branch addresses vary, so
       no default: an event that does not name its branch is dropped. */
    enabled: true,
    category: 'dropin',
    art: 'art-books',
    followLinks: /^https:\/\/tpl\.bibliocommons\.com\/events\/[a-f0-9]{6,}/i,
    maxFollow: 20,
    maxEvents: 12,
  },
  {
    id: 'akimbo',
    name: 'Akimbo',
    url: 'https://akimbo.ca/listings/',
    /* Discovery: 200 with 20 followable links, but the listing pages carry no
       Event data — and several are calls for submissions rather than dated
       events. Would need the model plus a filter. */
    enabled: false,
    /* Gallery and artist-run-centre listings. Already the source behind one
       hand-written entry, so the editorial match is known to be good. */
    category: 'art',
    art: 'art-sculpture',
    followLinks: /^https:\/\/akimbo\.ca\/listings\/[a-z0-9-]+\/?$/i,
    maxFollow: 20,
    maxEvents: 12,
  },
  {
    id: 'blogto',
    name: 'blogTO',
    url: 'https://www.blogto.com/events/',
    /* Discovery: HTTP 403 to a headless browser. Refuses automated access
       whatever robots.txt says. Park it. */
    enabled: false,
    category: 'festival',
    art: 'art-tent',
    followLinks: /^https:\/\/www\.blogto\.com\/events\/[a-z0-9-]+\/?$/i,
    maxFollow: 20,
    maxEvents: 10,
  },
];

export const enabledSources = () => SOURCES.filter((s) => s.enabled !== false);

/* Discovery can look at the parked ones too — that is the point of parking
   them rather than deleting them. */
export const allSources = () => SOURCES;
