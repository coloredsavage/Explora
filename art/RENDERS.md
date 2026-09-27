# The 3D render library

Thirty-seven renders covering all fifteen categories and every matcher family
that carries real volume. They are generated, not drawn: a fixed prompt
template with two slots, one image per subject, background removed and scaled
to a common baseline.

These replaced the inline SVG symbols. [SPEC.md](SPEC.md) is now a record of
that retired system, kept because the rules it derived — draw the subject not
the category, detail in proportion to the subject — decided what got drawn
here. This file is about the set that ships, and about what it cost to learn
how to make one.

## The pipeline

    scratchpad/gen5.py        generate, and reject anything that runs off the frame
    scratchpad/margins.py     where the object sits inside the frame
    scratchpad/cutout2.py     background removal and scale normalisation

`TEMPLATE.txt` has two slots, `{OBJECT}` and `{MATERIALS}`. Splitting them was
not cosmetic: a single blended prompt made every one of sixteen renders gold,
because the style half said "warm polished materials" and nothing overrode it
per subject.

Output is 1920×1280. Cut-outs land on a 1040×800 canvas — 4× the symbols'
260×200 — scaled to 86% width and 80% height and sat on a baseline at 87%, so
the set is one size on a card.

## What had to be learned

Each of these cost at least one wasted batch.

### Name the subject, but describe the geometry

Naming a thing works when the model knows it and fails silently when it does
not. "Gooderham Flatiron Building" produced a generic Richardsonian block.
Describing the wedge produced an open V — two wings hinged at the prow. Tightening
that to "closed triangular wedge" produced a plain rectangle. Six attempts, no
triangle, because the model will not hold a triangular plan at this camera angle.

The fix was to change subject, not prompt: a Romanesque civic hall with an
off-centre clock tower, which is Old City Hall's silhouette and a massing the
model produces readily. The same failure took the saxophone three rounds and
`art-skates` four.

Check a named landmark against a reference before accepting it. The first
streetcar was a 1950s PCC car; Toronto's streetcars are Flexity Outlooks —
28 metres, five articulated sections, low floor, pantograph.

### Two objects only work when one is subordinate

The renders with two things that read well — the painting with its palette, the
picnic basket with its blanket, the suitcase stack with its camera — all have a
clear main object and something smaller resting on or against it.

The ones that failed put two things side by side at equal weight: a microphone
beside a bar stool came out the same height as the stool, a vase beside a bowl
read as a pair of unrelated pots. **It is not "never two objects", it is "never
two co-equal ones."** When in doubt, one object.

### The model does not honour "generous white space"

It framed the easel, the lanterns and the suitcases flush to an edge despite
the template asking for margin. A cut-out cannot restore what was never drawn.

Two of those three passed a visual review, because a clipped object only looks
wrong once you know to look for it. So the check is arithmetic and it runs
before a render is accepted — `gen5.py` re-rolls up to three times on any
render whose ink reaches within two pixels of an edge.

### A pale object dies against a white background

`isnet-general-use`, which cut the first sixteen renders cleanly, cannot tell a
pale object from the white behind it. It bit a corner off a cream cheese wedge
and made a cream sketch pad half transparent, leaving a charcoal drawing
floating on nothing — 15.6% of that frame solid against 10.1% only partly
opaque.

`birefnet-general` reads the same pad at 25.0% solid and 0.7% partial.
`bria-rmbg` is as good. Alpha matting stays off in all cases: on a
white-background render it re-judges edge pixels against a near-white
assumption and hands the fringe straight back.

The failure is invisible on white, which is how it survived review. **Check
cut-outs composited on a colour nothing in the set contains.** Magenta works.

Stray alpha matters too, not just holes: isnet left faint noise across the
frame, so bounding boxes came out near-full-frame and the "normalised" scale
was being set by noise rather than by the objects.

## The set

Fifteen categories, each with one render:

    museum        marble bust in reading spectacles
    art           gilded frame, simplified Monet haystack, palette and brushes
    market        stall canopy, produce crates, bucket of flowers
    flea          suitcase stack, folding camera, brass key on a fob
    books         stack of hardbacks, one open with an ink leaf doodle
    architecture  Romanesque civic hall with a clock tower
    festival      three paper lanterns on a crossbar with streamers
    dropin        easel with a charcoal pear-and-jug sketch
    social        picnic basket with bread, cheese, grapes and a blanket
    comedy        vintage ribbon microphone, cable coiled
    stage         fresnel spotlight with an amber gel
    music         combo amplifier with a coiled cable
    film          projector with film unspooling from the reel
    outdoors      cedar-strip canoe with a paddle across the gunwales
    food          board with bread, cheese, grapes and a glass of wine

Twenty-two family drawings, sized against the counts in
[LIBRARY.md](LIBRARY.md):

    jazz     59 listings   jazz-sax  jazz-bass  jazz-trumpet  jazz-piano  jazz-drums
    jam      26            jam-stool  jam-guitars  jam-drum
    comedy   30            improv (joins the category's microphone)
    blues     8            blues
    folk      6            folk
    DJ        6            decks
    kids      9            kids
    outdoors 10            boardwalk (joins the canoe)
    civic     2            civic
    other                  skates  camera  bicycle  pottery  lectern  sculpture

`streetcar` exists and nothing routes to it. It was made because it is the most
Toronto object there is, which is not a use case. Kept for a hand-picked
listing; otherwise it is the second orphan in this library after the vector
`art-streetcar`, and worth deleting rather than justifying.

`standup` was cut. The board had three microphones — the comedy one, this, and
the lectern — for two distinct jobs. Comedy keeps its microphone and the improv
chairs; talks get the lectern.

## How it is wired

`illustrations/<id>.webp`, 640px wide, 1.45 MB for all forty-five. The file
name *is* the id, so `data.js`, `sources.mjs` and the matcher kept their
vocabulary — `art-market` still means `art-market`, it just resolves to a file
instead of a `<symbol>`.

`symbolFor()` in `app.js` builds a lazy `<img>`; `img[data-art]` in styles.css
gives it `object-fit: contain`, which is the whole of the sizing, because every
file is already cut to 13:10 with the object at a fixed fraction of the frame.

`node scripts/art-sheet.mjs` writes a contact sheet and reports usage. Run it
with `--check` to fail on an id that has no image — a missing file is a broken
card, and it only shows on the one listing that uses it.

Sources live outside the repo, in `~/Desktop/explora-artwork/`: full-resolution
renders, cut-outs, the exact prompt for every one, both MATERIALS files and the
scripts.

### Migrating the ids

The old vocabulary used some ids metaphorically, and a blanket rename got seven
listings wrong before anyone looked: the Bata Shoe Museum lost its shoe, MOCA
drew an amplifier, an improv drop-in drew a lectern, and Art Toronto became a
film festival because "Film Festival" appeared twelve lines away in the file.

Any future rename wants the same discipline: remap, then read every changed
listing back with its title beside it. The mapping is only as good as the
meaning behind the old name, and the old name is not always what it says.
