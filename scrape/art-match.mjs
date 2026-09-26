/* Which illustration a polled listing should carry.
 *
 * Until now normalize did `art: source.art` — one symbol per source, stamped
 * on everything it returned. So every event the Bentway publishes was a roller
 * skate, including an artist talk and a democracy exhibition, and everything
 * Evergreen published was a ravine, including its farmers' market.
 *
 * The library was never the problem. Fifty-two hand-written listings draw on
 * thirty-two different symbols, because a person picked one each time and
 * picked well — art-shoe for the shoe museum, art-corn for the vegetable
 * market. Thirty-two polled listings drew on five, because nobody picked at
 * all. art-gallery and art-books were sitting unused while the wrong symbol
 * went out.
 *
 * This only ever runs in the poller. Hand-written entries do not pass through
 * normalize, so nothing here can flatten a choice someone made on purpose —
 * which matters, because a first pass at global keyword rules turned art-shoe
 * on the Bata Shoe Museum into a generic building.
 *
 * Order is most specific first and the first match wins. A rule that cannot
 * be shown to fire on something real does not belong here: every one below is
 * answering a title the poller has actually returned.
 */

export const RULES = [
  /* Skating, before the generic outdoor rules — "Roller Skate Lessons" and
     "Monthly Roller Skating Night" both arrive from sources whose default is
     something else entirely. */
  [/roller.?skat|\bskat(e|es|ing)\b|skate trail|ice rink/i, 'art-skates'],

  /* Markets, before "artisan" or "vintage" can be read as craft or clothing.
     Evergreen's "Ontario Artisan Market and Ontario Vintage Market" and its
     "Saturday Farmers Market" were both arriving as ravines. */
  [/farmers'?\s*market|artisan market|vintage market|night market|\bmarket\b/i, 'art-market'],
  [/\bflea\b|swap meet|car boot/i, 'art-flea'],

  [/\bphoto|camera|portrait|darkroom/i, 'art-camera'],
  [/film|screening|cinema|movie|documentary|matinee/i, 'art-filmreel'],

  /* Books before talks: an author event is a book event first, and "Randy
     Boyagoda: Lords of Serendipity" carries neither word. */
  [/book club|\bauthor\b|reading|novel|memoir|poet|literar|library/i, 'art-books'],
  [/artist talk|\btalk\b|lecture|panel|in conversation|keynote|q&a/i, 'art-mic'],

  [/exhibit|installation|gallery|mural|sculpture|vernissage|public art/i, 'art-sculpture'],
  [/improv|stand.?up|comedy|open mic|sketch|showcase|audition/i, 'art-neon'],
  [/jazz|\bband\b|concert|choir|opera|\bdj\b|vinyl|record|karaoke/i, 'art-records'],

  /* No bare `make`: it caught "make promises to themselves" in the Bentway's
     Public Trust and turned a democracy project into a pot. */
  [/clay|pottery|ceramic|craft|knit|sew|weav|workshop/i, 'art-vase'],
  [/\bbike|cycl|velo/i, 'art-bicycle'],
  [/architect|design.?walk|building|heritage|site tour|walking tour/i, 'art-architecture'],
  [/museum/i, 'art-museum'],
  [/festival|parade|\bfair\b|street party|block party/i, 'art-festival'],
  [/food|bake|bread|cook|tasting|supper|brunch|dinner/i, 'art-bread'],

  /* Outdoors last of the specific rules: "walk" and "wander" appear inside
     plenty of titles that are really something else, so everything that could
     claim them has had its turn by here. */
  [/forest|ravine|nature|bird|garden|wander|hike|trail|park\b|walk\b/i, 'art-ravine'],
];

/* Title first, and the description only if the title says nothing.
 *
 * Reading both at once loses to incidental words, because a title is a name
 * somebody chose and a description is prose. "designwalks™ — Toronto" matches
 * the architecture rule on its title and is plainly right; read together with
 * its page, the phrase "a monthly walk-and-talk" reached the talk rule first
 * and made it a microphone. The Bentway's Public Trust went the same way on
 * "make promises".
 *
 * The description still earns its place for titles that are only a name:
 * "Sweet Sweet Friends" says nothing at all, and its page says improv. */
export function matchArt(raw) {
  const title = String(raw.title ?? '');
  for (const [when, art] of RULES) if (when.test(title)) return art;

  const description = String(raw.description ?? '');
  for (const [when, art] of RULES) if (when.test(description)) return art;

  /* Null means keep the source's default. A wrong specific symbol is worse
     than a vague one — the default is at least true of the venue. */
  return null;
}
