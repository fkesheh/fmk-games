# Trees — Round 3 Scorecard

**Verdict: 0 / 5 PASS. Round 3 fails.**

Round 2's headline defects are not fixed — they are *relocated*. Floating geometry moved from
the variations into the birch hero. Raw primitives moved from cones/capsules to ribbons, prisms
and boxes. Per-face noise moved from value-jitter to literal black polygon confetti on the pine.
And a new class of defect appeared that is worse than anything in R1/R2: **degenerate,
zero-width geometry rendering as 1-pixel black hairlines** across snag, palm and birch. That
alone is disqualifying in a shipping asset library.

Three of the five claims in the R3 brief are contradicted by the pixels:
- "readable lenticel bands" — **the birch trunk has zero lenticels at any distance.**
- "curved ringed trunk … crown ~40% of trunk height" — **the palm trunk is a dead-straight
  untapered hex prism**; the crown reads as a scrawny spider, not a canopy.
- "drooping tip blades **in foliage colors**" — **the pine tip blades render near-black.**

---

## Scores

| Species | Silhouette | Value tiers | Geometry craft | Story detail | Stage presence | Variation | Verdict |
|---|---|---|---|---|---|---|---|
| **Oak**   | 5 | 5 | 4 | 3 | 5 | 4 | **FAIL** |
| **Birch** | 5 | 4 | 2 | 2 | 4 | 3 | **FAIL** |
| **Pine**  | 4 | 3 | 2 | 2 | 3 | 2 | **FAIL** |
| **Snag**  | 6 | 5 | 3 | 4 | 5 | 4 | **FAIL** |
| **Palm**  | 3 | 4 | 2 | 2 | 3 | 2 | **FAIL** |

Pass bar is ≥7 on every axis with no fatal smell. **Highest single score in the set is a 6.**
Nothing here is borderline.

---

## Fatal smells (global, present across species)

1. **Degenerate zero-width geometry → black hairlines.** `snag-closeup` shows three perfectly
   straight 1px black lines through the frame; `snag-front`/`-high`/`-v1`/`-v2` all carry them;
   `birch-v2` has one crossing the crown from mid-left to lower-right; `palm-front` renders two
   entire fronds as black lines. These are quads collapsed to a plane or line. They are not
   stylization. They read as a broken mesh.
2. **Shadow tear + peter-panning, unresolved from R2.** Every shot has *two* shadows from *two*
   apparent lights: a hard, aliased, stair-stepped cast blob far to the left, and a soft symmetric
   grey ellipse centred under the trunk. In `oak-front` and `birch-front` the cast blob is
   physically **detached** from the trunk, joined only by a thin stalk. `pine-high` and `pine-front`
   fragment the shadow into disconnected comb-tooth islands. `snag-*` and `palm-*` cast a spidery
   scratch-web that reads as damage to the frame, not shade.
3. **Gradient-ramp sky.** The brief claims "banded sky". It is a smooth vertical gradient,
   pale blue-grey → cream, with no bands and no horizon treatment. This is the exact smell called
   out in R2, unaddressed.
4. **Dead ground.** One flat value, no tier, no variation, no contact darkening beyond the
   mismatched ellipse. The horizon line also *moves* between shots (`pine-closeup` and
   `palm-closeup` show a domed horizon; the wide shots show it flat) — the ground is a sphere or
   disc read at inconsistent scale.
5. **Closeups aimed at nothing.** `oak-closeup` is an abstract field of green triangles with no
   readable subject. `snag-closeup` crops **off the splintered top** — the one story beat that
   shot exists to sell. `palm-closeup` and `birch-closeup` crop the crown. If a closeup does not
   frame the detail it was commissioned to prove, it is not evidence, it is filler.
6. **Framing under-delivers.** Base shots read ~55–70% of frame height, not the claimed 75%.

Sun *is* locked frame-right and consistent across all 30 frames — that one claim holds. But the
key is so weak that light/shadow separation on the trunks is barely a value step outside the oak.

---

## Oak — FAIL

The strongest crown in the set and still not close.

**What works.** Three-to-four legible green tiers, and `oak-high` proves the light logic is real
(crown top pales coherently). `oak-v2` finally shows branches carrying the crown.

**What fails.**
- **No sky-gaps, no breakup.** The brief promised "dominant + breakup clumps with sky-gaps."
  `oak-front` and `oak-three-quarter` show one solid mushroom with a smaller lump behind it. Light
  passes through nothing. This is a lollipop, not a heroic broadleaf.
- **The "thick splintered broken bough" is a twig.** In every wide shot it is a thin dark spline
  ~4px wide with a frayed tip. It reads as an antenna, or as an arrow that hit the tree. A broken
  bough must be a *load-bearing* limb — the same diameter class as the trunk it left.
- **No root buttresses.** The base is a dark truncated cone collar with a hard horizontal seam
  against the trunk. It reads as a separate object pushed into the ground, not as the trunk
  spreading into roots. There is no lobing, no gap between buttresses, no sky under the flare.
- **The knot is a lozenge decal.** A small dark diamond floating on the trunk face with no
  surrounding bulge or scar tissue.
- **Crown interior is triangle noise.** `oak-closeup` shows adjacent triangles jumping two value
  steps at random with no relationship to the form. That is per-face jitter wearing a tier costume.
  It also shows a **moiré hatching artifact** around the lower-right rim (~x850, y470) — coplanar
  faces fighting.
- **Variation is a hue swap.** `oak-v1` is the same mesh in autumn gold, and it carries a hard
  horizontal value seam across the mid-trunk that reads as a material bug. Worse: `oak-v2` is the
  *better model* (visible branch structure) — the hero should not be the weakest variant.

**Fixes.** Cut 3–5 real sky-gaps through the crown mass and let the silhouette edge break into
lobes with concave bays, not convex bumps. Rebuild the broken bough at 60–70% of trunk diameter
with a splintered stub of 4–6 tapered shards. Model buttresses as 4–5 separate swept lobes with
visible negative space between them at ground level. Replace per-face jitter with 3 painted value
tiers assigned by *cluster*, not by triangle. Promote the v2 branch structure into the hero.

---

## Birch — FAIL

**The claim "chalk trunk with readable lenticel bands" is false.** At 1280px in `birch-closeup`
the trunk is a **featureless grey tapered cylinder**. There is not one lenticel. The only marks on
it are two hard horizontal value steps (`birch-front` at ~y470 and ~y700) which are UV or material
seams, not bark — they cut the full cylinder at a constant height, exactly what a seam does and
exactly what a bark band does not.

**Other fatals.**
- **Floating crown.** In `birch-three-quarter` and `birch-closeup` the sheet cluster at frame-right
  hangs in open air with no branch, no twig, no connection to the trunk. The mass at left is offset
  from the pole entirely. This is R1's fatal defect, back in the hero shot.
- **No branch structure at all** in the four canonical shots. A pole with plates hovering over it.
- **The trunk pokes through the crown.** `birch-v2` shows a grey nub emerging from the top-left of
  the sheet stack, and a wire-thin black branch line crossing the whole crown.
- **`birch-v1` floats a second trunk** — the left stem terminates in mid-air inside a sheet and
  does not resolve to the ground.
- Silhouette is the one honest thing here: the plate stack is distinct from the oak. But it reads
  **pagoda/bonsai**, not birch. Real birch is a fine, drooping, vertical-tending mass; these are
  horizontal dinner plates.

**Fixes.** Model lenticels as *geometry* — short horizontal wedge insets, 8–12 per trunk, varied in
length, clustered denser low and sparser high, sized to survive at 30m. Kill the two seam bands.
Build an actual 3-tier branch skeleton and hang every sheet off a branch tip; nothing may exist
without a parent. Cap the leader *inside* the crown volume. Tilt sheets off horizontal and give the
stack a vertical bias.

---

## Pine — FAIL

**The worst frames in the set.** The "drooping tip blades in foliage colors" are rendering as
**near-black shards scattered across the skirts** — `pine-front` and `pine-three-quarter` are
speckled with dozens of them. They do not read as needles, drooping tips, or anything botanical.
They read as z-fighting garbage, dead insects, or texture corruption. `pine-closeup` confirms
several are **half-buried in the skirt surfaces** — actual interpenetration, not intended overlap.

- **Skirts are a raw cone stack.** `pine-front` shows straight cone edges and hard triangular
  facets. The claimed "welded lobed skirts with sagging scallops" are not visible from any of the
  six angles. There is no scallop, no sag, no lobe.
- **Trunk is a 4-sided brown box** with a hard vertical seam, ~30px tall.
- **Value read is destroyed.** Three close-together greens plus black confetti. The cold blue-green
  hue direction is roughly right, but the tiers cannot be read through the noise.
- **`pine-v1` is broken**: the bare brown leader spikes straight up out of the foliage at
  frame-right, naked, ending in an unclad cone tip.
- **`pine-v2` "snowbound" is one white triangle at the apex.** Nothing else on the tree carries
  snow. That is not a variation; it is a hat.

**Fixes.** Recolor the tip blades into the light foliage tier and widen them by 3–4×; if they
cannot be made readable, delete them entirely — the current state is strictly worse than nothing.
Push the blades outboard of the skirt surface so they cannot interpenetrate. Rebuild each skirt as
a welded lobed ring: 6–8 lobes, concave bays between them, tip vertices dropped below the ring
plane so the silhouette sags. Snow must be a real up-facing shell on *every* skirt, not an apex cap.

---

## Snag — FAIL

The best silhouette in the library, and still failed by execution.

**What works.** The bleached silver-tan value range is genuinely good and clearly separated from
the ground. The kinked lean and splintered crown read at distance. `snag-three-quarter` is the only
frame in all 30 that has any *character*.

**What fails.**
- **Degenerate hairlines.** `snag-closeup` shows three ruler-straight black 1px lines; `snag-v2`
  has four more. Fatal.
- **The stubs are not thick.** The brief demanded "THICK splinter-ended stubs." They are flat
  blades — `snag-front` shows one as a **single black plane seen edge-on** (~x545–620, y415–465),
  which is the definition of a paper-thin primitive. A splinter-ended stub needs volume: a tapered
  prism ending in 3–5 separate shards of differing length.
- **The woodpecker hole is unreadable.** In `snag-v1` it is a faint diamond a few pixels across at
  mid-trunk. It carries no darkness, no rim, no depth. It is a decal at the threshold of visibility.
- **Seam bands** on the trunk (`snag-closeup`, two hard horizontal steps) — same bug as the birch.
- **`snag-v2` floats green shards at the base** — two small green triangles half-sunk into the
  ground beside the trunk with no parent object.
- **Shadow is a scratch-web**: `snag-front` casts a spidery line-shadow from x=0 to x=430 that
  reads as a crack in the image.

**Fixes.** Purge all degenerate quads (any face with an edge below ~1cm world-space). Rebuild the
stubs with real cross-section and multi-shard terminations. Make the woodpecker hole a proper
inset: recessed dark cavity, ~8% of trunk width, with a lighter torn rim so it reads at 20m.

---

## Palm — FAIL

**The fronds are flat single-sided ribbons.** In `palm-front`, two fronds render as **pure black
1-pixel lines** because they are edge-on to camera. A frond that disappears from certain angles is
not an asset. `palm-closeup` shows the rest as **straight-edged green tape** — no leaflet notching,
no rachis, no split, no taper. They read as party streamers.

- **The trunk is a dead-straight untapered hex prism.** The brief claims "curved ringed trunk." It
  is not curved in `palm-front`, `palm-three-quarter`, `palm-v1`, or `palm-v2`. The "rings" are a
  faint sawtooth notching visible on **one silhouette edge only**, which reads as a seam artifact.
- **Crown does not read as 40%.** It may measure near it, but a scrawny 8-ribbon spider on a thick
  pole reads as ~15%. Mass, not span, is what sells crown weight.
- **Coconuts are a black void.** The crown centre is a near-black lump with a hard notch in it. In
  `palm-closeup` it reads as a *hole in the mesh*, not fruit. Coconuts need to be discrete, lit,
  mid-value spheres that catch the key.
- **Arch is wrong.** In the wide shots the fronds mostly droop straight down or shoot straight out;
  the up-crest-then-sag arc only appears in `palm-high`, which is the one angle nobody plays from.
- **`palm-v1`** wraps a green sleeve of foliage *through* the trunk below the crown — intersecting
  geometry. **`palm-v2`** ("coconut-heavy, dead fronds hanging down") points its two brown dead
  fronds **up and to the left**, not down. The variation contradicts its own brief.

**Fixes.** Give every frond thickness and a V-fold along the rachis so it never vanishes edge-on.
Notch the leaflets — even 6 alternating triangular cuts per side reads at distance. Curve the trunk
along an S with real taper, and model rings as continuous ridge geometry visible on both silhouette
edges. Rebuild coconuts as a lit cluster in the mid-value range. Fix the arc: rise, crest above the
crown attachment, then sag past horizontal — currently it only sags.

---

## What must land before Round 4 is worth capturing

1. Purge every degenerate face in the library. Add a mesh gate that fails the build on any edge
   below a world-space threshold. This is mechanical and non-negotiable.
2. Fix the shadow pipeline. One light, one shadow. Kill the mismatched soft ellipse or make it the
   *only* contact shadow and align it with the key. No detached blobs, no comb-tooth fragments.
3. Replace per-face value jitter with cluster-assigned tiers everywhere.
4. Band the sky for real, and tier the ground.
5. Re-aim the closeup camera at the story detail it is supposed to prove.
6. Fix the three false claims — birch lenticels, palm trunk curve, pine blade color — before
   claiming them again. A brief that does not survive contact with its own screenshots costs more
   review cycles than the work it describes.
