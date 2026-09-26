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

## What to add

One drawing per idea is not enough, even when the idea is right. Fifty-nine
jazz listings drawing one saxophone is wallpaper however well the saxophone
is drawn — the board stops reading as a calendar and starts reading as a
template. **Roughly one drawing per twelve listings** is where a repeat stops
being noticeable, and that is where these counts come from.

Variants are different things, not the same thing drawn twice. A jazz night
is as honestly a double bass as a saxophone; four instruments read as range,
where four saxophones read as a mistake.

| family | listings | drawings | what they are |
|---|---|---|---|
| jazz | 59 | **5** | saxophone, double bass, trumpet, piano, drum kit |
| comedy | 30 | **3** | the existing `art-neon`, plus two chairs for improv, brick-wall-and-mic for stand-up |
| jam / open session | 26 | **3** | a stool and mic stand, two guitars leaning, a hand drum |
| outdoors | 10 | **2** | the existing `art-ravine`, plus a boardwalk or a footbridge |
| kids and family | 9 | **1** | a paper boat, a kite |
| blues and roots | 8 | **1** | an electric guitar |
| folk / songwriter | 6 | **1** | an acoustic guitar or a fiddle |
| DJ and dance | 6 | **1** | turntables |
| civic / participatory | 2 | **1** | a ballot box — Public Trust currently draws a roller skate |

**Sixteen new drawings, for a library of fifty.** After which no symbol lands
on more than about twelve of a hundred and ninety, against `art-records`'s
current hundred and thirty.

Start with the five jazz drawings. They are a third of the whole gain.

### How a listing gets one of them

`FAMILIES` in `art-match.mjs` maps an idea to its drawings; a family with one
member is the normal case and costs nothing. Adding a drawing later is a
string in that table and nothing else.

Which one a listing gets is a hash of its title, so it is stable: the same
night keeps the same drawing across every poll, and a weekly residency keeps
it week after week, which reads as the show having an identity rather than as
a shuffle. Two different shows land wherever the hash puts them.

Measured over fifty-nine unique music titles across five drawings: 15, 13,
12, 10, 9 against an ideal of 11.8 — inside one standard deviation. The
listing-level counts look lumpier than that, because thirty-six of the
ninety-five are repeats of recurring nights that deliberately keep one
drawing each.

Two notes for whoever draws these. Adding a drawing reshuffles its family,
which is a one-off and harmless — nothing downstream depends on a listing
keeping its drawing forever. And the hash needed murmur3's finalizer on the
end of FNV: without it the modulo only reads the low bits, and titles that
share this much shape — "… Quartet, Straight Ahead Jazz" — spread 27/24/23/12/9
instead.

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
