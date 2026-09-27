# What each illustration is for

Two different things get called a category here and they do not line up
one-to-one, which is worth getting straight before drawing anything.

**A category** is one of fifteen fixed buckets. It decides the card's pastel
tint and which filter the listing appears under, and it is set by hand on
`data.js` entries or per-source in `sources.mjs`. It is about *where a listing
belongs on the board*.

**A family** is what the event actually is, read off its title by
`scrape/art-match.mjs`. It decides which drawing appears. It is about *what the
picture should show*.

They come apart constantly. An artist talk at the Bentway is in the
`architecture` category because the Bentway is an architecture venue, and it
should draw a microphone because it is a talk. A farmers' market at Evergreen
Brick Works is `dropin` because that is how Evergreen's events are filed, and
it should draw a market stall. The category is the venue's answer; the family
is the event's.

---

## The fifteen categories

Each has a default drawing, used when the title says nothing a family rule can
catch. A category with no listings is not dead — it is a bucket waiting for a
source that feeds it.

| category | label · tint | what it covers | default | now |
|---|---|---|---|---|
| `museum` | Museum · `#e7e2f6` | free nights and PWYC hours at named institutions — AGO, Gardiner, Bata, Aga Khan | `art-museum` | 5 |
| `art` | Art & exhibitions · `#d9ece7` | shows with an opening and a closing date, gallery and artist-run-centre programming | `art-gallery` | 9 |
| `market` | Farmers' market · `#e3eedc` | recurring produce markets — the Stop, Brick Works, St. Lawrence, Sorauren, Withrow | `art-market` | 7 |
| `flea` | Flea market · `#fbeeda` | vintage, antique and secondhand fairs, one-off and seasonal | `art-flea` | 3 |
| `books` | Books · `#dfe8f5` | literary festivals, author events, book launches, reading series | `art-books` | 2 |
| `architecture` | Architecture · `#f6e3ec` | heritage sites, walking tours, public space, the Bentway and Fort York | `art-architecture` | 11 |
| `festival` | Festivals · `#fbe6de` | street festivals, parades, neighbourhood and cultural festivals | `art-festival` | 7 |
| `dropin` | Drop-ins · `#f4eec3` | turn-up-and-join sessions — life drawing, bike repair, makerspaces, library programmes | `art-tools` | 13 |
| `social` | Meetups · `#e8e4dc` | organised social things — book clubs, run clubs, walks, Luma's non-tech end | `art-mic` | 3 |
| `comedy` | Comedy · `#f0dbf5` | improv, stand-up, sketch, open mics — Comedy Bar and Bad Dog | `art-neon` | 14 |
| `stage` | Stage · `#ecdcc9` | live shows that are not music or comedy — theatre, readings, live podcasts | `art-lamp` | 1 |
| `music` | Live music · `#f6dbe1` | gigs and nights at rooms — Grossman's, the Emmet Ray, Revival, the Rex | `art-records` | 4 |
| `film` | Film · `#dcdef2` | screenings, repertory cinema, festivals, outdoor films | `art-filmreel` | 5 |
| `outdoors` | Outdoors · `#d2e8ea` | ravines, trails, swims, skates, parks — **no source feeds this yet** | `art-ravine` | 0 |
| `food` | Food & drink · `#e6efd3` | tastings, suppers, food events — **no source feeds this yet** | `art-bread` | 0 |

`outdoors` and `food` being empty is the clearest gap on the board. Both are
things people actually want on a "what should I do today" calendar and neither
has a source pointed at it.

---

## The seventeen families

Read off the title first, the description only if the title says nothing. First
match wins, so order matters — the list runs specific to general.

| family | catches titles containing | typical event |
|---|---|---|
| `art-skates` | roller skate, skating, skate trail, ice rink | a skate lesson, a rink session, the Bentway trail |
| `art-market` | farmers' / artisan / vintage / night market | any market, whatever venue files it under |
| `art-flea` | flea, swap meet, car boot | secondhand and vintage fairs |
| `art-camera` | photo, camera, portrait, darkroom | photo walks, portrait sessions, darkroom drop-ins |
| `art-filmreel` | film, screening, cinema, movie, documentary, matinee | anything projected |
| `art-books` | book club, author, reading, novel, memoir, poet, library | author events, book clubs, library programmes |
| `art-mic` | artist talk, talk, lecture, panel, in conversation, keynote | someone speaking to a room |
| `art-sculpture` | exhibit, installation, gallery, mural, public art | a show you walk around |
| `art-neon` | improv, stand-up, comedy, open mic, sketch, showcase | comedy in any form |
| `art-records` | jazz, band, concert, choir, opera, DJ, vinyl, karaoke | live music, the broadest family on the board |
| `art-vase` | clay, pottery, ceramic, craft, knit, sew, workshop | making something with your hands |
| `art-bicycle` | bike, cycle, velo | rides, repair sessions, cycling events |
| `art-architecture` | architect, design walk, building, heritage, site tour | guided walks and built-environment events |
| `art-museum` | museum | anything at a named museum |
| `art-festival` | festival, parade, fair, street party, block party | a thing that closes a street |
| `art-bread` | food, bake, bread, cook, tasting, supper, brunch | eating and drinking |
| `art-ravine` | forest, ravine, nature, bird, garden, hike, trail, park, walk | outdoors — **last on purpose**, because "walk" and "park" appear inside plenty of titles that are really something else |

No match means the listing keeps its category default, which is at least true
of the venue. A vague drawing is a smaller error than a confident wrong one.

---

## Where the new renders go

Sixteen were generated and none are wired in. They exist to break up the two
families that carry most of the board — `art-records` at 130 of 190 listings
and `art-neon` at 30.

| family | drawings | covering |
|---|---|---|
| jazz | `art-sax` `art-bass` `art-trumpet` `art-piano` `art-drums` | quartets, quintets, trios, bebop, swing — 59 listings |
| jam | `art-jam-stool` `art-jam-guitars` `art-jam-drum` | jams, open sessions, open mics — 26 |
| comedy | `art-improv` `art-standup` | plus the existing `art-neon` — 30 |
| blues | `art-blues` | blues, roots, rockabilly — 8 |
| folk | `art-folk` | folk, songwriter, acoustic — 6 |
| DJ | `art-decks` | DJ and dance nights — 6 |
| kids | `art-kids` | family programming — 9 |
| outdoors | `art-boardwalk` | joins `art-ravine` so the category has two — 10 |
| civic | `art-civic` | participatory and civic work like Public Trust — 2 |

Still unserved by any drawing, new or old: `food` and `stage` have category
defaults but no family rule, so nothing routes to them by title. Neither has
volume yet, which is why they are not drawn.
