/* Where the poller looks, and how each result should be filed.
 *
 * Adding a source is meant to be a few lines here. `category` and `art` decide
 * how its events appear; `defaultVenue`/`defaultAddress` fill the gaps for
 * sites that only give a venue name in prose. Set `enabled: false` to park a
 * source without deleting what you learned about it.
 *
 * Two questions before adding one, and they are not the same question.
 *
 * Is it RELEVANT — does whoever wrote the page run the thing it describes?
 * An aggregator is not a schedule. It summarises somebody else's calendar,
 * and a summary drops the exceptions: "Sundays, May to October" is a fair
 * description of a market that happens on four of those Sundays. Every
 * listing that has had to be pulled off this board was on the strength of a
 * page its organiser did not write — a Festmore round-up put the Toronto
 * Flea on twenty-seven Sundays, a BIA page kept a museum class alive two
 * years after it was discontinued, and an aggregator had Pedestrian Sundays
 * running in a year nobody has said it runs.
 *
 * Is it CURRENT — is anything it says still true? This is a fact about its
 * dates, not its markup, and the two come apart more often than you would
 * think. The parked `paradise` entry below is the case to remember: perfect
 * ScreeningEvent JSON-LD with prices, and every date on it months in the
 * past. discover.mjs prints a freshness line and will say STALE outright
 * when a source has dated events and none of them are ahead. Read that line
 * before enabling anything, because the structural verdict above it will
 * happily call such a source ideal.
 *
 * A source that fails either one does not get enabled. Park it with what you
 * learned, which is what the parked entries here are. */

import { asIsoDate } from './normalize.mjs';
import { stripTags, priceFrom, splitPlace, timeRange, fromTribe } from './api.mjs';

/* How many listings to keep from any one source.
 *
 * The board answers "what should we do today" in widening windows — today,
 * this week, this month — so a month is as far out as a listing is much use,
 * and for a venue with something on most nights a month is about thirty
 * listings. That is where this number comes from rather than from taste.
 *
 * It is also free, which is the part worth knowing. The cap is applied in
 * run.mjs after harvest() has already read every page, so a source capped at
 * eight has been paid for in full and then had the rest thrown away —
 * Grossman's returns seventy-seven nights and was keeping twenty-five.
 * Raising it recovers events already extracted and costs nothing.
 *
 * What does cost money is maxFollow, which decides how many pages get read
 * in the first place, and MODEL_CALL_BUDGET in run.mjs, which stops the run
 * spending past a point. Those are the two to think about before widening
 * anything; this one is not. */
const A_MONTH_OF_LISTINGS = 30;

export const SOURCES = [
  {
    id: 'wygo',
    name: 'Wygo',
    url: 'https://wygo.world/o/wygo',
    enabled: true,
    category: 'dropin',
    art: 'art-lights',
    /* Wygo runs one-off happenings across the city, so there is no single
       venue to fall back on; anything without a location is dropped. */
    defaultVenue: null,
    defaultAddress: null,
    /* Follow links that look like individual event pages on the same host. */
    followLinks: /^https:\/\/wygo\.world\/(?!o\/)[a-z0-9-]+$/i,
    maxFollow: 12,
    maxEvents: A_MONTH_OF_LISTINGS,
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
    art: 'art-lectern',
    /* Skim off the most obvious of it. Deliberately narrow: a book launch or
       a talk is worth keeping even when a software company is hosting. */
    exclude: /\b(networking|mixer|housewarming|happy hour|demo day|pitch (night|competition)|founders?|startups?|coworking|mastermind|fintech|saas|b2b|career fair|job fair|hiring|recruit|ama|office hours|speed dating)\b/i,
    defaultVenue: null,
    defaultAddress: null,
    /* Event slugs are short and live at the root; the city page is not one. */
    followLinks: /^https:\/\/lu\.ma\/(?!toronto$|discover|signin|create)[a-z0-9-]{4,}$/i,
    maxFollow: 20,
    maxEvents: A_MONTH_OF_LISTINGS,
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
    art: 'art-market',
    defaultVenue: null,
    defaultAddress: null,
    followLinks: /^https:\/\/www\.eventbrite\.ca\/e\/[a-z0-9-]+-tickets-\d+/i,
    maxFollow: 20,
    maxEvents: A_MONTH_OF_LISTINGS,
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
    maxEvents: A_MONTH_OF_LISTINGS,
  },
  {
    id: 'bentway',
    name: 'The Bentway',
    url: 'https://thebentway.ca/whats-on/',
    /* It publishes its whole calendar as JSON, and did all along. 311 events
       with the dates, the address and the ticket line already parsed, four
       pages of a hundred, and robots.txt disallowing nothing.

       Reading the page instead cost a model call per event and still missed
       things, in three separate ways that the API has by construction:
       /whats-on/ renders one month at a time behind ?date=YYYYMMDD, so every
       October listing — all three Nuit Blanche entries — was invisible;
       maxFollow was below the count of links actually on the page; and
       maxEvents cut soonest-first at ten, which is how Dino Run was fetched,
       read, and then dropped for being eleventh.

       The HTML path below is left configured and is what runs if the API
       ever stops answering. */
    api: {
      url: 'https://thebentway.ca/wp-json/wp/v2/event?per_page=100',
      maxPages: 4,
      map: (rec) => {
        const acf = rec.acf ?? {};
        /* The feed carries its own past/upcoming/ongoing flag, so most of
           311 records are refused before anything else looks at them.
           normalize drops a past date anyway; this just saves the work. */
        if (acf.event_status === 'past') return null;

        const place = splitPlace(acf.location && typeof acf.location === 'object'
          ? acf.location.address : null);
        if (!place) return null;

        return {
          title: rec.title?.rendered,
          startDate: asIsoDate(acf.start_date),
          endDate: asIsoDate(acf.end_date),
          time: timeRange(acf.start_time, acf.end_time),
          venue: place.venue,
          address: place.address,
          url: rec.link,
          /* ticketing_description is the Cost/Ticket field the old comment
             here called a quotable primary source. It still is — it is just
             reachable without reading the page to find it. */
          entry: priceFrom(acf.ticketing_description),
          description: stripTags(rec.excerpt?.rendered),
          via: 'api',
        };
      },
    },
    enabled: true,
    category: 'architecture',
    art: 'art-skates',
    defaultVenue: 'The Bentway',
    defaultAddress: '250 Fort York Blvd, Toronto, ON M5V 3K9',
    /* The fallback, and the reason it is only a fallback. /whats-on/ is the
       real listing page — the old /events/, /programming/ and /calendar/ all
       404 — and it is served whole with nothing disallowed. But there is no
       Event JSON-LD on any event page, only Yoast's WebPage, so this path
       reads through the model: a call per event, for facts the API hands
       over for free.

       Skip skate-trail-closed-N: dead notices that redirect back to the
       index, and there are two of them in every crawl. */
    followLinks: /^https:\/\/thebentway\.ca\/event\/(?!skate-trail-closed)[a-z0-9-]+\/?$/i,
    maxFollow: 30,
    /* One cap for both paths, and above the count either can return. It was
       10, which silently discarded the eleventh-soonest event and everything
       after it. */
    maxEvents: A_MONTH_OF_LISTINGS,
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
    art: 'art-outdoors',
    defaultVenue: 'Evergreen Brick Works',
    defaultAddress: '550 Bayview Ave, Toronto, ON M4W 3X8',
    followLinks: /^https:\/\/www\.evergreen\.ca\/evergreen-brick-work\/(events|activities)\/[a-z0-9-]+\/?$/i,
    maxFollow: 20,
    maxEvents: A_MONTH_OF_LISTINGS,
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
    /* The library runs a great deal that is useful and nothing to do with a
       day out: computer classes, job-hunting help, tax clinics, settlement
       and literacy sessions. They belong in a library's calendar and not in
       an answer to "what should we do today". Author talks, film nights,
       craft afternoons and book clubs all survive this. */
    exclude: /\b(microsoft|ms word|powerpoint|excel|computer (skills|basics|class|help|training)|digital literacy|tech (help|support)|drop-in tech|job (search|club|help)|r[ée]sum[ée]|career|employment|interview skills|tax (clinic|help)|income tax|financial literacy|legal (advice|clinic)|citizenship|newcomer|settlement services|esl\b|english (conversation|practice|class)|literacy (circle|program)|homework (club|help)|tutoring|book a librarian|library (tour|orientation)|blood pressure|flu shot|vaccin|wellness recovery|\bwrap\b|support group|peer support|mental health|coping|caregiver|bereavement|addiction|harm reduction)/i,
    followLinks: /^https:\/\/tpl\.bibliocommons\.com\/events\/[a-f0-9]{6,}/i,
    maxFollow: 20,
    maxEvents: A_MONTH_OF_LISTINGS,
  },
  {
    id: 'comedybar',
    name: 'Comedy Bar',
    url: 'https://comedybar.ca/',
    /* The homepage is the index: a plain fetch returns 248 /shows/<slug>
       links, no JS needed. Its own "SHOW CALENDAR" at /public/Event renders
       only a location picker server-side and is useless here. No JSON-LD of
       any kind on the show pages, so this reads through the model — and with
       248 candidates the follow cap is what keeps the bill down, not the
       source. robots.txt 404s, so nothing is disallowed. */
    enabled: true,
    category: 'comedy',
    art: 'art-comedy',
    /* Two rooms, Bloor and Danforth, and the show pages name which. No
       default address: guessing between them would put people outside the
       wrong building, and normalize drops an event with no address, which is
       the outcome we want when it cannot be read. */
    defaultVenue: null,
    defaultAddress: null,
    followLinks: /^https:\/\/comedybar\.ca\/shows\/[a-z0-9-]+$/i,
    maxFollow: 12,
    maxEvents: A_MONTH_OF_LISTINGS,
  },
  {
    id: 'baddog',
    name: 'Bad Dog Theatre',
    url: 'https://baddogtheatre.com/whats-on',
    /* A Squarespace events collection, server-rendered, but only a rolling
       window of what is coming up — roughly 9 to 11 links. JSON-LD is
       LocalBusiness/WebSite with no Event node, so the model reads these too.
       robots.txt disallows /*?format=json, so do NOT switch to the JSON feed
       even though it answers. */
    enabled: true,
    category: 'comedy',
    art: 'art-comedy',
    /* Bad Dog's own room is on Spadina, but it also stages shows at partner
       venues, so the address has to come from the page rather than a default
       that would quietly send people to the wrong one. */
    defaultVenue: null,
    defaultAddress: null,
    followLinks: /^https:\/\/baddogtheatre\.com\/whats-on\/\d{4}\/\d{1,2}\/\d{1,2}\/[a-z0-9-]+$/i,
    maxFollow: 10,
    maxEvents: A_MONTH_OF_LISTINGS,
  },
  /* ------------------------------------------------------------------------
     Music. The category had nothing in it and the calendar has had `music`
     since the beginning, so every live listing on the board was hand-written.

     All three run The Events Calendar, so all three read through fromTribe
     and cost nothing to poll. They were picked for fitting what this
     calendar is for — a $12 jazz set and a $20 party clear the ceiling
     easily — rather than for being the biggest rooms in town. Resident
     Advisor, Songkick and Bandsintown all have better coverage and all three
     forbid this in their terms; two of them name this kind of crawler in
     robots.txt. They are not options.
     ------------------------------------------------------------------------ */
  {
    id: 'revival',
    name: 'Revival Event Venue',
    url: 'https://www.revivaleventvenue.ca/events/',
    enabled: true,
    category: 'music',
    art: 'art-music',
    /* Its venue object carries a full address, so these stand unused unless
       a listing arrives without one. */
    defaultVenue: 'Revival Event Venue',
    defaultAddress: '783 College St, Toronto, ON M6G 1C5',
    api: {
      url: 'https://www.revivaleventvenue.ca/wp-json/tribe/events/v1/events?per_page=50',
      maxPages: 2,
      map: fromTribe,
    },
    maxEvents: A_MONTH_OF_LISTINGS,
  },
  {
    id: 'emmetray',
    name: 'The Emmet Ray',
    url: 'https://www.theemmetray.com/events/',
    /* Jazz most nights, $12 to $15 at the door, which is the part of the
       city's music this calendar is actually for. */
    enabled: true,
    category: 'music',
    art: 'art-music',
    /* Its listings name the room — "Back Viewing Room" — and no street, so
       the address has to come from here. 924 College Street is what its own
       contact page states; nothing else on the site gives one. */
    defaultVenue: 'The Emmet Ray',
    defaultAddress: '924 College St, Toronto, ON',
    api: {
      url: 'https://www.theemmetray.com/wp-json/tribe/events/v1/events?per_page=50',
      maxPages: 2,
      map: fromTribe,
    },
    maxEvents: A_MONTH_OF_LISTINGS,
  },
  {
    id: 'grossmans',
    name: 'Grossman\u2019s Tavern',
    url: 'https://grossmanstavern.com/events/',
    enabled: true,
    category: 'music',
    art: 'art-music',
    /* 377 Spadina, not 379 — its own site says so twice and a guess would
       have put the door two buildings along. The feed sends an empty venue
       object on every record, so this is the only address there is. */
    defaultVenue: 'Grossman\u2019s Tavern',
    defaultAddress: '377 Spadina Ave, Toronto, ON',
    api: {
      url: 'https://grossmanstavern.com/wp-json/tribe/events/v1/events?per_page=50',
      maxPages: 2,
      map: fromTribe,
    },
    /* Its cost field is empty on every listing. The room is known for free
       and pay-what-you-can nights, and that is exactly why nothing is filled
       in here: what the room usually does is not what tonight costs, and the
       recheck asks the page rather than assuming. These arrive under "price
       not listed" until it does. */
    maxEvents: A_MONTH_OF_LISTINGS,
  },
  {
    id: 'paradise',
    name: 'Paradise Theatre',
    url: 'https://paradiseonbloor.com/',
    /* Parked, and worth keeping parked in writing because it is the most
       convincing bad source anyone has found here. It serves real
       ScreeningEvent JSON-LD with offers and prices — by every structural
       measure the ideal fast path, no model needed — and the nodes on its
       homepage were dated 2025-02-17 when it was probed, eighteen months
       stale. Every listing would be dropped as already past and the source
       would quietly yield nothing.

       This is the source discovery's freshness line was written for. Run
       `node scrape/discover.mjs --all paradise` before ever enabling it: if
       it still reports nothing ahead, the markup is fine and the calendar
       behind it is not. */
    enabled: false,
    category: 'film',
    art: 'art-film',
    defaultVenue: 'Paradise Theatre',
    defaultAddress: '1006 Bloor St W, Toronto, ON M6H 1M2',
    followLinks: /^https:\/\/paradiseonbloor\.com\/event\/[a-z0-9-]+\/?$/i,
    maxFollow: 12,
    maxEvents: A_MONTH_OF_LISTINGS,
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
    maxEvents: A_MONTH_OF_LISTINGS,
  },
  {
    id: 'blogto',
    name: 'blogTO',
    url: 'https://www.blogto.com/events/',
    /* Discovery: HTTP 403 to a headless browser. Refuses automated access
       whatever robots.txt says. Park it. */
    enabled: false,
    category: 'festival',
    art: 'art-market',
    followLinks: /^https:\/\/www\.blogto\.com\/events\/[a-z0-9-]+\/?$/i,
    maxFollow: 20,
    maxEvents: A_MONTH_OF_LISTINGS,
  },
];

export const enabledSources = () => SOURCES.filter((s) => s.enabled !== false);

/* Discovery can look at the parked ones too — that is the point of parking
   them rather than deleting them. */
export const allSources = () => SOURCES;
