/* The price rule, shared by the page and by scrape/recheck.mjs.

   It lives in its own file because two programs depend on it agreeing with
   itself: the browser buckets listings for the filter, and the recheck job
   decides which listings still need a price looked up. A copy in each would
   drift, and the drift would be silent — the job would stop asking about
   listings the filter still calls unknown.

   A plain script assigning to the global, not a module: index.html loads it
   with a <script> tag, and scrape/recheck.mjs evaluates it in a vm context,
   the same way it reads data.js. No build step either way. */

var PRICE_BUCKETS = ['free', 'under20', 'over20', 'unknown'];

/* Which bucket a listing falls in, read off its `entry` line.

   Free means the base admission is nothing, so `entry` has to *start* with
   "Free" — or be pay-what-you-can, where nothing is a price you may choose.
   A discount buried later in the line does not count: "Ticketed; free for
   25 and under" is not a free event for most people, and bucketing it as one
   would be a small lie told to anyone over 25. Conditions attached to a
   genuinely free door ("book the timed ticket ahead", "tickets in person
   only") are not prices, and the card still shows the whole line either way.

   Otherwise the *first* dollar figure wins, because that is the way these
   lines are written: the door price comes first and the extras follow it.
   Taking the smallest instead would file "$22, plus $5 and up to fire a
   piece" under $20, which is wrong by twenty-two dollars.

   No `entry`, or one with no number in it — "Ticketed", "Included with
   general admission" — is unknown, not free and not guessed at. */
function priceOf(event) {
  var t = String((event && event.entry) || '').trim().toLowerCase();
  if (!t) return 'unknown';
  if (t.indexOf('free') === 0) return 'free';
  if (/pay[- ]what[- ]you[- ](can|want|wish|choose)|\bpwyc\b/.test(t)) return 'free';
  var first = t.match(/\$\s*(\d+(?:\.\d+)?)/);
  if (!first) return 'unknown';
  return parseFloat(first[1]) < 20 ? 'under20' : 'over20';
}
