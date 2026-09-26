# The illustration library

What exists, what is missing, and how big the set actually needs to be.

Sized against evidence rather than intuition: 190 real listings from a full
poll of every enabled source, plus the 84 currently on the board. Drawing
rules are in [SPEC.md](SPEC.md); which symbol a polled listing gets is decided
by [`scrape/art-match.mjs`](../scrape/art-match.mjs).

## The finding that sizes everything

Run the matcher over 190 real titles and only **ten symbols** get used, with
one of them carrying most of the board:

| symbol | listings | share |
|---|---|---|
| `art-records` | 130 | **68%** |
| `art-neon` | 30 | 16% |
| `art-ravine` | 10 | 5% |
| `art-skates` | 9 | 5% |
| everything else | 11 | 6% |

Two thirds of the calendar would draw the same crate of records. That is the
gap, and it is not spread evenly across the library — it is almost entirely
live music, because three venues that run something most nights were added at
once and the category had exactly one symbol.

## Where the volume actually is

Counted across those 190 titles:

| concept | titles | today |
|---|---|---|
| jazz — quartet, quintet, trio, bebop, swing | **59** | `art-records`, generic |
| jam and open sessions | **26** | `art-records`, generic |
| kids and family | 9 | nothing — falls to the source default |
| blues and roots | 8 | `art-records`, generic |
| improv | 8 | `art-neon`, generic |
| DJ and dance nights | 6 | `art-records`, generic |
| folk and songwriter | 6 | `art-records`, generic |
| civic and participatory | 2 | nothing — Public Trust draws a roller skate |
| stand-up | 1 | `art-neon`, generic |

Jazz alone is 59 of 190. A single symbol for it is worth more than the other
eight put together.

## What to add, in order of how much of the board it fixes

Nine drawings. Not thirty-four, and not a large generated set — the existing
thirty-four already cover everything outside music, and ten of twenty-three
polled titles were fixed by matching alone, with nothing new drawn at all.

| | symbol | covers | subject |
|---|---|---|---|
| 1 | `art-sax` | 59 | a saxophone or upright bass — jazz, and the single biggest win available |
| 2 | `art-jam` | 26 | a stool and a mic stand, or two guitars leaning together |
| 3 | `art-kids` | 9 | something a family programme reads as — a paper boat, a kite |
| 4 | `art-blues` | 8 | an electric guitar, which also carries rock and roots |
| 5 | `art-improv` | 8 | two chairs facing, which is what improv looks like |
| 6 | `art-decks` | 6 | turntables — DJ and dance nights |
| 7 | `art-folk` | 6 | an acoustic guitar or a fiddle |
| 8 | `art-standup` | 1 | a brick wall and a mic — the only honest stand-up image |
| 9 | `art-civic` | 2 | a ballot box or a ribbon — for participatory work like Public Trust |

Adding 1 and 2 alone takes `art-records` from 68% of the board to about 24%.

## What is already there and staying

Thirty-four symbols. Two are defined and drawn on nothing — `art-streetcar`
and `art-architecture` — which is worth knowing, because both are among the
best in the set and the matcher now routes site tours and design walks to
`art-architecture`.

    art-arch          art-architecture   art-bicycle     art-books
    art-bread         art-camera         art-cannon      art-corn
    art-easel         art-festival       art-filmreel    art-flea
    art-fossil        art-gallery        art-gramophone  art-house
    art-jar           art-lamp           art-lantern     art-market
    art-mic           art-museum         art-neon        art-ravine
    art-records       art-sculpture      art-shoe        art-skates
    art-star          art-streetcar      art-tent        art-tools
    art-tree          art-vase

Redraw queue, unchanged from SPEC.md and separate from the additions above:
`art-ravine` is generic, `art-skates` reads as a stack of paper,
`art-gramophone` reads as a frying pan, `art-fossil` is a blob. Three pairs
duplicate each other and want merging rather than redrawing — `art-arch`
against `art-sculpture`, `art-easel` against `art-gallery`, `art-shoe`
against `art-bread`.

## Why this is nine and not ninety

Every row above is answering titles the poller has actually returned. A
symbol that cannot be shown to serve something real is a symbol nobody will
remember exists, and the set already has two of those.

The long tail does not want more drawings either. It wants the fallback to be
honest: when the matcher finds nothing, the listing keeps its source's
default, which is at least true of the venue. A vague symbol is a smaller
error than a confident wrong one, and "generate enough to cover every case"
is a plan to make a great many confident wrong ones.

Worth re-running this sizing after the next full poll. The music venues were
added the same week and have barely been sampled; the street-festival and
`music` sources will shift these counts, and the noise-permit feed proposes a
kind of event — block parties, night markets — the board has never carried.
