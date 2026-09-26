# The illustration system

Thirty-four SVG symbols live inline in `index.html`, one `<symbol>` each, and
every card on the board draws one of them. There was no written spec, which is
how a speedometer ended up standing in for neon on fourteen listings.

This is not a new style. It is the rules the best of the existing drawings
already follow, measured off them, so that redrawing one converges on the set
instead of drifting away from it.

## What the good ones have in common

The three singled out as the strongest — `art-streetcar`, `art-market`,
`art-architecture` — agree on all of the below. The weakest break two or three
each.

### 1. The object sits on its shadow

This is the rule that matters most and the one most often broken.

Every symbol carries a ground shadow: an ellipse low in the frame, `fill="#000"`
at `opacity=".06"`. The shadow is not a thing underneath the object. It is the
ground the object is standing on, and an object standing on the ground
**overlaps** it — the near edge of the ellipse disappears behind whatever is
resting there.

Measure it as the gap between the object's lowest point and the shadow's centre
line:

    gap = (bottom of object, shadow excluded) − (shadow cy)

| | gap | reads as |
|---|---|---|
| `art-streetcar` | −2 | standing |
| `art-architecture` | −6 | standing |
| `art-house`, `art-tree`, `art-lamp` | −4 | standing |
| `art-museum` | −12 | **floating** |
| `art-neon` | −20 | **floating** |
| `art-gallery` | −22 | **floating** |

**Target −2 to −6.** Past about −8 the whole ellipse is exposed below a hard
bottom edge, the curve of its top reads as a second object, and the drawing
hovers. `art-museum` is the clearest case: a flat plinth with clean air beneath
it and a full ellipse sitting in the air below that.

A flat-bottomed object — a building, a box, a plinth — needs the overlap most,
because it has no legs or wheels to break the line.

The number tells you where to look; it does not pass the verdict. `art-market`
gaps at −12, the same as `art-museum`, and reads fine — its awning, crates and
loose fruit give the eye so much to sit on that the ellipse underneath stops
being the story. The museum is one symmetrical mass with a hard horizontal
edge, so there is nothing to look at except the gap. Treat anything past −8 as
a drawing to open, not a drawing to reject.

### 2. Detail in proportion to the subject

The first version of this rule said more detail is better, on the strength of
the best drawings carrying twelve to fourteen distinct fills against a median
of six. The correlation is real and the conclusion was wrong.

A streetcar has fourteen fills because a streetcar *has* windows, a trolley
pole, a destination board, a skirt and wheels. The detail is earned by the
object. A microphone is a simpler thing in the world, and drawing it with
fourteen tones would not make it better — it would make it fussy, and fussy is
its own failure. The market basket earns thirteen; a jar of preserves does not
need thirteen and should not be given them.

So the question is not how many, it is whether the drawing has as many pieces
as the thing it depicts. Both directions are faults:

- **Under-drawn** — a complex object flattened to a silhouette in two tones.
  `art-neon` was a rectangle and an arc standing in for a lit sign.
  `art-bicycle` is one fill for a machine made of tubes, wheels and a chain.
- **Over-drawn** — a simple object given planes, trim and highlights it does
  not have, so it reads as decorated rather than depicted.

**Two to three fills is a floor worth questioning, not a target to beat.** Below
about four, a drawing is almost certainly a pictogram whatever its subject. Above
that, the count says nothing on its own and the tool reports it without judging.

The honest test is the same one as for everything else here: put it on the
sheet next to the others. A drawing that is too plain looks unfinished in
company, and one that is too busy looks loud. Neither is a number.

### 3. Centred, and the frame is 260 × 200

`viewBox="0 0 260 200"`. The object's horizontal centre sits at **x = 130, ±3**.

Currently off: `art-gramophone` (155), `art-filmreel` (148), `art-flea` (144),
`art-sculpture` (139) push right; `art-lantern` (105) and `art-skates` (115)
push left. Nothing else is further than 3 out. An off-centre object in a grid of
centred ones is read as a mistake even when nobody can say why.

### 4. Vertical placement

- Object base lands around **y = 166 to 174**.
- Shadow `cy` around **y = 172 to 180**.
- Nothing crosses y = 190; the bottom ten pixels stay clear.
- Tall objects start around y = 12 to 20; most start at 30 to 60.

### 5. The shadow's width follows the object

Shadow width tracks the object's own footprint, not its widest point. The
streetcar is 232 wide and its shadow is 208 — narrower, because a tram rests on
its wheels, not on its mirrors. A shadow wider than the thing above it is the
second-commonest cause of floating.

**Keep `rx` at 0.85 to 1.1 of the object's contact width.**

### 6. Flat colour, no gradients, strokes allowed

No symbol uses a gradient and none should. Strokes are fine — nineteen of the
thirty-four use them — for wires, poles, legs, outlines of thin things.

The shared palette, in order of how often it is reused:

| | |
|---|---|
| `#f2c14e` | warm yellow |
| `#e0a24b` | amber |
| `#f4f1e8` | cream |
| `#d9584f` | red |
| `#5f8fb0` | blue |
| `#cfc8b9` | warm grey |
| `#9fb7a4` | sage |
| `#c96a86` | pink |
| `#e6e0d2` | bone |

Reach for these before inventing a colour. Every card sits on a pastel category
tint, so the illustration has to hold against fifteen different grounds — which
is why the palette is mid-toned rather than pale.

### 7. Draw the subject, not the category

`art-neon` is used on fourteen comedy listings and is a dark rectangle with an
orange arc. It reads as a speedometer. `art-skates` reads as a stack of paper.
Neither is badly executed; both are drawings of an abstraction rather than a
thing.

Draw the object someone would actually see: a brick-lit club sign, a boot with a
blade. If a stranger cannot name it in a second with the label covered, it has
failed, however well it is drawn.

## What this method can and cannot draw

Worth recording, because three attempts were wasted finding out.

These symbols get written as SVG path data by hand, without a vector editor
and without seeing the shape until it renders. That works for **rectilinear
subjects** — the marquee sign is boxes, a post and a row of circles; the
museum is a pediment, four columns and three steps. Every coordinate can be
reasoned about and checked by arithmetic before it is drawn.

It does not work for **organic silhouettes**. `art-skates` was attempted three
times — front-on, then in profile with curves, then in profile from explicit
points — and every version measured correctly (gap −2, nine fills, centred)
and still read as a bench, then a parcel, then a boot on a ramp. A skate boot
is a compound curve, and a compound curve guessed at blind fails in a way no
measurement catches.

The ones still in the queue split the same way:

| rectilinear, drawable here | organic, needs an editor |
|---|---|
| `art-filmreel`, `art-books`, `art-tent` | `art-skates`, `art-ravine`, `art-shoe` |
| `art-jar`, `art-records` | `art-gramophone`, `art-fossil` |

For the right-hand column, trace over a reference in a vector tool and paste
the path in. That is not a failure of the spec — the spec still says what the
result has to satisfy — it is a different instrument for a different shape.

## Checking a drawing

`node scripts/art-sheet.mjs` writes `_art-sheet.html` — every symbol on its
category tint, in a grid. Open it and judge the set, not the drawing. Most
faults here are only visible in company.

It also prints the measurements above, so a redraw can be checked against the
rules rather than argued about.

## The queue, by how much each one is on screen

Three symbols cover 39% of every card on the board:

| | listings | state |
|---|---|---|
| `art-neon` | 14 | reads as a speedometer; floats at −20 |
| `art-ravine` | 10 | legible but generic — two conifers for a Toronto ravine |
| `art-skates` | 9 | reads as a stack of paper; off-centre at 115 |
| `art-museum` | 1 | floats at −12 |
| `art-gallery` | 1 | floats at −22 |

Duplicated pairs, which want merging rather than redrawing: `art-arch` against
`art-sculpture`, `art-easel` against `art-gallery`, `art-shoe` against
`art-bread`.

`art-streetcar` and `art-architecture` are defined and used by nothing.
