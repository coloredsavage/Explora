# Eventbrite source — how it works and what it drops

## Terms of Service

**Eventbrite's Terms of Service prohibit automated extraction.** The owner of
this repo knowingly enabled the source anyway on 2026-09-27, accepting the risk
that Eventbrite blocks it or objects. Nothing here claims the source is
ToS-compliant. The same note sits beside the source in `scrape/sources.mjs`.

The v3 API is not an alternative: public event search was withdrawn in 2019 and
what remains only reaches organisations you control.

## The 405, and why the entry point is `/ttd/`

The source produced nothing at all for its first six days. Every poll from
2026-09-28 reported `eventbrite — nothing fetched` and `HTTP 405` against
`/d/canada--toronto/all-events/`, on GitHub's runners and then on the VPS.

It is not the user-agent and not robots.txt — the same URL answers 200 from a
residential address. It is the address. Both machines are in datacenters, and
that is what Eventbrite is refusing. A VPS does not fix it: checked from
187.77.25.242 on 2026-10-03, the 405 is identical.

What the block actually covers is much narrower than "Eventbrite refuses
bots". From the VPS, same day:

| path | status |
|---|---|
| `/robots.txt` | 200 |
| `/` | 200 |
| `/e/<event>` — an event page, all 3 JSON-LD blocks | **200** |
| `/sitemap_xml/sitemap_index.xml` | 200 |
| `/ttd/canada--toronto/` | **200**, 61 unique `/e/` links |
| `/poi/canada--toronto/<venue>/` | **200**, ~64 links each, 98 Toronto venues |
| `/d/canada--toronto/...` — search | **405** |
| `/api/v3/destination/search/` | **405** |

The search is walled; the catalogue is not. `/ttd/` ("things to do in
Toronto") is reached from Eventbrite's own sitemap index, which `robots.txt`
advertises. It carries *more* of the city than the page it replaces — 61
links against about 20 — so this is not a workaround that costs coverage.

If `/ttd/` is ever walled too, the 98 `/poi/` venue pages are the next move:
98 fetches instead of one, for a wider net.

## How a poll reads it

1. `https://www.eventbrite.ca/ttd/canada--toronto/` is fetched. Its links are
   used only as a list (`listingOnly`): nothing on the page is published. Its
   ItemList JSON-LD names only about 8 of them, so most arrive from the
   anchors — `livePages` unions both, which is why the count is 26 and not 8.
2. Events the listing alone rules out are dropped without being fetched
   (`skipBeforeFollow`) and reported with the reason: one that `data.js`
   already carries by hand (same url, or same event number), or one whose
   title is plainly a business event (see below). The title list is kept
   narrow on purpose, because a false positive here is never even fetched.
3. Every other event page is followed (`.ca` and `.com`, `-tickets-` and
   `-registration-`; one event number is read once, however many urls link
   to it), at least a second apart. A page that fails is reported and does
   not take the rest of the source down with it — but three failures in a row
   stop the following (the circuit breaker, which applies to every source),
   and if more than a third of the event pages go unread the source is
   treated as failed and keeps its listings from the previous `scraped.js`
   instead of publishing a partial set. The failed-follow count is in the run
   report and the dry run.
4. If a dated node and a series node whose dates contain it describe one
   event — on one page, or as two event pages with the same title and venue
   (the live listing linked MOODY OFFICE's series and its dated night as two
   event numbers) — the series node is dropped (`pageNodes`), so a short run
   does not show as a range card beside the night's own card. A series of
   more than 14 days is refused on its own, whatever else is on the page.
5. Each event page's own JSON-LD decides everything, in `vetEventbrite`
   (`scrape/eventbrite.mjs`), called by `normalize` as the source's `vet`.
   The model is never asked (`noModel`), because a price has to come from
   structured data or not at all.

Every event named on the listing ends up either kept or dropped with a stated
reason; `npm run dry-run:eventbrite` checks that and says so.

## Gates (in order)

| gate | drops | why |
|---|---|---|
| online-only | `eventAttendanceMode` = Online | nowhere to go |
| hand-listed | url or event number already in `data.js` | `app.js` concatenates `data.js` and `scraped.js` without deduping; The Reheat Podcast is hand-listed with a `submitted` tag |
| networking | Luma's list (`scrape/filters.mjs`, shared) | same problem as Luma |
| professional (title) | symposium, conference, summit (not "the summit"), keynote, seminar, professional(s), leadership, small business, business leaders, data centre, cloud expo… and expo / convention / forum / fair **only with an industry word in front** (tech, trade, franchise, cloud, career…) | "Heart Failure Symposium", "Leadership Summit" got through before. Bare expo, convention, forum, jobs, careers and marketing were removed: they dropped Toronto Comic Expo, an anime convention, a community forum on transit and a Steve Jobs screening |
| BusinessEvent | JSON-LD `@type` BusinessEvent | how Eventbrite files researchED, the summits and the expos |
| professional (description) | keynote, professional development, CPD, networking event, symposium, trade show, B2B, thought leaders… | catches a brand-name title like researchED. "conference" and "summit" are not on this list: in prose they are a hike reaching the summit |
| series | start to end more than 14 days | a weekly night's series node ("Apr 5 – Dec 27") is not a run |
| city | `addressLocality` (tidied: "Toronto, ON", "City of Toronto") must be Toronto or a former borough | `IN_TOWN` in normalize accepts Mississauga on purpose (Luma's Salmon Run Hike), which is how DOC Wine at 3045 Southcreek Road, Mississauga passed. Fixed for Eventbrite only, so no other source changes |
| price | see below | an Eventbrite card without a price would stay "Price not listed" forever: the recheck job only fills `data.js` |
| ceiling | over $35 (normalize, unchanged) | the board's promise |

## Price rule

- Only offers still on sale count: `availability` SoldOut or OutOfStock is
  left out. Everything sold out is dropped with that reason.
- An offer with child offers is a summary of them; the children are read,
  inheriting the parent's currency and availability.
- Every figure is read strictly. `'TBD'`, `''` and anything else that is not a
  number is **unreadable** (the event is dropped, never called Free); a
  negative figure is refused; `'12,50'` is read as $12.50 and `'1,250.00'` as
  1250; other commas are unreadable. `$`, `C$`, `CA$` and `CAD` around a
  figure are allowed.
- Every counted offer must name its currency (`priceCurrency`), and it must be
  CAD. Missing or foreign: dropped with the reason.
- **Free** only when every ticket on sale is $0 (`AggregateOffer` 0–0).
- Otherwise the cheapest *paid* ticket: `lowPrice` when it is above zero, or
  the cheapest individual `Offer.price` above zero when a page lists them.
- `lowPrice` 0 with `highPrice` above 0 and no per-ticket list: the cheapest
  paid price is not on the page, so the event is **dropped** with that reason
  rather than called Free or guessed.
- Written like the rest of the board — `Free`, `$12`, `$19.50` — so `price.js`
  buckets it (Free / under $20 / $20 and up). `$0` is never emitted.

## Filing

`classifyEventbriteEvent` reads the title, then the description, then the
venue's name, and returns a category from `CATEGORIES` in `data.js` and a
drawing that exists in `illustrations/` (the suite checks every output of
every rule against both). Parties and DJ nights file like Revival's: `music`
with `art-decks` — but not a tea party (food) or a watch party. Talks are
`stage` with `art-lectern`. "Book" counts only when it is not a booking verb
("Book now", "Book your tickets", "Book a table"), and a launch is `books` only
with real book context: a bookshop, an author, a novel or memoir, a
publisher or imprint (Knopf, Coach House…), or "<title> by <Name>". "Rock" and
"metal" are music except in rock climbing and metal casting; a comic expo is
not comedy.

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
  silent-source guard, which would otherwise stop the whole poll; the suite
  runs that guard with Eventbrite gone quiet and checks the poll carries on.
- A source that fails part-way (more than a third of event pages unread)
  keeps its previous listings, less any already finished, instead of writing
  a partial set.
- The workflow runs `npm test` before polling, so the suite must not depend
  on the date. It pins `today` for every `harvest`/`normalize` call and has
  been run under `faketime` at 2026-10-05, 2026-11-01 and 2027-06-01.
