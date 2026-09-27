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
  [/film|screening|cinema|movie|documentary|matinee/i, 'art-film'],

  /* Books before talks: an author event is a book event first, and "Randy
     Boyagoda: Lords of Serendipity" carries neither word. */
  [/book club|\bauthor\b|reading|novel|memoir|poet|literar|library/i, 'art-books'],
  [/artist talk|\btalk\b|lecture|panel|in conversation|keynote|q&a/i, 'art-lectern'],

  [/exhibit|installation|gallery|mural|sculpture|vernissage|public art/i, 'art-sculpture'],
  [/improv|stand.?up|comedy|open mic|sketch|showcase|audition/i, 'art-comedy'],

  /* Music, specific before general. One crate of records landed on a hundred
     and thirty of the last hundred and ninety listings, and fifty-nine of
     those were jazz — so the genres that carry real volume get their own
     drawings and everything else still falls through to the amplifier.

     Jam first: "Tuesday Night Jazz Jam" is more usefully a jam than a jazz
     quartet, because the format is what a reader is deciding about. */
  [/\bjam\b|jam session|open session/i, 'art-jam'],
  [/jazz|quartet|quintet|\btrio\b|bebop|\bswing\b|straight ahead/i, 'art-jazz'],
  [/blues|rockabilly|\broots\b/i, 'art-blues'],
  [/\bfolk\b|songwriter|acoustic|bluegrass/i, 'art-folk'],
  [/\bdj\b|\bdisco\b|dance party|dance night|house night/i, 'art-decks'],
  [/\bband\b|concert|choir|opera|vinyl|record|karaoke|\bgig\b/i, 'art-music'],

  /* No bare `make`: it caught "make promises to themselves" in the Bentway's
     Public Trust and turned a democracy project into a pot. */
  [/clay|pottery|ceramic|craft|knit|sew|weav|workshop/i, 'art-pottery'],
  [/\bbike|cycl|velo/i, 'art-bicycle'],
  [/architect|design.?walk|building|heritage|site tour|walking tour/i, 'art-architecture'],
  [/museum/i, 'art-museum'],
  [/festival|parade|\bfair\b|street party|block party/i, 'art-festival'],
  [/food|bake|bread|cook|tasting|supper|brunch|dinner/i, 'art-food'],

  /* Family programming. After comedy, so a "Family Comedy Matinee" stays
     comedy, and after food, so a kids' baking session stays a loaf. */
  [/\bkids\b|children|toddler|storytime|all ages|family day/i, 'art-kids'],

  /* Civic and participatory work — the Bentway's Public Trust is the whole of
     this today, which is why the words are its words and not a general rule. */
  [/democracy|civic|public trust|town hall|participatory/i, 'art-civic'],

  /* Outdoors last of the specific rules: "walk" and "wander" appear inside
     plenty of titles that are really something else, so everything that could
     claim them has had its turn by here. */
  [/forest|ravine|nature|bird|garden|wander|hike|trail|park\b|walk\b/i, 'art-outdoors'],
];

/* A family is one idea with more than one drawing of it.
 *
 * Fifty-nine of the last hundred and ninety listings were jazz. One
 * saxophone on fifty-nine cards is wallpaper however well it is drawn, and
 * the board stops reading as a calendar and starts reading as a template.
 * Roughly one drawing per twelve listings is where a symbol stops being
 * noticeable as a repeat, which is where the counts below come from.
 *
 * Variants are different things, not the same thing drawn twice: a jazz
 * night is as honestly a double bass as a saxophone, and four instruments
 * read as range where four saxophones read as a mistake.
 *
 * A family with one member is the normal case and costs nothing. Adding a
 * drawing later is a string in this table and nothing else. */
export const FAMILIES = {
  /* A family key is not always a file. 'art-jazz' and 'art-jam' exist only to
     be expanded — nothing draws them — while 'art-comedy' and 'art-outdoors'
     are real files that also head a family. Either way pick() returns a member,
     and a key with one member returns itself, so a family costs nothing until
     there is a second drawing to put in it. */
  'art-jazz':     ['art-jazz-sax', 'art-jazz-bass', 'art-jazz-trumpet',
                   'art-jazz-piano', 'art-jazz-drums'],
  'art-jam':      ['art-jam-stool', 'art-jam-guitars', 'art-jam-drum'],
  'art-comedy':   ['art-comedy', 'art-improv'],
  'art-outdoors': ['art-outdoors', 'art-boardwalk'],
  'art-music':    ['art-music'],
  'art-market':   ['art-market'],
};

/* Which drawing a listing gets, out of its family.
 *
 * Seeded on the title so it is stable: the same night keeps the same drawing
 * across every poll, and a weekly residency keeps it week after week, which
 * reads as the show having an identity rather than as a shuffle. Two
 * different shows land wherever the hash puts them, which is the point.
 *
 * Adding a drawing to a family reshuffles that family. That is a one-off and
 * worth it; nothing downstream depends on a listing keeping its drawing
 * forever. */
function pick(family, seed) {
  const options = FAMILIES[family];
  if (!options || options.length < 2) return family;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  /* FNV alone spread ninety-five music titles 27/24/23/12/9 across five
     drawings — a three-to-one gap, because the modulo only sees the low bits
     and these titles share too much shape ("… Quartet, Straight Ahead Jazz").
     The avalanche below is murmur3's finalizer: it mixes the high bits down
     before the modulo reads them. */
  h ^= h >>> 16; h = Math.imul(h, 2246822507);
  h ^= h >>> 13; h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return options[(h >>> 0) % options.length];
}

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
  const description = String(raw.description ?? '');

  let family = null;
  for (const [when, art] of RULES) if (when.test(title)) { family = art; break; }
  if (!family) for (const [when, art] of RULES) if (when.test(description)) { family = art; break; }

  /* Null means keep the source's default. A wrong specific symbol is worse
     than a vague one — the default is at least true of the venue. */
  if (!family) return null;
  return pick(family, title);
}

/* The source's own default goes through the same expansion, so a listing
   that matched nothing still gets the variety of its family rather than
   always the first drawing in it. */
export function variantOf(art, seed) {
  return pick(art, String(seed ?? ''));
}
