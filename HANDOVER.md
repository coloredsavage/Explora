# Handover

Written 2026-09-09, revised 2026-09-08 after the price and source work below.
For whoever picks this up next — human or agent.

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

**Check what your session can actually reach before trusting this section.**
It has already been wrong once. The environment this project was built in
could not reach the web at all; the session that picked it up on 2026-09-08
had full access, a `gh` CLI and a token that could dispatch workflows. Both
notes are kept below, because you could land in either.

### If you are on a normal machine (the 2026-09-08 session was)

- **The web works.** `curl` and `WebFetch` both reach ordinary sites. A 403
  from `ago.ca` or `blogto.com` is *that site refusing bots*, not your egress
  gateway — do not read it as "no network".
- **`gh` is available** and authenticated as the repo owner.
- **`workflow_dispatch` works**: `gh workflow run "Poll event sources"
  -f discover=true`. The trigger branches below are no longer necessary,
  though they still function.
- Some sites need a browser User-Agent (`curl -A "Mozilla/5.0 ..."`), and a
  few (tiff.net) sit behind a WAF that only a real headless browser gets past.

### If you are in the locked-down sandbox the project was built in

General hosts are blocked at the egress gateway with a 403 on CONNECT;
`api.github.com`, npm and PyPI are allowlisted; `WebSearch` works, `WebFetch`
does not. This is not a bug to route around, and you should not try — no
disabling TLS verification, no unsetting `HTTPS_PROXY`. It shaped the project:
senyil.com was never loadable, and the design was reconstructed from
screenshots the user supplied. There, **the way to touch the live web is the
GitHub Actions runner**, via the trigger branches below.

Other facts that cost time to rediscover:

- **The Claude GitHub App token cannot dispatch workflows.** It holds
  `contents:write` but not `actions:write`, so `workflow_dispatch` returns 403
  *for that token*. A normal user token dispatches fine.
- **Branch deletion silently no-ops** through the push proxy — it reports
  "Everything up-to-date" and the ref stays. Several disposable `run-*` and
  `show/*` branches are stuck on the remote for this reason. Harmless; nothing
  pushes to them. Deleting them needs a session whose permissions allow a
  `DELETE` on `git/refs` — the 2026-09-08 session had that blocked too.
- **Playwright's installed version disagrees with the bundled browser.** The
  package wants `chromium-1243`; `/opt/pw-browsers` has `1194`. Launch with
  `chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })` for local
  checks. Do **not** run `playwright install`. (Only affects local scripts —
  CI installs its own.)

### Triggering a workflow run

With a token that has `actions:write`, just dispatch it:

```sh
gh workflow run "Poll event sources"                      # a real poll
gh workflow run "Poll event sources" -f discover=true     # report on sources
gh workflow run "Poll event sources" -f all_prices=true   # re-read every price
```

Otherwise push to a trigger branch, which anything that can push may do:

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

Sources enabled: `wygo`, `luma`, `tpl`, and — since 2026-09-08 — `bentway` and
`evergreen`. Both had simply been pointed at the wrong URL:

- `bentway` was on `/events/` (404). The real index is `/whats-on/`, 24 event
  links, server-rendered. The old `followLinks` was already correct.
- `evergreen` was on `/whats-on/` (301s to the real page) *and* had a pattern
  that could never match: event pages live under `/evergreen-brick-work/` —
  singular "work" — split across `/events/` and `/activities/`.

Neither carries Event JSON-LD, so **both read through the model**, which is new
spend on every poll. `evergreen` returns a Yoast `ld+json` block with no Event
node — do not mistake it for a fast path. If the API bill matters more than the
coverage, these two are the first things to park again.

Still parked with recorded verdicts in `scrape/sources.mjs`: `eventbrite` (405),
`harbourfront` (no Event JSON-LD), `akimbo` (no Event data), `blogto` (403).

### Open pull requests

None outstanding as of 2026-09-08. PR #2 was merged (the `fort-york` and
`tsa-life-drawing` prices, both re-verified against the pages first) and PR #1
was closed as superseded.

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

**ROM's two listings stay unpriced, on purpose.** The ROM prices general
admission dynamically, by date: its own calendar endpoint returned $31.50 for
2026-09-08, $29 for 09-09, $28 for 09-10, settling to $26 from 09-17. There is
no fixed adult price published anywhere on `rom.on.ca`, so any single figure we
printed would be the *floor* of a range, and a reader who walked up on the day
would be short by up to 21%. That is exactly the failure the whole price rule
exists to prevent, so `rom-survival` and `abya-yala` keep prose lines that state
what is true — included with admission, varies by date — and bucket as unknown.
Two traps if you revisit this: the `$35`/`$26` figures on `rom.on.ca/visit/visit-group`
are **pre-booked group rates**, not door prices, and the static products table
on `tickets.rom.on.ca` reports `$35.00` for every date including ones that
actually charge $38 — the live figure comes from `/en/shop/ajax/pricing`.

**A surcharge must never be the first dollar figure in an `entry` line.**
`rom-survival` genuinely carries a confirmed "$9 Surcharge" on top of general
admission, and writing that as "Included with admission, plus a $9 surcharge"
would have made `$9` the first figure and filed a ~$35 visit under **$20**.
This is the sharp edge of the "first dollar figure wins" rule: it is correct
when the door price leads, and actively dangerous when a modifier does. If a
line's leading number is not what someone hands over at the door, leave the
number out.

**MOCA's old "Ticketed; free for 25 and under" was unsourced.** The press
release it came from contains no dollar figure and no admission wording at all.
`moca.ca/visit/` states "Adult admission $14" and "18 and Under FREE", so the
line is now "$14; free for 18 and under". The under-25 claim appears nowhere on
MOCA's site. Note this makes the example in `price.js`'s comment historical —
no listing carries that line any more, though it still illustrates the rule.

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

**2 listings have no price**, down from 11. Both are ROM, and both are
deliberate — see the ROM decision above. Everything else on the board now
buckets.

**`ago.ca` returns 403 to bots**, so the AGO price came from `visit.ago.ca`,
the AGO's own Tessitura ticketing host, which serves fine. Same organisation,
so it satisfies the primary-source rule. Note the listings' `source` fields
still point at the AGO press releases the events came from — the price URLs are
recorded in the commit message, not in `data.js`, because there is no
price-source field. **If you want price provenance to survive in the data, that
field is the thing to add.** Same gap for `art-toronto`, whose price is on its
white-label ticketing host `tix123.com`.

**`scrape/price-attempts.json` is `{}`** — the backoff memory the previous
session described was never committed. Nothing is resting, so a
`-f all_prices=true` run will re-ask every page.

**~21 MB of SF Pro OTFs are still in git history** at commit `391350c`. The user
uploaded them; I removed them from the tree (Apple's licence covers mocking up
Apple-platform UI, not redistributing files or embedding them in a web page,
and a public repo served by Pages does both). `git rm` does not unpublish them —
GitHub still serves those blobs. Actually removing them needs a history rewrite
and a force-push over `391350c`, which breaks existing clones. The user has been
told and has not asked for it.

**`CHECKED` is `2026-09-08`.** The price work of that day deliberately did not
bump it — reading a price is not re-confirming a date. Listings rot in
predictable ways; see the Re-checking section of the README. Outdoor market
seasons turn in late October.

**One chip is hidden because nothing matches it:** "Meetups" (no listing is
one). It reappears on its own when something lands in it. This is intended.
"Under $20" was hidden for the same reason until 2026-09-08 and is now live,
carrying MOCA at $14 and the Toronto Vintage Show at $17.

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
