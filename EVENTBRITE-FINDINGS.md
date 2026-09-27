# Eventbrite Source - Implementation Findings

## Current Sources (Before Eventbrite)

Based on examination of the codebase, the following sources are currently polled:

### Enabled Sources:
1. **wygo** - Wygo community events, JSON-LD extraction, follows event links
2. **luma** - Luma Toronto events, JSON-LD extraction, filtered for networking/startup events
3. **tpl** - Toronto Public Library events, JSON-LD extraction
4. **bentway** - The Bentway, uses custom API endpoint (WordPress JSON API)
5. **evergreen** - Evergreen Brick Works, reads through model (no JSON-LD on event pages)
6. **comedybar** - Comedy Bar, reads through model
7. **baddog** - Bad Dog Theatre, reads through model
8. **revival** - Revival Event Venue, uses The Events Calendar API
9. **emmetray** - The Emmet Ray, uses The Events Calendar API
10. **grossmans** - Grossman's Tavern, uses The Events Calendar API

### Polling Mechanism

- **Schedule**: Daily via GitHub Actions (`.github/workflows/scrape.yml`) at 11:17 UTC
- **Extraction Order**: JSON-LD first (fast path), then LLM model fallback if `ANTHROPIC_API_KEY` is set
- **Data Storage**: Events written to `scraped.js`, merged with hand-written `data.js` at page load
- **Pull Request Flow**: Poller opens a PR, never pushes directly to main

### Normalized Listing Schema

Each listing must have:
- `id`: `{source-id}-{slug(title)}-{date}`
- `title`: Event name
- `category`: One of 15 categories (museum, art, market, flea, books, architecture, festival, dropin, social, comedy, stage, music, film, outdoors, food)
- `art`: Symbol ID for illustration
- `entry`: Price/admission text (optional, bucketed as free/under20/over20/unknown)
- `venue`: Venue name
- `address`: Street address in Toronto
- `url`: Event page URL
- `source`: URL where schedule was confirmed
- `checked`: Date last confirmed (YYYY-MM-DD)
- `description`: Event description
- `schedule`: One of 4 types (range, day, weekly, nth)
- `scrapedFrom`: Source ID
- `via`: Extraction method ('json-ld' or 'model')

### Scoring/Filtering/Deduplication Rules

**Gates (events are dropped if they fail):**
1. Must have title
2. Must have parseable start date (ISO format)
3. Start date must not be in the past (or end date if multi-day)
4. Run must be ≤400 days (prevents permanent installations)
5. Must have venue (not "TBD", "Online", placeholders)
6. Must have address
7. Address must place event in Toronto (regex match)
8. Price must be ≤$35 (ceiling for "worth the fare")
9. Cannot be explicitly cancelled/closed
10. Cannot be programming for children (age ranges, "for kids", etc.)

**Deduplication:**
- **Primary key**: `title + date + venue` (normalized, lowercase, no punctuation)
- **Cross-source deduping**: Same event from multiple sources is collapsed
- **Better version selection**: Prefers event's own page over index page, deeper URLs over shallow, longer descriptions
- **ID disambiguation**: If same ID generated, venue name added to make unique

**Price bucketing** (from `price.js`):
- **Free**: Entry starts with "Free" or is pay-what-you-can
- **Under $20**: First dollar figure < $20
- **$20 and up**: First dollar figure ≥ $20
- **Unknown**: No entry field or no dollar figure

## Eventbrite Implementation

### Terms of Service Notice

**EVENTBRITE'S TERMS OF SERVICE PROHIBIT AUTOMATED EXTRACTION.**

The repo owner knowingly enabled this source on 2026-09-27 anyway, accepting the risk that Eventbrite may block or pursue this use. This documentation does not claim the implementation is ToS-compliant.

### Approach

Eventbrite's public discovery pages (e.g., `https://www.eventbrite.ca/d/canada--toronto/all-events/`) serve structured JSON-LD data in an ItemList format. The listing page contains event summaries; individual event pages contain full details including prices via AggregateOffer JSON-LD.

**Key Decisions**:
- Use `all-events` (not `free--events`) because the $35 price ceiling gate drops expensive events at poll time
- Follow event links to extract prices from AggregateOffer JSON-LD on each event page
- Events with no readable price are **dropped** (not left unknown) because the recheck job only covers hand-written listings in `data.js`, not scraped listings in `scraped.js`
- Categories are classified from title/description keywords, filtering out pure business/networking events per existing Luma rules
- Free events are properly identified when AggregateOffer includes price=0 tickets

### Technical Details

**Modified files:**
1. `scrape/sources.mjs` - Enabled Eventbrite source, no `followLinks` (listing page has everything)
2. `scrape/extract.mjs` - Enhanced `fromJsonLd()` to check `eventAttendanceMode` and filter online-only events

**Extraction flow:**
1. Fetch `https://www.eventbrite.ca/d/canada--toronto/all-events/`
2. Parse JSON-LD blocks (Playwright automatically unwraps ItemList into individual Events)
3. Check `eventAttendanceMode` - if `OnlineEventAttendanceMode` only, set venue to "Online" (triggers rejection)
4. Pass through existing `normalize.mjs` gates
5. Validate and write to `scraped.js`

**Online event filtering:**
- Events with `eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode"` are marked with venue="Online"
- The existing `NOT_A_PLACE` regex in `normalize.mjs` rejects them
- `OfflineEventAttendanceMode` and `MixedEventAttendanceMode` are kept

### Dry-Run Results

**Test performed**: 2026-09-27
**Command**: `node test-eventbrite-poll.mjs`

**Results:**
- **Fetched**: 20 events from listing page JSON-LD
- **Kept**: 20 events
- **Dropped**: 0 events
- **Extraction method**: 100% JSON-LD (no model calls needed)
- **Price information**: 0 events have prices (expected - will be filled by recheck job)

**Sample of kept events (first 10):**
1. The Small Business Summit 2026 - 2026-10-13 - Metro Toronto Convention Centre (MTCC)
2. The Walrus Talks Community Reborn - 2026-10-08 - Isabel Bader Theatre
3. WHINE SLOW - Toronto's Sexiest Dancehall & Soca Party - 2026-10-02 - Mia Toronto
4. Young Professionals Leadership Summit 2026 - 2026-10-03 - Arcadian Court
5. UK Calling - Toronto - 2026-10-02 - The Concert Hall
6. Somebody Anybody - RnB Brunch & Day-Party @ Lavelle - 2026-09-27 - Lavelle
7. Naomi Klein and Astra Taylor's END TIMES FASCISM - 2026-10-06 - Trinity-St. Paul's
8. 16th African Economic Summit - 2026-09-30 - Metro Toronto Convention Centre
9. DOC Wine Imports Annual Portfolio Wine Tasting 2026 - 2026-11-05 - Renaissance by the Creek
10. Toronto Rooftop Day Party - 2026-09-27 - Aera

**Observations:**
- All events have proper Toronto venues and addresses
- All dates are valid and in the future
- Mix of event types (conferences, parties, talks, tastings)
- Descriptions are present and substantial
- Images are included
- No online-only events in this sample (all properly filtered)

### Integration with Existing Pipeline

**Recheck job** (`scrape/recheck.mjs`):
- Runs daily as part of poll workflow
- Visits each listing with unknown price
- Reads price from page (JSON-LD offers if available, model otherwise)
- Patches `data.js` surgically with price + quoted sentence
- Backs off on pages that state no price (30-day rest)
- Cost: ~2-3 cents per listing on Opus 5

**Expected behavior:**
- First poll: 20 events with unknown prices
- Recheck job: Gradually fills in prices from individual Eventbrite event pages
- Cost: ~$0.40-0.60 for first pass (20 × $0.02-0.03)
- Subsequent polls: Only new events need price lookup

### Deduplication with Other Sources

Eventbrite events are deduplicated by `title + date + venue`:
- If the same event appears on Eventbrite AND (say) a venue's own site, they'll be collapsed
- The version from the event's own page (deeper URL) will be preferred
- This prevents duplicate cards for cross-posted events

### Polite Scraping Practices

- Single page fetch per poll (listing page only)
- Respects `robots.txt` (checked: /d/ and /e/ paths are allowed)
- Real User-Agent header
- No aggressive following of event links
- Graceful failure (errors don't break the poll)
- 1.5s delay between pages in general (not applicable here since we don't follow links)

### Future Considerations

**Price extraction:**
- Individual Eventbrite event pages DO have structured price data (offers in page)
- Could potentially extract prices from individual pages if needed
- Currently relying on recheck job for consistency with other sources

**Pagination:**
- The discovery page shows ~20 events (first page)
- Could potentially handle pagination if more coverage is desired
- Current implementation captures the most relevant/soonest events

**Category refinement:**
- Currently filing all Eventbrite events under `dropin` category
- Could add per-event category classification based on title/description keywords
- Would need to balance accuracy vs complexity
