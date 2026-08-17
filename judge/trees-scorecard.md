# Trees v1 — Art Direction Scorecard

**Judged:** 35 captures in `judge/captures/trees/` (5 species × three-quarter / closeup / front / high / v0-v2)
**Bar:** BotW silhouette legibility + Firewatch warm tiered value depth. Stylized, hand-authored, flat-shaded, 3–4 discrete tiers.
**Result: 0 / 5 species pass.** Four of the five ship **floating or disconnected geometry** — that is a fatal smell before any aesthetic conversation starts.

---

## Scorecard

| Species | Silhouette | Color/Value | Geometry craft | Story detail | Stage presence | Variation | Verdict |
|---|---|---|---|---|---|---|---|
| **oak**   | 4 | 3 | 3 | 2 | 3 | 1 | **FAIL** |
| **birch** | 2 | 3 | 2 | 2 | 3 | 2 | **FAIL** |
| **pine**  | 6 | 5 | 3 | 2 | 2 | 2 | **FAIL** |
| **snag**  | 4 | 2 | 2 | 2 | 2 | 1 | **FAIL** |
| **palm**  | 1 | 2 | 1 | 1 | 2 | 2 | **FAIL** |

Passing requires every axis ≥ 7 and no fatal smell. Nothing is close. The single highest score in the entire matrix is a 6.

---

## Global smells (affect every capture, fix once)

1. **Letterbox bars — every single PNG.** Files are 1280×800; the render only fills ~1065×745. There is a hard black L-shaped border down the right edge and across the bottom of all 35 captures. Every asset shot in this library has a black bar in it. The WebGL canvas is not sized to the capture resolution. *Fix the harness before another judging round — I am grading through a framing bug.*
2. **The ground is a placeholder.** A single unlit dark-olive dome (~#2e3a1e), zero texture, zero value break, with a visibly curved horizon line in every shot. In `oak-high.png` it is so dark it swallows the cast shadow entirely and the tree floats. Nothing is grounded because there is nothing to be grounded on.
3. **Sky is one flat fill.** A single pale blue, no gradient, no horizon warmth. It gives the silhouettes nothing to sit against and kills any Firewatch read on contact.
4. **Ambient/fill is far too low — the ladder crushes.** Shadow faces bottom out near-black (oak's underside clumps measure roughly #0d1a06). You do not have a 3–4 tier ladder; you have *lit / mid / void*. Raise the hemi fill and re-measure the rendered PNG, not the palette constant.
5. **Zero warm color anywhere in the library.** Every hue is a cool green or a neutral brown. The Firewatch half of the benchmark has not been attempted — there is no warm bounce, no cool-shadow/warm-light split, no temperature shift between tiers.
6. **Shadow map resolution is far below the geometry frequency.** On `oak-closeup.png` it produces blurry PCF smears crawling across hard-edged facets (a soft blur on a flat-shaded asset is a style violation on its own). On pine it shatters into disconnected black triangle slivers that read as litter on the grass.
7. **Inconsistent shading model.** Canopies are flat-shaded; birch, snag and palm trunks are smooth/gouraud-shaded with continuous gradients. Half the library breaks the style bible's core rule.
8. **`v0` is byte-identical to `three-quarter` for all five species** (verified by md5). The "three seed variations" set is three renders presented as six files.

---

## OAK — FAIL

*Intent: heroic broadleaf, big readable clumps with sky-gaps, hollow knot + broken bough.*

**Fatal smells:** floating canopy (v2), raw unmodified icosphere (v2), rogue-material clump (v1).

- **v2 is catastrophic.** Three canopy masses hover in open sky with a clear air gap between them and the trunk. The trunk terminates in two bare stubs and one small ball. Nothing holds the foliage up.
- **v2 also exposes a raw primitive:** the little blob sitting on the trunk tip is an unjittered icosphere — clean icosahedral facets, perfect radius. Programmer art, undressed.
- **v1 has a rogue orange clump** — one saturated gold blob hanging off the upper-left, not touching the rest of the canopy. It reads as a pumpkin lodged in a tree, not as autumn. A per-clump hue randomiser fired on exactly one clump.
- **The hero (v0) has no sky-gaps at all.** The brief asks for big readable clumps with gaps; the canopy is one solid opaque mass. BotW's oak reads because light punches through it.
- **The clumps are noise, not masses.** `oak-high.png` shows it plainly: every clump is the same diameter with the same crumple frequency. There is no size hierarchy — no two or three dominant masses with small clumps breaking their edge. Uniform crumple reads as "crumpled paper ball," not foliage.
- **Trunk base bleeds a saturated color.** v0's lower trunk fades to orange/salmon; v1 and v2 fade to green. Same asset, different hue per seed — an unstable vertex-color blend, and in every case it reads as a texture seam, not a root flare or moss.
- **Trunk is a straight tapered prism** entering the ground on a hard flat cut. No lean, no root flare, no buttress. Nothing about it says "veteran."
- **Branches are untapered cylinders** stuck through the trunk at matching angles; in v1 three of them fan from one point at nearly identical pitch, and the middle one dead-ends in air.
- **Story detail is a 6-pixel black smudge.** The hollow knot does not read at hero distance, let alone gameplay distance. The broken bough is absent entirely.

**Fixes:**
1. Parent every canopy clump to a branch tip and assert non-empty attachment before emitting — v2 must be impossible to generate, not caught in review.
2. Delete the per-clump hue randomiser or make it apply to the whole crown as a seasonal variant; a single off-hue clump is always a bug read.
3. Introduce clump-scale hierarchy: 2–3 dominant masses at ~1.8× current radius, then 5–8 breakup clumps at ~0.5×. Punch 2–3 deliberate sky-gaps through the crown by removing clumps along the branch structure, not by shrinking them.
4. Replace uniform per-vertex noise with directional deformation — flatten each clump's underside, bulge the sun-facing top. The icosa read dies the moment the clump stops being radially symmetric.
5. Curve the trunk: 8–12° of S-lean over its height, plus a root flare widening to ~1.6× over the bottom 12%, with 3–4 skirt verts pushed out into the ground plane.
6. Kill the base color bleed. If you want moss, author it as a discrete flat-shaded tier on the bottom 20% of faces, not a gradient.
7. Scale the knot to ~4× and give it a rim: recess the hole and add 2–3 dark interior faces so it reads as depth. Add the broken bough as a real snapped stub with a splintered flat cap on the shadow side of the crown.

---

## BIRCH — FAIL

*Intent: slender paper-white trunk with dark lenticel bands, airy see-through canopy.*

**Fatal smells:** floating lenticel decals (v2), disconnected trunk segments (v2), trunk penetrating and emerging above the canopy (v0/closeup).

- **The trunk reads as a ruler.** A dead-straight 3–4-sided plank with no visible taper, a hard vertical facet seam down the middle, and tiny black tick marks along it. Paired with the tick marks, the object is a wooden measuring stick, not a tree. This is the single worst read in the library after palm.
- **Lenticels are not implemented.** The brief says dark horizontal *bands*. What exists is two or three sub-pixel specks on the entire trunk. In v2 they detach and float clear of the plank surface — the decals are unparented geometry.
- **v2's trunk is three disconnected planks** at three different angles with visible lateral offsets and steps at each joint. It reads as a snapped ski.
- **The trunk pokes through the top of the canopy.** In `birch-three-quarter.png` and `birch-closeup.png` a bare white pole emerges above the foliage. Composition error, visible at any distance.
- **Segment width discontinuity** at mid-trunk in the closeup — two trunk sections meet at different radii with a visible step.
- **The canopy is oak's canopy.** Identical clump kit, identical facet language, identical jitter, identical palette. The only thing separating birch from oak in this library is trunk color. "Airy see-through" has not been attempted — the mass is fully opaque with no gaps.
- **Canopy is far too small and too high**, occupying ~20% of tree height as a ball on a stick. Real birch crowns are tall, narrow and layered.
- **Trunk is smooth-shaded** — a continuous white-to-grey gradient with no discrete tiers, in a flat-shaded style bible.
- **The three branches are 1px hairlines** with no taper that exit the canopy into empty sky and stop. They read as render artifacts.

**Fixes:**
1. Parent the lenticels to the trunk mesh (or bake them as face colors) and weld the trunk into a single continuous segment chain — the v2 plank stack is the same disconnection bug as palm and snag.
2. Rebuild lenticels as **bands**: 6–9 horizontal dark stripes of 2–4 faces each, wrapping the trunk, irregular in spacing and length, thickening toward the base. They must read at 20m.
3. Terminate the trunk *inside* the canopy — clamp trunk height to the lowest clump's center.
4. Give birch its own canopy generator: replace the solid clump ball with 4–6 flattened, near-horizontal leaf sheets at staggered heights, each with 30–50% of its area removed. That gap structure IS the birch read.
5. Taper the trunk 1.0 → 0.55 over its height and add 4–6° of drift-lean. Bump the section count from 4 to 6–8 so the silhouette stops reading as a flat plank.
6. Flat-shade the trunk with 3 authored tiers: chalk white sunlit / warm grey mid / cool blue-grey shadow. The blue in the shadow tier is where the warmth contrast comes from.
7. Replace the hairline twigs with tapered branches at ≥3× current thickness, terminating inside a leaf sheet — never in open sky.

---

## PINE — FAIL

*Intent: 5–7 layered skirts with drooping tips, cold greens, snowbound variant.*

**Fatal smells:** raw unmodified cone as the skirt primitive, shattered shadow, 2D card foliage intersecting the cone body.

Best silhouette in the library, and still nowhere near the bar.

- **The skirt is a raw cone.** `pine-closeup.png` shows it undressed: a perfectly circular base rim, a dead-straight profile from apex to base, ~12 sides, zero jitter. Each tier is `cone + a ring of flat triangles`. This is the textbook primitive-showing failure.
- **The tips point UP.** The brief specifies drooping tips. Every one of the several hundred spikes points skyward. It reads as a Christmas-tree cutout, and it is the opposite of the requested silhouette.
- **The needles are 2D cards.** Zero thickness, visible as paper at the silhouette edge, and where they punch into the cone body they produce hard black wedge intersections.
- **Uniform spike distribution = noise.** Same size, same spacing, all the way around. There are no massed shapes, no clumping, no gaps. At gameplay distance this will alias into a shimmering fuzz — the exact opposite of "confident masses."
- **The shadow is shattered.** A scatter of disconnected black triangle slivers on the grass that reads as debris someone dropped, not as a tree's shadow. Worst grounding in the library.
- **Upper tiers are entirely unshaded.** The top two cones are a single flat mint tone across their whole surface — no facet variation, no light direction. Flat-shaded is not the same as unshaded.
- **The color is wrong for the species.** Desaturated sage-mint, not the cold blue-green the brief asks for. It reads eucalyptus.
- **The exposed trunk between tiers is a solid unlit maroon slab** with zero shading.
- **The snow variant (v2) fails as snow.** It is a scatter of small white pills distributed randomly *inside* the canopy volume — many visibly floating in the gaps between spikes. It reads as popcorn or bird droppings. Snow load reads two ways, and this does neither: white capping the *top* planes of each skirt, and the skirts *sagging* under weight. There is also no snow on the ground, which makes the tree read as diseased rather than snowbound.
- **v0 and v1 are effectively clones** — same height, same tier count, same silhouette, same shadow scatter. Only spike rotation differs.

**Fixes:**
1. Never ship the cone. Displace every base-rim vertex radially by ±18–25% and vertically by ±8% so the rim stops being a circle; collapse each skirt to 7–9 irregular lobes with deep notches between them. The lobe count and depth are the layered-skirt read.
2. **Invert the tips.** Rotate every needle card 25–40° *downward* from horizontal, increasing droop toward the lower tiers where load is greatest. This is the single highest-leverage change on this asset.
3. Give the cards thickness — a 2-plane cross or a thin wedge — so the silhouette edge stops reading as paper, and inset them so they no longer intersect the cone body.
4. Cluster the needles: 5–8 dense tufts per skirt with bare gaps between, instead of a uniform ring. Massed, not scattered.
5. Cool the palette: shift greens ~15° toward blue and drop saturation on the shadow tier only, so the value ladder gains temperature separation rather than just brightness.
6. Fix the shadow before anything else — either raise the shadow map resolution or, better, replace the per-needle shadow with a single authored blob under the canopy footprint. Slivers on the grass are read as a rendering bug by anyone who sees them.
7. Rebuild snow as surface geometry: extract the up-facing faces of each skirt, offset them 0.02 along the normal, and assign the white tier. Add a snow ring on the ground and lower the droop angle another 10° on the snow variant.
8. Drive real variation from seed: tier count 5→8, total height ±30%, per-tier radius falloff curve, and 3–8° of trunk lean. v0 and v1 must not be mistakable for each other.

---

## SNAG — FAIL

*Intent: dead jagged tree, expressive broken branches, woodpecker hole.*

**Fatal smells:** branch shards floating detached in open sky (v0 *and* v1), woodpecker-hole decal floating off the trunk (v1), disconnected trunk segments (v1), shadow detached from the base.

- **v0 has two branch shards floating in the sky** to the upper right, with a wide air gap to the trunk. Not "expressive broken branches" — orphaned meshes hovering in the air.
- **v1 is disassembled.** A forked shard floats above the trunk top; a black hexagonal chip floats beside the trunk (that is the woodpecker hole, rendered as unparented free-floating geometry); a second black chip floats lower down; and the upper trunk section leans ~10° while failing to meet the vertical stump beneath it, leaving a visible notch. This is the same unparented-decal + disconnected-segment bug family as birch v2 and palm.
- **The trunk is three stacked prisms with hard offset joints.** Abrupt width and angle discontinuities at each seam. It reads as a stack of chair legs.
- **The color is wrong for a dead tree.** Uniform fresh chocolate brown with a smooth gradient — no tiers, no weathering, no silvering. Deadwood is bleached grey-silver with dark cracks; this looks freshly felled and wet.
- **The trunk is smooth-shaded** — same style-bible violation as birch and palm.
- **The top is a clean angled cut with a flat cap.** For an asset whose entire identity is "jagged and broken," the break is a saw cut.
- **The branches are paper-thin 2D triangles.** They read as thorns, not boughs.
- **The woodpecker hole is a black diamond** — a rotated square with no depth and no rim. It reads as a mesh glitch even when it is correctly attached.
- **The shadow does not touch the trunk.** There is a visible gap between the shadow smear and the stump base in both v0 and v1. The tree is not grounded.

**Fixes:**
1. Weld the trunk into one continuous lofted mesh and parent every branch and hole to it. The floating-shard bug appears in 2 of 3 seeds — this is not an edge case, it is the default behavior.
2. Replace the flat top cap with a real break: 4–7 splinter spikes of varying length and angle around the rim, tallest on one side, so the top silhouette is jagged from every viewing angle. This is the asset's whole reason to exist.
3. Re-palette to deadwood: silver-grey sunlit tier, warm bone mid tier, near-black crack tier. Flat-shade it. Add 3–5 vertical dark crack faces running the trunk height.
4. Give the branches volume — 4–6 sided tapered stubs with splintered flat ends — and thicken them ~4×. Vary their angle: one drooping, one snapped back, one long survivor.
5. Rebuild the woodpecker hole as recessed geometry: an irregular 6–8 sided opening with 3 dark interior faces and a lighter chewed rim, scaled ~2.5× current, placed at consistent eye height.
6. Add trunk lean and a hollow: 12–18° of lean and one large scooped-out cavity on the shadow side turns a dead pole into a landmark.
7. Fix the shadow offset — it should start at the base contact point, not beside it.

---

## PALM — FAIL

*Intent: curved ringed trunk, arched sagging fronds, coconut cluster.*

**Fatal smells:** the frond system did not generate; the trunk is a stack of disconnected boxes with visible open end caps and sky gaps between them; no curve.

**This asset is broken, not weak.** It should not have been submitted for judging.

- **There are no fronds.** The entire crown is a green nub roughly 30 pixels across on a 500-pixel pole — smaller than the trunk's own diameter. Not one arched frond exists. The frond generator either failed or is scaled to roughly 1/20 of intent.
- **It is not identifiable as a palm.** It is not identifiable as a tree. It reads as a fence post, a totem pole, or a bamboo stake with moss on top.
- **The trunk is physically disassembled.** `palm-closeup.png` shows daylight through the joints: each segment's bottom cap floats clear of the segment below, with open end caps visible and lateral offsets at every seam. Six boxes stacked in the air.
- **Zero curve.** The brief asks for a curved trunk; this is dead vertical in all three seeds. The curve is the palm's entire silhouette identity — without it there is nothing left.
- **The "rings" are the segment seams**, i.e. the detail is a side-effect of the bug. Ring geometry has not been authored.
- **No coconut cluster.** The dark chunks at the crown are larger than the green mass and read as rot.
- **Per-segment shading is broken.** Segment 4 renders much darker than segments 3 and 5 despite facing the same direction. That is random material assignment, not lighting.
- **All three seeds are the same broken pole.** Nothing varies but the height.

**Fixes:**
1. Fix the frond system first — nothing else about this asset matters until fronds exist. Target 8–12 fronds, each a tapered spine with 12–20 leaflet cards angled 30–50° off the spine, arcing up from the crown and then sagging past horizontal at the tip. The frond mass must be **2.5–3× the trunk diameter** in spread.
2. Weld the trunk into one continuous lofted mesh. Six disconnected boxes with visible open caps is the most severe geometry failure in the library.
3. Curve it: 20–35° of cumulative lean accumulated over the top two-thirds, seed-varied in direction, with the crown overhanging the base. A straight palm is not a palm.
4. Author real rings: 10–15 shallow horizontal ridges as discrete flat-shaded darker bands, spacing widening toward the base, independent of the segment topology.
5. Add the coconut cluster — 4–7 small spheres nested where the fronds meet the trunk, partly occluded by frond bases so they read as tucked in rather than stuck on.
6. Flat-shade the trunk with 3 tiers (warm tan sunlit / mid ochre / cool brown shadow) and delete whatever is randomizing brightness per segment.
7. Drive variation from seed: lean direction and magnitude, frond count 7–13, one seed with 1–2 dead brown fronds hanging straight down. That dead frond is the story detail this asset currently lacks entirely.

---

## What I want to see before the next round

Do not resubmit until all four are true:

1. **No floating geometry anywhere.** Four of five species currently have detached meshes. Add a generation-time assert: every emitted mesh must share a vertex or a parent transform with the trunk chain.
2. **Trunks are single welded meshes**, flat-shaded, tapered, and curved. The stacked-disconnected-prism trunk is the same bug in birch, snag and palm.
3. **The harness is fixed** — full-bleed 1280×800 with no letterbox, a ground plane with authored value break, a sky gradient, and a shadow that is not blurry mush or triangle confetti. I cannot grade stage presence through a broken stage.
4. **Palm regenerates with fronds**, and pine's tips point down.

Only pine is within reach of the bar with focused work. Palm needs to be rebuilt from zero.
