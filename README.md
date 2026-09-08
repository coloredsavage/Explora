# What should we do today? — Toronto

A calendar of free museum nights, farmers' markets, fleas, exhibitions and street
festivals in Toronto, laid out as a horizontally-scrolling board that runs from
today outward: **Today → This week → This month → This year**.

A Toronto recreation of [What should we do
today?](https://senyil.com/what-should-we-do-today/) by Muharrem Şenyıl.

## Running it

No build step and no dependencies — open `index.html`, or serve the folder:

```sh
npx http-server what-should-we-do-today
```

## How it is put together

| File | What it holds |
| --- | --- |
| `index.html` | Page structure, the About column, and the inline SVG sprite of event illustrations |
| `styles.css` | Design tokens, the column board, cards, filter sheet, event modal |
| `data.js` | `CATEGORIES` and `EVENTS` — the only file you edit to change listings |
| `app.js` | Expands schedules into occurrences, renders the columns, drives the filter and modal |

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
  url: 'https://www.pskensington.ca/',
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
| `weekly` | `weekday` (0 = Sunday), `from`, `to`, `time?`, `hour?` | Markets, free nights |
| `nth` | `weekday`, `nth` (1–5, or `-1` for last), `from`, `to`, `time?`, `hour?` | Monthly fleas |

`hour` is only used to sort same-day cards; `time` is the string the card shows.

### Details worth keeping if you fork it

- **Dates are clipped to their column.** An event running Sep 8–13 reads
  `Sep 8 – 13` under *This month* but `Sep 9 – 13` under *This week*, because
  that column starts tomorrow.
- **Each event's illustration is drawn once.** The first card for an event in
  DOM order gets the picture; later repeats of the same event are text-only. It
  is what keeps a column of weekly markets from turning into wallpaper.
- **An empty filter means "everything".** Deselecting every category and
  pressing Apply shows the full calendar rather than a blank board.
- Choices persist in `localStorage` under `wswdt.categories`.
- `#<event-id>` in the URL opens that event's modal on load.

## About the listings

The events are real Toronto fixtures, but **the dates in `data.js` are seed data
for the 2026 season and have not been verified against each venue**. Free-night
hours in particular drift year to year. Check before you go, or wire `EVENTS` up
to a real source.
