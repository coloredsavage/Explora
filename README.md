# Explora

**What should we do today? — Toronto.** A calendar of free museum nights, farmers' markets, fleas, exhibitions and street
festivals in Toronto, laid out as a horizontally-scrolling board that runs from
today outward: **Today → This week → This month → This year**.

A Toronto recreation of [What should we do
today?](https://senyil.com/what-should-we-do-today/) by Muharrem Şenyıl.

## Running it

No build step and no dependencies — open `index.html`, or serve the folder:

```sh
npx http-server .
```

## Typography

**Inter**, self-hosted from `fonts/`, on every platform — including Apple ones.
The system stack behind it is a fallback for the moment before the file lands,
not a second design.

One weight, medium — body, cards, headings, all of it — so one weight is all
that ships. Headings still name it explicitly, because they are `h1`/`h2`/`h3`
and the browser would otherwise make them bold, and there is no bold file to
be bold with. It is preloaded, being needed for first paint.
`font-display: swap` means text paints immediately in the fallback and reflows
when Inter arrives, rather than holding the page blank.

Two files, not one, because of `unicode-range`. The latin subset covers the
page; the latin-ext subset exists for one line — "Muharrem Şenyıl" in the
credit — and `unicode-range` keeps it off the wire for anyone whose page never
renders those glyphs. Both faces carry a range, because a face declared
without one claims every codepoint and would win the match.

Do not add SF Pro font files to this repository. Apple's licence covers
designing and mocking up interfaces for Apple platforms; it does not permit
redistributing the files or embedding them in a web page, and a public repo
served by Pages does both.

## Deploying

Pushing to `main` publishes the site to GitHub Pages via
`.github/workflows/pages.yml`. There is no build: the repository *is* the
artifact, uploaded as-is and served from the root.

Asset URLs carry `?v=dev` in the source; the workflow rewrites that to the
commit SHA before uploading. Without it a browser can hold a fresh `index.html`
alongside a cached older `app.js`, and that pairing throws inside the click
handler — the page renders but nothing responds, with no visible clue why.

**One-time setup:** in **Settings → Pages**, set *Source* to **GitHub Actions**.
The workflow cannot do this for itself — creating the Pages site is beyond what
the workflow token is granted, and `configure-pages` fails with *Resource not
accessible by integration* until the setting exists. Once it is set, every push
to `main` deploys.

**Pages is no longer the only way the site gets published.** The VPS does the
same job, from the same `main`, and is ready to take the domain — see below.
Until DNS moves, Pages is what `explora.city` resolves to, and while the
GitHub account is locked for billing it does not rebuild at all: the VPS
pushes fresh listings and the site serves whatever Pages last managed to
deploy. `curl -sI https://explora.city | grep last-modified` is the check that
tells a fresh repository from a stale site.

## Serving the site from the VPS

Everything is built and verified; only the DNS record still points at GitHub.

| | |
|---|---|
| vhost | `scripts-vps/explora.city.nginx.conf` → `/etc/nginx/sites-available/explora.city` |
| webroot | `/var/www/explora/current` — a symlink into `releases/<sha>/` |
| deploy | `scripts-vps/run-deploy.sh`, on `explora-deploy.timer` every 5 minutes |
| staging URL | `https://explora.187-77-25-242.sslip.io/` — this box, no DNS needed |

`run-deploy.sh` does what `pages.yml` does and in the same order: `build-seo.mjs`,
the `?v=dev` → commit-sha cache bust, then the repository as-is. It checks the
bust applied, that JSON-LD is present and that the sitemap is non-empty
*before* publishing, then swaps a symlink — one rename, so no request ever
sees a half-copied tree. Five releases are kept, so rolling back is:

```sh
ssh beebot-vps 'ln -sfn /var/www/explora/releases/<sha> /var/www/explora/.t \
  && mv -Tf /var/www/explora/.t /var/www/explora/current'
```

The five-minute timer is the push-to-deploy Pages gave for free. Worst-case
lag between a push to `main` and the site is five minutes; an unchanged `main`
costs half a second.

**The cutover**, when you want it — nothing below is reversible in under the
DNS TTL, which is why it is not done yet:

```sh
# 1. a certificate for the real names (the vhost already answers to them)
ssh beebot-vps 'certbot --nginx -d explora.city -d www.explora.city --redirect'

# 2. point the domain at the box, replacing the four GitHub Pages A records
#    explora.city.      A      187.77.25.242
#    www.explora.city.  CNAME  explora.city.

# 3. once it has propagated
curl -sI https://explora.city/ | grep -i server      # expect nginx, not GitHub.com
```

Then Pages can be turned off in **Settings → Pages**, and `pages.yml` deleted.
Leave both until step 3 passes: while DNS is in flight, either may answer.

## The daily poll runs on the VPS

Since 2026-10-03 the schedule lives on `beebot-vps`, not in Actions:

| | |
|---|---|
| timer | `explora-poll.timer` — 08:30 `America/Toronto`, `Persistent=true` |
| runs | `/opt/Explora/scripts-vps/run-poll.sh` |
| checkout | `/opt/Explora`, pulled `--ff-only` at the top of every run |
| key | `ANTHROPIC_API_KEY` in `/etc/explora/poll.env`, mode 600 |
| push | deploy key `beebot-vps (poll lane)`, straight to `main` |

```sh
ssh beebot-vps 'systemctl list-timers explora-poll.timer'   # when it next fires
ssh beebot-vps 'journalctl -u explora-poll -n 100 --no-pager'
ssh beebot-vps 'POLL_DRY_RUN=1 /opt/Explora/scripts-vps/run-poll.sh'  # no commit
```

08:30 is chosen against `explora-reel.timer` at 09:45: the reel reads
`/opt/Explora` for the listings it posts, so the poll has to land first. That
ordering is new — on Actions the reel read whatever the checkout happened to
hold.

It pushes to `main` rather than opening a pull request, which the Actions lane
did. The review that gate was meant to provide had already stopped happening:
nine poll PRs were open and unmerged on 2026-10-03, the oldest from 09-13. The
guards that do the real work are in the poller either way — the went-quiet
check, the $35 ceiling, the three audits — and `git log -p scraped.js` is the
review after the fact.

## How it is put together

| File | What it holds |
| --- | --- |
| `index.html` | Page structure, the About column, and the inline SVG sprite of event illustrations |
| `styles.css` | Design tokens, the column board, cards, filter sheet, event modal |
| `data.js` | `CATEGORIES` and `EVENTS` — the only file you edit to change listings |
| `price.js` | The price rule, shared by the page and by `scrape/recheck.mjs` |
| `app.js` | Expands schedules into occurrences, renders the columns, drives the filter and modal |
| `art/prompts.json` | One image prompt per event, plus the shared style string |
| `scripts/generate-art.mjs` | Generates `art/<id>.png` and wires it into `data.js` |
| `.github/workflows/pages.yml` | Publishes the repository to GitHub Pages on every push to `main` |
| `.github/workflows/scrape.yml` | The poll, by hand only — the daily schedule moved to the VPS on 2026-10-03 |
| `scripts-vps/run-poll.sh` | The daily poll as the VPS runs it, plus its systemd service and timer |
| `scrape/` | The poller: sources, extractors, gates, and an offline test suite |
| `scraped.js` | Generated by the poller. Merged with `data.js` at load; never edit by hand |
| `hero.png` | The sidebar image. Replace it with any picture; the drawn streetcar shows if it is missing |
| `fonts/` | Inter, self-hosted — two weights, latin subset, SIL Open Font License |

### Adding an event

Append an entry to `EVENTS` in `data.js`:

```js
{
  id: 'kensington-pedestrian-sundays',       // unique; also the deep-link hash
  title: 'Pedestrian Sundays in Kensington',
  category: 'flea',                          // key from CATEGORIES
  art: 'art-lamp',                           // any <symbol> id in index.html
  venue: 'Kensington Market',
  address: 'Augusta Ave & Baldwin St, Toronto, ON M5T 2L7',
  entry: 'Free',                             // optional; shown as the Entry row
  url: 'https://www.pskensington.ca/',       // where a visitor should go
  source: 'https://www.todocanada.ca/...',   // where the schedule was confirmed
  checked: '2026-09-08',                     // when it was last confirmed
  unconfirmed: 'Date not yet posted…',       // optional; shows a caution in the modal
  description: 'Cars out, everyone else in.',
  schedule: { kind: 'nth', weekday: 0, nth: -1, from: '2026-05-01', to: '2026-10-31',
              time: '12–7pm', hour: 12 },
}
```

Four schedule shapes, all expanded at load:

| `kind` | Fields | Use for |
| --- | --- | --- |
| `range` | `start`, `end` | Exhibitions, festivals spanning days |
| `day` | `date`, `time?`, `hour?` | One-offs — a parade, a solstice walk |
| `weekly` | `weekday` (0 = Sunday, or an array), `from`, `to`, `time?`, `hour?` | Markets, free nights, weekend openings |
| `nth` | `weekday`, `nth` (1–5, or `-1` for last), `from`, `to`, `time?`, `hour?` | Monthly fleas |

`hour` is only used to sort same-day cards; `time` is the string the card shows.

### Details worth keeping if you fork it

- **Dates are clipped to their column.** An event running Sep 8–13 reads
  `Sep 8 – 13` under *This month* but `Sep 9 – 13` under *This week*, because
  that column starts tomorrow.
- **Each event's illustration is drawn once.** The first card for an event in
  DOM order gets the picture; later repeats of the same event are text-only. It
  is what keeps a column of weekly markets from turning into wallpaper.
- **An empty filter group means "everything".** Deselecting every category and
  pressing Apply shows the full calendar rather than a blank board. The two
  groups are guarded separately, so clearing every price does not quietly undo
  a category chosen in the same visit.
- **Price is derived, not stored.** `priceOf()` in `price.js` reads each
  listing's `entry` line — the same line the modal shows — so there is one
  source of truth and the poller's listings get bucketed with no extra field.
  Free requires `entry` to *start* with "Free", or to be pay-what-you-can: a
  discount further along the line does not count, because "Ticketed; free for
  25 and under" is not a free event for most people. Otherwise the **first**
  dollar figure decides, since these lines put the door price first and the
  extras after — taking the smallest would file "$22, plus $5 and up to fire a
  piece" under $20. Anything with no number stays *Price not listed* rather
  than being guessed at.
- **A group only offers what the listings contain.** There is no *Under $20*
  chip today because nothing costs between a penny and twenty dollars, and no
  *Meetups* chip because nothing is one; both appear on their own when
  something lands in them. Only listings that actually reach the board count
  towards that — a finished event nobody can scroll to should not shape the
  filter. Hidden values are dropped from the filter state, not just from the
  sheet — one left sitting at `true` is a tick nobody can see or clear, and it
  defeats the empty-group guard above.
- Choices persist in `localStorage` under `wswdt.categories` and `wswdt.prices`.
- **`[hidden]` is forced to `display: none !important`.** Every dialog here is
  toggled with the hidden attribute, and a `display` rule on a class silently
  beats the browser default — a closed dialog then keeps swallowing taps. This
  bit twice before it was made global.
- Below 720px the layout changes shape rather than shrinking: columns go
  full-bleed and snap one per screen, and both dialogs become bottom sheets
  anchored to the bottom edge with a rounded top. The filter sheet pins its
  Reset/Apply footer so it stays reachable on a 320px screen, and under 560px of
  height the modal's illustration shrinks to keep the text above the fold.
- The modal spells a single-day event out — *Wednesday, September 9 · 4–9pm* —
  while its card stays terse. Time ranges gain spaces around the dash only when
  both ends name their half of the day: "8am – 1pm" but "4–9pm".
- `entry` holds what it costs to walk in. Omit it and the row disappears, which
  is what Fort York does — its admission was not confirmed.
- `#<event-id>` in the URL opens that event's modal on load.

## Polling

`scrape/` fetches a handful of sites once a day and proposes what it found.

```sh
npm ci
npm test                 # offline, over the fixtures — no network, no API key
npm run poll:offline     # replay the fixtures end to end (writes to the temp dir, never scraped.js)
npm run dry-run:eventbrite   # poll Eventbrite alone; report goes to the temp dir
npm run poll             # live; needs `npx playwright install chromium`
```

Before adding a source, find out how it is best read:

```sh
npm run discover -- --all   # every source, parked ones included
npm run discover -- wygo    # just one
```

It loads the listing page, samples a couple of the event pages it links to, and
reports whether either publishes JSON-LD, whether the site's JavaScript calls a
JSON API you could read directly, or neither — plus whether the response looks
like a refusal, which is the one case that argues for running this somewhere
other than a GitHub runner. Sampling the detail pages matters: a listing page is
often a bare list of links, and judging a site by it alone will tell you there
is nothing to read when there is. The same report is available
from the Actions tab: run the workflow manually with **discover** ticked.

Extraction is tried in the order that costs least and breaks least:

1. **JSON-LD.** Sites that publish `schema.org/Event` give exact fields that
   survive redesigns. Nothing is inferred and nothing is paid for.
2. **The model.** Only for pages with no structured data, and only when
   `ANTHROPIC_API_KEY` is set. Without a key those pages are reported as
   skipped and the run still succeeds.

Then everything meets the same gates, and anything that fails one is **dropped
and reported, never published half-known**. It needs a title, a parseable date
that has not already passed, a real venue and address — not `TBD`, not
"somewhere spooky", not `Online` — and the address has to place it **in
Toronto**. Sources
list wherever they like: the first live poll of Wygo returned two events in
Waterloo, which is why that last gate exists. Each survivor records the URL it
was read from in `source` and the date in `checked`.

**In practice, no API key has been needed.** Wygo publishes JSON-LD, so the
deterministic path handled it and the model was never called.

**The workflow opens a pull request; it does not push to `main`.** A person
still decides what lands on the calendar — the bot is good at finding things
and cannot tell whether they are worth someone's Saturday. Merging the pull
request triggers the Pages deploy.

### Adding a source

Append to `SOURCES` in `scrape/sources.mjs`:

```js
{
  id: 'wygo',
  name: 'Wygo',
  url: 'https://wygo.world/o/wygo',
  category: 'dropin',              // which colour it files under
  art: 'art-star',
  followLinks: /^https:\/\/wygo\.world\/(?!o\/)[a-z0-9-]+$/i,
  maxFollow: 12,
}
```

Keys a source can also carry, all optional (Eventbrite uses every one; see
`scrape/eventbrite.mjs`):

- `listingOnly: true` — the index page is a list of links and nothing on it is
  published. Every event it names is followed or dropped with a stated reason,
  and tracking query strings are dropped so one event is fetched once.
- `noModel: true` — never send this source's pages to the model. An event page
  with no Event JSON-LD is dropped and reported by name. For facts (a price)
  that must come from structured data or not at all.
- `vet(raw)` — the source's own gate, called by `normalize` after the date
  checks. Returns `{ reject: why }` or what to publish instead of the defaults
  (`category`, `art`, `entry`, `address`); every later gate, the $35 ceiling
  included, still applies.
- `skipBeforeFollow(listed)` — given an event as the index lists it
  (`title`, `url`), return a reason to rule it out without fetching its page,
  or `null`. It is reported as dropped with `(not fetched)`.
- `pageNodes(nodes)` — given nodes that describe one event, return
  `{ keep, dropped: [{ title, why, node }] }`. `harvest` calls it with every
  Event node on one page, and again with the published listings that share a
  title and venue across the source's pages. Eventbrite uses it to keep a
  dated occurrence and drop the series node that spans it.
- `mayGoQuiet: true` — this source producing nothing does not trip the
  silent-source guard that otherwise stops the whole poll. For a source
  expected to block the poller now and then; only its own listings are lost.

Following event pages has a circuit breaker for every source: three failed
follows in a row and the rest of that source's links are left alone (each
reported). If more than a third of a source's follows go unread, the source is
treated as failed and keeps its listings from the previous `scraped.js`
rather than publishing a partial set. The failed-follow count per source is in
the run report.

`exclude` is a per-source title filter, for a feed whose subject overlaps yours
only partly. Luma's Toronto page is mostly startup and tech networking, so it
files under its own `social` category — one click from hidden — and the most
obvious of it is skimmed off by title. Keep such a filter narrow: a book launch
is worth having even when a software company is hosting it.

`maxEvents` caps how many listings one source may contribute to a single
review — a city-wide aggregator will otherwise bury a 40-line calendar under
200 rows, and a pull request nobody reads is the same as no review at all.
Soonest events survive the cap.

Check the site's terms and `robots.txt` first — the poller honours `Disallow`
rules for `*` and waits 1.5s between pages (never less than 1s, whatever
`FOLLOW_DELAY_MS` says), but that is politeness, not permission, and the big
ticketing platforms restrict automated access in their terms regardless of what
`robots.txt` says. **One enabled source is an exception, knowingly:
Eventbrite's Terms of Service prohibit automated extraction, and the owner
enabled the `eventbrite` source anyway on 2026-09-27, accepting the risk that
Eventbrite blocks or objects to it.** That is recorded beside the source and in
`EVENTBRITE-FINDINGS.md`; it is not a sign that the terms allow it, and it is
not a precedent for the platforms still parked for the same reason. `npm run discover` reports the
`robots.txt` verdict per source before you commit to one. Set `enabled: false` to park a
source: it stops being polled but discovery still reports on it with `--all`,
which is the point of parking rather than deleting. Several candidates sit
parked in `sources.mjs` waiting for a verdict.

One dead end worth recording: the City of Toronto's Festivals & Events open
data would have been the ideal source — official, permissively licensed,
already published as schema.org Events by a
[CivicTechTO proxy](https://github.com/CivicTechTO/toronto-opendata-festivalsandevents-jsonld-proxy).
That proxy was paused in August 2026 because the upstream City feed went away.
Do not spend an afternoon rediscovering it.

## Where the listings come from

Every event carries `source` (the page its schedule was confirmed against) and
`checked` (the date). These are maintenance metadata and are deliberately not
rendered — they tell whoever re-checks the calendar where to look, without
putting bookkeeping in front of a reader deciding what to do on a Saturday.
Where a date is a reasonable inference rather than a published fact,
`unconfirmed` holds the explanation and the modal *does* show it as a caution,
because that one affects whether you turn up. The Santa Claus Parade is the only
entry currently carrying one.

**Anything that could not be confirmed was left out**, not guessed. That is why
there is no Power Plant entry (no fall 2026 dates published at time of checking),
no Junction Flea (nothing scheduled past its May market) and no TD Gallery.

### Re-checking

The listings were confirmed on **2026-09-08**. They rot in predictable ways:

| What | When it changes |
| --- | --- |
| Outdoor market seasons | Late April and late October, every year |
| Exhibition runs | Each institution publishes a new season quarterly |
| Festival dates | Announced 3–6 months ahead; most are a fixed weekday-of-month |
| Free-night programs | Rarely, but the AGO moved from weekly to monthly — re-read the fine print, not just the day |

Working through `EVENTS` and opening each `source` takes about half an hour. Bump
`CHECKED` at the top of `data.js` when you finish a pass.

**Prices re-check themselves.** `scrape/recheck.mjs` runs as part of the poll
job. The poller only ever discovers *new* events into `scraped.js` and never
looked at the hand-written listings again, which is why thirteen of them said
"Ticketed" and nothing more — the price was on the venue's page the whole time
and nobody went back for it.

```sh
npm run recheck              # only listings with no known price
npm run recheck:all          # every price, to catch one that changed
npm run recheck:dry          # report, write nothing
npm run recheck -- --show fort-york   # what does that page actually say?
```

**Every price it writes comes with the sentence it read.** A figure on its own
is unfalsifiable in a diff — `Free` for a museum looks the same whether it was
read off the page or inferred from the absence of a price — so the model is
asked to quote the sentence word for word, and told that if it cannot quote it,
it did not read it. The quote goes in the run log next to the price.

`--show <id>` settles one listing without writing anything: it fetches the
page and prints the HTTP status, any JSON-LD offers, every line mentioning a
price, admission or tickets, and then the model's reading and its quote.
Pushing to a `show/<id>` branch runs it in Actions, which is the way to check
a page from a machine that cannot reach it:

```sh
git push origin main:show/fort-york
```

The job runs on the poll's schedule, daily. It does not scale with that
frequency the way the poller does: it only looks at listings with no known
price, and remembers the pages that have already said they state none.

Two things about the schedule that cost time to work out, both still worth
knowing. It was `*/2` for a while, meaning to run every second day — but `*/2`
in a day-of-month field does not mean "every 48 hours", it means the odd days,
1, 3, 5 … 31, so it skipped every even date and ran twice running across a
31-day month. And GitHub queues scheduled workflows and runs them late: 11:17
UTC was nominal and the first scheduled run fired at 15:07.

It reads each listing's own `source`, takes the price from JSON-LD offers when
the page has them and asks the model when it does not, then patches `data.js`
surgically — the one object, the one line — rather than regenerating a file
that is hand-ordered and full of comments. The default mode touches only
listings with no known price, so the cost shrinks as they get filled in.

Every rule in it fails towards leaving the listing alone, because a wrong price
is worse than a missing one: someone turns up with the wrong money. So it
rejects anything vaguer than a plain figure — "varies", "see website", a
sentence that merely contains a number; it matches the event by title before
trusting an offer, since venue pages carry several; it asks the model about one
named event and takes null for an answer; and `patchEntry` returns null rather
than guessing if `data.js` is not shaped the way it expects. The output is a
pull request, never a push: a person still decides what the calendar claims
something costs.

It deliberately does **not** bump `checked`. Reading a price is not
re-confirming a date, and a `checked` that overstates what was verified is
worse than a stale one.

**What it costs.** Each call sends at most 12,000 characters of page text
(`readableText`'s cap) — roughly 3k input tokens — and gets back a two-field
answer, at `effort: 'low'`. On Opus 5 that is around 2-3 cents a listing.
Thirteen listings is the first run; after that the default mode only touches
what is still unpriced, so the bill shrinks as the calendar fills in.

`scrape/price-attempts.json` is what stops it shrinking to a floor and
staying there. Some pages simply never print a price — a swing night, a fee
behind a ticketing widget — and without a memory of having asked, those
listings stay unknown forever and are re-fetched on every run: a standing
bill, and a standing request to someone's server, for a question already
answered no. An answer of "this page states no price" is recorded and re-asked after 30
days. A server refusing outright — 401, 403, 404, 410; `ago.ca` returns 403 to
this bot — is also an answer, and rests too, rather than becoming a standing
request to somewhere that has said no. Being unable to ask is not an answer
and is retried next run: no API key, a timeout, a 5xx, or a 429 asking us to
slow down. So setting the key does not look like it changed nothing for a
month.

The log is committed by the workflow along with `data.js`. It has to be — left
uncommitted it is written on the runner and thrown away with it, every listing
is asked again next run, and the backoff silently does nothing.

**It needs `ANTHROPIC_API_KEY` to be of any use.** Twelve of the thirteen
listings it targets sit on pages that publish no `schema.org` offer — museum
and festival sites state the price in prose, in a table, or behind a ticketing
link. Without the key the job still runs, still respects robots, and reports
every listing as skipped, and `data.js` never changes. Set the secret under
**Settings → Secrets and variables → Actions** and it starts filling them in.
The same key is what lets the poller read the three sources it currently
skips for the same reason.

## Illustrations

Each event draws an object. By default that is one of the 30 inline SVG symbols
in `index.html`, referenced by the event's `art` field. If an event also has an
`image` field, that file is used instead, and a failed load falls back to the
symbol — so a partial set of generated images is fine.

To generate them:

```sh
OPENAI_API_KEY=sk-... node scripts/generate-art.mjs
# or
REPLICATE_API_TOKEN=... node scripts/generate-art.mjs --provider replicate
```

The script reads `art/prompts.json` — a shared style string plus a one-line
subject per event — writes `art/<event-id>.png`, and adds the matching `image:`
field to `data.js`. It skips files that already exist unless you pass `--force`,
and `--dry-run` prints the prompts without calling anything.

```sh
node scripts/generate-art.mjs --dry-run --only tiff     # see one prompt
node scripts/generate-art.mjs --only tiff --force       # redraw one event
```

Art-direct by editing the subject lines in `art/prompts.json`; the style string
is what keeps 37 separately-generated images looking like one set, so change it
for all of them or none.

**The provider calls are untested** — the sandbox this was built in has no
outbound network access, so `--dry-run` and the `data.js` wiring are verified but
the two API paths are not. Expect to adjust the request bodies for whatever model
you land on.
