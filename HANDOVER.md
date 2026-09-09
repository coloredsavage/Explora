# Handover

Written 2026-09-09. For whoever picks this up next — human or agent.

`README.md` explains how the thing works. This file explains **where we are**,
**what we decided and why**, and **what will bite you**. Read the "Environment"
section before you try to verify anything; it is the constraint that shapes
most of the workflow here.

---

## What this is

A recreation of [`senyil.com/what-should-we-do-today/`](https://senyil.com/what-should-we-do-today/)
for **Toronto**: a calendar of free and cheap things to do, laid out as
time-window columns — Today, This week, This month, and so on — that you scroll
sideways through. Static site, no build step, no framework. Deployed to GitHub
Pages from `main` on every push.

Repo: `coloredsavage/Explora`. The site lives at the repo root.

**The rule the whole project is held to:** nothing is published that could not
be confirmed against a primary source. Every listing carries `source` (the page
it came from) and `checked` (when). Anything unconfirmable was left out and
reported by name rather than guessed at. If you add a listing, you owe it a
source you actually read. This rule is why the price work below is shaped the
way it is.

---

## Environment — read this first

**You almost certainly cannot reach the web from your session.** General hosts
are blocked at the egress gateway with a 403 on CONNECT. `api.github.com`, npm
and PyPI are allowlisted; `WebSearch` works; `WebFetch` does not. Playwright
launched locally hits the same wall.

This is not a bug to route around, and you should not try — no disabling TLS
verification, no unsetting `HTTPS_PROXY`. It shaped the project: the original
senyil.com site was never loadable from here, and the design was reconstructed
from screenshots the user supplied.

**The way to touch the live web is the GitHub Actions runner**, which has
normal network access. That is what the trigger branches below are for.

Other environment facts that cost time to rediscover:

- **No `gh` CLI.** Use the `mcp__github__*` tools.
- **`workflow_dispatch` returns 403.** The Claude GitHub App holds
  `contents:write` but not `actions:write`. Pushing to a trigger branch is the
  way to start a workflow run.
- **Branch deletion silently no-ops** through the push proxy — it reports
  "Everything up-to-date" and the ref stays. Two disposable `show/*` branches
  are stuck on the remote for this reason. Harmless; nothing pushes to them.
- **Playwright's installed version disagrees with the bundled browser.** The
  package wants `chromium-1243`; `/opt/pw-browsers` has `1194`. Launch with
  `chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })` for local
  checks. Do **not** run `playwright install`. (Only affects local scripts —
  CI installs its own.)

### Triggering a workflow run

```sh
git push origin main:run-poll          # real poll + price lookup, opens a PR
git push origin main:run-discover      # report how each source is best read
git push origin main:run-recheck       # re-read every price, not just missing
git push origin main:show/<listing-id> # print what one page says about price
```

`--force` is fine on all of these; they are disposable bot branches.

---

## Where we are

### The site

Working and deployed. 43 hand-written listings in `data.js` plus whatever the
poller last committed to `scraped.js` (2 at time of writing).

Recent work, newest first:

- **Price filter.** Two filter groups, Category and Price, guarded and stored
  separately. Buckets: Free / Under $20 / $20 and up / Price not listed.
- **Typography.** Inter, self-hosted, one weight (medium/500) at 15px/22px,
  latin + latin-ext subsets with `unicode-range`.
- **Automated price lookup.** `scrape/recheck.mjs`, wired into the poll job.

### The pipeline

`scrape/run.mjs` polls the sources in `scrape/sources.mjs` and writes
`scraped.js`. `scrape/recheck.mjs` goes back to the hand-written listings and
fills in prices they are missing. Both run in `.github/workflows/scrape.yml`
every second day and propose changes as a pull request — never a direct push.

`ANTHROPIC_API_KEY` **is set** as a repo secret (the user added it 2026-09-09).
Without it the model fallback is skipped and pages with no JSON-LD are reported
as skipped; with it, both jobs can read prose.

Sources enabled: `wygo`, `luma`, `tpl`. Parked with recorded verdicts in
`scrape/sources.mjs`: `eventbrite` (405), `harbourfront` (no Event JSON-LD), `bentway`
(404 — **the URL is wrong**, not the site's fault), `evergreen` (200 but zero
links matched `followLinks`), `akimbo` (no Event data), `blogto` (403).

### Open pull requests

- **PR #2** (`poll/2026-09-09`) — **ready to merge.** Contains a fresh poll plus
  two prices, both independently verified against the pages' own words:
  `fort-york: 'Free'` ("General admission is free.") and
  `tsa-life-drawing: '$20'` ("Cash, debit or credit card: $20"). Merging takes
  "Price not listed" from 13 listings to 11 and deploys to Pages.
- **PR #1** (`poll/2026-09-08`) — **stale, close it.** Built from an older
  `main`; PR #2 supersedes it entirely.

---

## Decisions already made — please don't silently re-litigate

Each of these was argued through with the user. Reopen them if you have new
information, but say so rather than quietly changing them.

**Price is derived from `entry`, not stored beside it.** `priceOf()` in
`price.js` reads the same line the modal shows, so there is one source of truth
and scraped listings get bucketed with no new field. `price.js` is loaded by the
page with a `<script>` tag and by `scrape/recheck.mjs` through a `vm` context —
deliberately, so the filter and the job cannot drift about what "Free" means.

**Two rules inside `priceOf` are load-bearing.** Free requires `entry` to
*start* with "Free" (or be pay-what-you-can): a discount later in the line does
not count, so "Ticketed; free for 25 and under" is not a free event. And the
*first* dollar figure wins, not the smallest, because these lines put the door
price first — "$22, plus $5 and up to fire a piece" is a $22 class.

**A price range slider was considered and rejected.** The whole calendar has
three priced listings spanning $20–$25, and 11 with no number at all, which a
number line has nowhere to put. The user asked; the data doesn't support it.
Revisit only if the unpriced listings get filled in and real dispersion appears.

**Counts on the filter chips were built and then removed** — the user didn't
like them. The useful part was kept: a chip is only offered for a value some
listing on the board actually has.

**Opus 5, not Haiku, for extraction.** Switching the price extractor would save
about $1.50/year once the backoff landed, and the failure it invites — a
confidently wrong number the `acceptable()` gate cannot catch — is the one that
matters. The cost lever taken instead was halving the poll frequency.

**The recheck never bumps `checked`.** Reading a price is not re-confirming a
date, and a `checked` that overstates what was verified is worse than a stale
one.

**The recheck proposes, never pushes.** A wrong price is worse than a missing
one — someone turns up with the wrong money.

---

## Things that are still wrong or unfinished

**11 listings have no price** once PR #2 is merged; 13 on `main` today. Six
say "Ticketed" (including `sunday-best`,
whose page 403s us before we can read it), three say "Included with general
admission", one is MOCA's "Ticketed; free for 25 and under", and
`saturday-night-swing` carries no entry line at all. Ten of those pages were
read and genuinely state no price; they are recorded in
`scrape/price-attempts.json` and will be re-asked around **2026-10-09**. Filling
these in properly probably needs a human reading ticketing pages, or new
sources. This is the thing that would most improve the price filter.

**`ago.ca` returns 403 to this bot.** `sunday-best` is resting for 30 days as a
result. If AGO listings matter, the fix is a different source URL, not a
different user agent.

**Two source URLs are simply wrong.** `bentway` 404s and `evergreen` matches
zero links. Both are parked with the verdict recorded. Finding the real listing
pages would add two decent sources. `git push origin main:run-discover` reports
on every source including parked ones — that is what it is for.

**~21 MB of SF Pro OTFs are still in git history** at commit `391350c`. The user
uploaded them; I removed them from the tree (Apple's licence covers mocking up
Apple-platform UI, not redistributing files or embedding them in a web page,
and a public repo served by Pages does both). `git rm` does not unpublish them —
GitHub still serves those blobs. Actually removing them needs a history rewrite
and a force-push over `391350c`, which breaks existing clones. The user has been
told and has not asked for it.

**`CHECKED` is `2026-09-08`.** Listings rot in predictable ways — see the
Re-checking section of the README. Outdoor market seasons turn in late October.

**Two chips are hidden because nothing matches them:** "Under $20" (nothing
costs between a penny and twenty dollars) and "Meetups" (no listing is one).
They reappear on their own when something lands in them. This is intended.

---

## If you change the site, verify it like this

There is a working pattern, and it caught several bugs that reading the code did
not. Serve the folder and drive it:

```sh
python3 -m http.server 8777 --bind 127.0.0.1
# then a Playwright script with executablePath: '/opt/pw-browsers/chromium'
```

Check at 320, 390, 844×390, 768 and 1440. Assert on what the page *did*, not on
what the CSS says — for fonts, ask Chromium which one it actually painted via
CDP `CSS.getPlatformFontsForNode`; for the filter, tick chips and count the
surviving cards rather than reading the state object.

`node scrape/test.mjs` is offline, needs no key or network, and covers the
extractors, the price rule, the `data.js` patcher and the backoff. Run it.

Two bugs worth knowing about because the class recurs here:

- `SVGElement.hidden` is not a property. Assigning it creates an expando, so a
  test that reads it back gets `undefined` and **reports a false pass** while
  the page renders broken. Use `removeAttribute('hidden')`.
- A `display` rule on a class beats the browser's `[hidden]`, leaving closed
  dialogs invisible but still swallowing taps. `styles.css` forces
  `[hidden] { display: none !important }` globally. This bit twice.

---

## Quick orientation

| File | What it is |
| --- | --- |
| `index.html` | Page structure, ~34 inline SVG symbols, About sidebar, dock, sheets |
| `styles.css` | Tokens, board, cards, sheets, the mobile breakpoint at 720px |
| `app.js` | Expands schedules into occurrences, renders, drives filter and modal |
| `price.js` | The price rule, shared by the page and the recheck job |
| `data.js` | The 43 hand-verified listings, plus `CATEGORIES` and `PRICES` |
| `scraped.js` | Generated by the poller; merged at load; never edit by hand |
| `scrape/` | The pipeline — see the README's Polling section |
| `scrape/price-attempts.json` | The recheck's memory of pages that said no |

Schedules expand as `range` / `day` / `weekly` / `nth`, and a listing may carry
an array of them. Dates are clipped to their column's window, and an event's
illustration is drawn only on its first card in DOM order — both are deliberate
copies of the original's behaviour and are easy to break without noticing.
