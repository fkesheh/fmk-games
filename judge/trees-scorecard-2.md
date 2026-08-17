# Tree Library — Round 2 Art Direction Review

**Verdict: 0 / 5 pass.** Round 1's letterboxing is fixed. Round 1's *floating geometry* is not —
it is present in five of the ten variation captures. Two species (pine, snag) are built out of
recognizable raw primitives that no amount of shading will rescue. Nothing here sits in a BotW or
Firewatch promo frame.

Reviewed: 30 PNGs, all 5 species × {three-quarter, closeup, front, high, v1, v2}.

## Scorecard

| Species | Silhouette | Color/Value | Geometry craft | Story detail | Stage presence | Variation | Verdict |
|---|---|---|---|---|---|---|---|
| **oak**   | 6 | 6 | 5 | 5 | 3 | 3 | **FAIL** |
| **birch** | 3 | 3 | 2 | 2 | 3 | 3 | **FAIL** |
| **pine**  | 3 | 4 | 2 | 3 | 3 | 2 | **FAIL** |
| **snag**  | 4 | 3 | 2 | 3 | 2 | 3 | **FAIL** |
| **palm**  | 2 | 3 | 2 | 2 | 2 | 3 | **FAIL** |

Bar: every axis ≥ 7 and no fatal smell. No species clears a single axis at 7.

## Fatal smells found

| Smell | Where |
|---|---|
| **Detached / floating geometry** | `oak-v2` right clump floats free in open sky, gap of background between it and the crown. `birch-v1`, `birch-v2` leaf sheets hang off hair-thin twigs with visible gaps; one lower-left sheet in v2 touches nothing. `pine-v1` an entire extra cone is impaled on a bare brown stick floating beside the tree. `snag-v1` pale fragment adrift at mid-trunk left. |
| **Raw primitive** | `pine-*` is six unmodified stacked cones — clean circular skirts, regular n-gon bases visible from `pine-high`. `snag-*` stubs are cylinder + icosphere **capsules**; the sphere caps read as doorknobs. `palm-*` trunk is an untouched tapered cylinder. `oak-*` under-crown collar is a literal box; base flare is a raw cone. |
| **Z-fighting / clipping** | `pine-closeup` tip blades are shards half-buried in the cone surfaces, flickering black. `snag-closeup` woodpecker-hole quad extends **past the trunk silhouette** into open sky. `palm-closeup` trunk decal sits proud of the cylinder. |
| **Decal-sticker detail** | `oak` knot is a flat tan patch with a dark pentagon painted on it, not a cavity. `snag` hole is a light-grey pentagon laid on the surface. |
| **Degenerate slivers** | `snag-*` and `birch-*` have near-zero-width black lines shooting off the trunk — hairline quads, not branches. |
| **Shadow mush / missing shadow** | No shadow at all in `pine-high`, `snag-v2`, `oak-high`. Shadow detached from the trunk base in `snag-three-quarter`, `snag-v1`, `palm-high`. Torn, stair-stepped, aliased edges everywhere else. |
| **Gradient instead of tiers** | `pine` is a smooth light-top → dark-bottom ramp across the whole tree. `oak` values follow per-triangle NdotL noise, not mass structure. |
| Letterbox / bars | **Clear.** All 30 captures are full-bleed 1280×800. Round 1 regression fixed. |

## The stage (judged once, globally) — 3/10

The stage is currently subtracting from every species, and it caps the "stage presence" axis at 3
no matter what the geometry does.

- **Sky** is a cold grey → dead-cream vertical wash. It has no hue journey, no horizon glow, no
  warmth. Firewatch's whole trick is a saturated warm-to-cool sky doing half the color work for
  free; this sky does none. Replace with a 3-stop band (warm low horizon → mid tint → deeper zenith),
  and quantize it to discrete bands so it matches the flat-shaded language instead of fighting it.
- **Ground** is one uniform desaturated dark green plane, unlit and untextured, meeting the sky at a
  hard line with a visible sphere-rim bulge in the wide shots. It reads as a debug plane. Give it at
  least two value tiers (a lighter sunlit tier, a cooler shadow tier), and darken it toward the frame
  edges so the subject is not competing with an equal-value backdrop.
- **Shadow** is the worst offender: low-res shadow-map blobs with torn stair-step edges, frequently
  offset off the trunk base, and outright absent in three captures. Raise the shadow-map resolution
  and tighten the ortho frustum around the subject, and add an explicit dark contact ellipse under
  every trunk so the tree is welded to the ground even when the map fails.
- **Light direction is inconsistent between shots** — key comes from frame-right in `oak-front` and
  frame-left in `snag-three-quarter`. Lock one sun vector for the whole capture rig.
- **Framing**: birch, snag and palm occupy under 20% of frame height with acres of empty sky. Frame
  the subject to ~75% of frame height so silhouette is the thing being judged.

---

## Per-species fixes

### oak — 6 / 6 / 5 / 5 / 3 / 3

The strongest of the five and still not close. The massing idea is right; the execution reads as
boulders on a post.

- **Crown underside**: currently a flat horizontal plate — the tree reads as a hamburger bun. Break
  the underside into 3 staggered depths so lower clumps hang below the main mass and the silhouette
  bottom edge is jagged, not a straight chord.
- **Under-crown collar**: the dark box where crown meets trunk is a visible rectangular prism with
  square corners. Delete it. Let the lowest foliage clumps overlap the trunk directly and hide the
  join in shadow.
- **Silhouette edge**: crown boundary is made of long straight chords, so the clumps read as rock.
  Add a ring of small breakup clumps (~25% the radius of a dominant mass) *on the silhouette edge
  only* — that is the entire difference between "boulder" and "canopy".
- **Right lobe**: on the hero it tapers into a thin nub and on `oak-v2` it separates entirely. Either
  weld it to the main crown with an overlapping intermediate clump, or delete it. **`oak-v2`'s
  floating clump is a hard fail on its own** — clamp the variation seed so a clump can never be
  placed further from the trunk axis than its own radius plus the neighbouring mass's radius.
- **Value tiers**: greens are currently per-triangle noise. Assign each *clump* a tier index
  (0=sunlit top, 1=mid, 2=shadow side, 3=under-mass) and shade the whole clump on its tier, so the
  4 tiers follow mass structure. Kill the dark diamonds scattered mid-crown — those are inverted or
  double-shelled faces and they read as holes punched through the canopy.
- **Knot**: replace the painted tan patch + dark pentagon with actual inset geometry — push a
  5-sided ring 2–3 cm into the trunk with a dark interior face, and add a raised lip on the
  lower edge. It must catch its own shadow.
- **Broken bough**: currently a pencil — a thin cylinder with a flat cap. Thicken it to ~35% of
  trunk diameter at the base, taper it, and terminate it in 3–4 splintered spikes rather than a
  flat disc.
- **Base flare**: the raw cone at the ground is obvious. Replace with 4–5 asymmetric root buttresses
  that spread unevenly into the ground plane.
- **Variation**: `v1` is a *palette swap* (gold autumn), not a different individual — and the gold
  collapses every value to one tier. Two individuals in the same grove must differ in **height,
  lean, clump count and clump placement** at the same season. Move the autumn palette to an explicit
  season parameter and make the seed vary geometry only.

### birch — 3 / 3 / 2 / 2 / 3 / 3

Reads as a lamppost with satellite dishes bolted on. It misses the species brief on almost every
stated point.

- **Trunk color is grey, not chalk-white.** The only banding present is a solid black cuff at the
  ground — that reads as a rubber boot, and it is birch logic inverted. Make the trunk body a high,
  near-white value, then cut **4–6 short horizontal dark lenticel bands** at irregular heights up the
  *whole* trunk, each band 1/3 of the trunk diameter tall with ragged ends. Delete the black cuff.
- **Trunk protrudes bare above the crown.** Explicitly against spec ("trunk ends inside crown") and
  it is the single loudest programmer-art tell in the set — a naked grey pipe with a flat-cut top
  sticking out of the foliage in the hero, `v1`, `v2` and `high`. Terminate the trunk *below* the
  topmost sheet and taper it to a point.
- **Leaf sheets float.** Visible sky between the trunk and the left sheet in every view; they are
  attached only by hairline dark twigs that read as scratches. Overlap every sheet's inner edge into
  the trunk by at least half a sheet-thickness, and delete the hairline twigs entirely — at this
  scale a 1-pixel branch is a rendering artifact, not a branch.
- **Sheets are not sheets.** They are chunky lumps that share the oak's clump DNA, which is why
  birch and oak are not distinguishable by silhouette. Flatten each to ~15% of its own width, give
  it a ragged perimeter, and stagger 5–7 of them vertically with real sky-gaps between so the crown
  reads *airy*.
- **Foliage is ~90% near-black** — one value, no tier read at all. Light the sheet tops two tiers
  brighter than their undersides; the top-facing plane is the only surface that should be dark-green,
  everything above it should be the light tier.
- **`birch-v1` has two interpenetrating trunks** crossing in silhouette with no resolution. Either
  commit to a real multi-stem birch clump (stems splaying from a shared base, different heights) or
  hard-limit the seed to one stem.

### pine — 3 / 4 / 2 / 3 / 3 / 2

This is the textbook programmer-art Christmas tree: six unmodified cones on a stick.

- **The skirts are raw cones.** `pine-high` shows perfect regular n-gon bases. The brief asked for
  **lobed, jittered** skirts and none of it happened. Per skirt: jitter each rim vertex radially by
  ±20–30%, then pull every 2nd or 3rd rim vertex down and out to form 5–8 distinct lobes, so the
  silhouette edge is a scallop, not a straight diagonal.
- **Tip blades point every direction except down.** They currently read as flies or tears stuck to
  the surface, are near-black, and are *half-buried inside* the cone hulls (z-fighting). Move every
  blade to originate **at a skirt lobe tip**, not on the cone face, orient them to hang **below
  horizontal**, and give them the foliage tier color, not black. They should extend the silhouette
  outward at the lobe tips — that is their entire job.
- **Color is a mid-green ramp, not cold blue-greens, and not tiers.** Push the hue toward
  blue-green, then assign each skirt one flat tier and shade only the skirt *underside* to the next
  tier down. Right now the whole tree is a smooth light-top → dark-bottom gradient, which is
  explicitly the thing to avoid.
- **Trunk stub between the lowest skirt and the ground is pure black** — reads as a hole in the
  world. Give it a bark value in the same family as the oak trunk, two tiers above black.
- **`pine-v1` has a whole cone impaled on a bare stick, floating beside the tree.** Fatal. Something
  in the variation path is emitting an orphaned skirt with its own trunk segment — find it and
  delete it.
- **`pine-v2` "snowbound" is a per-mesh material swap**: two whole random cones painted white
  including their *downward-facing* undersides, the rest left green. It reads as a missing-texture
  bug. Snow must be an **up-facing repaint**: every skirt gets snow, applied only to faces whose
  normal points up, heaviest at the top of the tree, thinning downward, with the undersides staying
  the cold green tier.

### snag — 4 / 3 / 2 / 3 / 2 / 3

Reads as a coat rack. The stubs are the fatal problem and they are visible in every single capture.

- **The broken stubs are capsules — cylinder + icosphere cap.** The faceted ball on the end reads as
  a doorknob or a hat peg, and it is the exact opposite of a break. Delete the sphere caps. Make each
  stub **3–4× thicker** (brief said *thick*), taper it outward, and terminate it in a jagged
  splintered face — 3–5 spikes of unequal length pointing away from the trunk.
- **Hairline black blades** shoot off the trunk in the hero, `v1` and `v2` — degenerate near-zero-width
  quads. Delete them or give them real width.
- **Trunk is tan/beige, not bleached silver.** Cool the hue toward grey-silver and lift the value,
  then add a second, darker weathered tier in vertical streaks so the deadwood reads as split and
  sun-bleached rather than as a smooth wooden dowel.
- **Chocolate-brown band at the base** reads as a boot pulled on the trunk. Break the transition into
  an irregular ragged line and reduce the value gap between the two tiers.
- **Woodpecker hole**: currently a pale pentagon decal laid on the surface, and in `snag-closeup` its
  black wedge **extends past the trunk silhouette into open sky** — the geometry is clipping outside
  the mesh it belongs to. Rebuild it as an inset cavity with a dark interior and a lit lower lip,
  clamped inside the trunk surface.
- **Trunk surface is one flat value on a smooth taper.** Add 3–4 vertical bark splits — long narrow
  inset wedges running up the trunk — so the closeup has something to read.
- **Grounding**: shadow is detached to the left of the base in the hero and `v1`, is a torn scrap in
  `high`, and is **entirely absent in `v2`**. Also, small green shards clip through the trunk at the
  base in `v2`.
- **Variation**: `v1` and `v2` are the same tree with two stubs relocated. Vary trunk height ±40%,
  add lean, and vary the number of top splinters (3 vs 6) and the trunk's break height.

### palm — 2 / 3 / 2 / 2 / 2 / 3

Round 1 had no fronds. Round 2 has a dust-mop on a broom handle. This is the weakest species.

- **Proportion is the primary failure.** The crown is roughly 1/5 the tree's height sitting on a
  trunk that is ~5× too long for it. A palm's crown diameter should be roughly a third to a half of
  the trunk height. Either shorten the trunk by ~40% or triple the frond length. As shot, the
  silhouette is a stick with lint on top.
- **Fronds are flat zero-thickness ribbons** of uniform width, blunt-cut at the tip, dead straight,
  with no midrib and no leaflet edge. Rebuild each frond as a tapered strip that **arches**: rises
  from the crown, crests, then **sags well past horizontal** so tips point down toward the ground.
  Taper the width to a point and notch the trailing edge into leaflets so the silhouette is combed,
  not solid.
- **Frond shading is random per face** — one ribbon is bright green, its neighbour is black, in the
  same lighting. Assign each frond a tier by its own orientation (upper arc = light tier, sagging
  outer third = mid, underside = dark) so the crown reads as one lit mass.
- **Trunk has no ring bands at all** — the brief's defining palm cue is simply missing. Cut 8–12
  horizontal ring grooves up the trunk, tightening in spacing toward the crown, each catching a
  darker tier on its underside.
- **Trunk does not curve** in the hero or `v1` (only `v2` has any lean, and it is a straight-line
  tilt). Bend the trunk along a smooth arc that leans one way and recovers, so the crown is offset
  from the base.
- **Trunk is a raw tapered cylinder** with a visible vertical seam, plus a small dark decal quad
  floating proud of the surface at mid-height (`palm-closeup`). Remove the decal; weld the seam.
- **Coconuts are not readable** — the only candidate is a dark blob at the crown base that reads as
  a shadow or a hole. Model 4–6 distinct spheres clustered under the frond crown, lit two tiers above
  the crown shadow so they separate.
- **`palm-v2` (the coconut-heavy seed) points its dead brown fronds UP and outward as bare sticks.**
  Dead fronds hang **down**, collapsed against the trunk in a skirt below the live crown. Reverse
  them.
- **Grounding**: the shadow in `palm-high` is a straight black bar detached from the trunk base.

---

## What round 3 must fix before it is worth capturing again

1. **Zero floating parts.** Every clump, sheet, skirt and stub must overlap its parent by a real
   margin. `oak-v2`, `birch-v1/v2`, `pine-v1`, `snag-v1` fail this today — same failure mode as
   round 1.
2. **Zero recognizable primitives.** Cones must be lobed, capsules must lose their sphere caps,
   cylinders must be banded or buttressed. If a shape can be named ("cone", "capsule", "box"), it
   is not finished.
3. **Tiers assigned per mass, not per triangle**, and 4 of them per family — with the light tier
   actually used. Three species currently read as a single dark value.
4. **Details as geometry, not decals.** Knots and woodpecker holes must be inset cavities that cast
   their own shadow.
5. **Every capture grounded**: a contact shadow under every trunk in every shot, one locked sun
   vector, subject framed to ~75% of frame height.
6. **Variation = different individual, same species and season.** Vary height, lean, mass count and
   placement. A palette swap is not a variation.
