# Eventbrite source — how it works and what it drops

## Terms of Service

**Eventbrite's Terms of Service prohibit automated extraction.** The owner of
this repo knowingly enabled the source anyway on 2026-09-27, accepting the risk
that Eventbrite blocks it or objects. Nothing here claims the source is
ToS-compliant. The same note sits beside the source in `scrape/sources.mjs`.

The v3 API is not an alternative: public event search was withdrawn in 2019 and
what remains only reaches organisations you control.

## How a poll reads it

1. `https://www.eventbrite.ca/d/canada--toronto/all-events/` is fetched. Its
   ItemList JSON-LD names about 20 events **with no prices**, so the page is
   used only as a list of links (`listingOnly`): nothing on it is published.
2. Events whose title already rules them out (conferences, summits,
   networking — see below) are dropped from the listing without being
   fetched (`skipBeforeFollow`), and reported with the reason.
3. Every other event page is followed (`.ca` and `.com`, `-tickets-` and
   `-registration-`; one event number is read once, however many urls link
   to it). A page that times out is reported and does not take the rest of the
   source down with it.
4. Each event page's own JSON-LD decides everything, in `vetEventbrite`
   (`scrape/eventbrite.mjs`), called by `normalize` as the source's `vet`.
   The model is never asked (`noModel`), because a price has to come from
   structured data or not at all.

Every event named on the listing ends up either kept or dropped with a stated
reason; `npm run dry-run:eventbrite` checks that and says so.

## Gates (in order)

| gate | drops | why |
|---|---|---|
| online-only | `eventAttendanceMode` = Online | nowhere to go |
| networking | Luma's list (`scrape/filters.mjs`, now shared) | same problem as Luma |
| professional | symposium, conference, summit, keynote, expo, seminar, professional(s), leadership, small business, business leaders… (title) | "Heart Failure Symposium", "Leadership Summit" got through before |
| BusinessEvent | JSON-LD `@type` BusinessEvent | how Eventbrite files researchED, the summits and the expos |
| professional prose | keynote, professional development, conference… (description) | catches a brand-name title like researchED |
| series | start to end more than 14 days | a weekly night's series node ("Apr 5 – Dec 27") is not a run |
| city | `addressLocality` must be Toronto or a former borough | `IN_TOWN` in normalize accepts Mississauga on purpose (Luma's Salmon Run Hike), which is how DOC Wine at 3045 Southcreek Road, Mississauga passed. Fixed for Eventbrite only, so no other source changes |
| price | see below | an Eventbrite card without a price would stay "Price not listed" forever: the recheck job only fills `data.js` |
| ceiling | over $35 (normalize, unchanged) | the board's promise |

## Price rule

- **Free** only when every ticket is $0 (`AggregateOffer` 0–0).
- Otherwise the cheapest *paid* ticket: `lowPrice` when it is above zero, or
  the cheapest individual `Offer.price` above zero when a page lists them.
- `lowPrice` 0 with `highPrice` above 0 and no per-ticket list: the cheapest
  paid price is not on the page, so the event is **dropped** with that reason
  rather than called Free or guessed.
- A `priceCurrency` other than CAD is dropped with that reason.
- Written like the rest of the board — `Free`, `$12`, `$19.50` — so `price.js`
  buckets it (Free / under $20 / $20 and up). `$0` is never emitted.

## Filing

`classifyEventbriteEvent` reads the title, then the description, then the
venue's name, and returns a category from `CATEGORIES` in `data.js` and a
drawing that exists in `illustrations/` (the suite checks every output of
every rule against both). Parties and DJ nights file like Revival's: `music`
with `art-decks`. Talks are `stage` with `art-lectern`; book launches `books`.

## Safety

- `scraped.js` is not touched by this PR. The branch once had it overwritten
  by a fixtures run (`--offline`), which would have replaced the board with a
  dozen fixture events; `--offline` now writes to the temp dir, and the suite
  checks `scraped.js` is byte-identical after an offline poll.
- `scrape/dry-run-eventbrite.mjs` runs the real `harvest`/`livePages` for this
  one source and writes its report to the temp dir; a destination inside the
  repository is refused.
- In a real poll every source is harvested separately and `scraped.js` is
  rebuilt from all of them, so an Eventbrite failure or empty result can only
  remove Eventbrite's own listings. `mayGoQuiet` keeps it from tripping the
  silent-source guard, which would otherwise stop the whole poll.
