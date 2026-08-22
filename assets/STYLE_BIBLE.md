# ASSET LIBRARY STYLE BIBLE — v1 (TREES)

One page. Frozen. Every asset implementer embeds this verbatim. The library serves
every game in this monorepo (fps, rift, splat, kart, outpost) — it must sit inside
the established house look while reading as AAA on its own stage.

## Mood & benchmarks

Stylized, hand-authored low-poly nature — silhouette-first, value-ladder colored,
flat-shaded. The two named benchmarks every asset is blind-judged against:

1. **Zelda: Breath of the Wild** trees — species instantly identifiable by
   silhouette alone at gameplay distance; foliage massed into confident shapes,
   never fuzzy noise.
2. **Firewatch** value ladders — warm layered color depth built from 3–4 discrete
   value tiers per surface family, not textures.

"Decent for generated" is a FAIL. The bar: a screenshot of one tree on its stage
would not look out of place in either title's promotional art.

## Material model (ONE model, never mixed)

Flat-shaded **MeshLambertMaterial**, `vertexColors: true`, material color white —
ALL color lives in vertex attributes traced to the frozen `TREE_PALETTE`
(`library/src/kit/palette.ts`). No PBR, no env map, no image textures, no toon
ramp, no ad-hoc hex (mechanically enforced by `palette.test.ts`). The only
shader-level addition is the shared **wind vertex bend** (`kit/wind.ts`) —
uniform time, per-vertex `aBend` weight. Lighting on the stage: hemisphere
ambient + one shadow-casting directional sun, ACES tone mapping, sRGB output
(house renderer settings).

## Value tiers (the law this library inherits)

Every surface family carries up to four tiers — `…Lit` (sun-hit, top-facing
masses) / `base` / `…Dark` (shaded masses, under-canopy) / `…Deep` (trunk base,
knots, crevices — this library's AO). Foliage canopies MUST use at least three
tiers so they read as volume, not poster board. Trunks wear a `…Deep` contact
band at the root flare. Tier ladders are verified numerically
(`…Lit` ≥ base+8L*, `…Deep` ≤ base−8L*) in `valueTiers.test.ts`.

## Palette

ALL colors trace to `TREE_PALETTE` entries. Design intent: warm, slightly
desaturated natural tones that recede behind saturated game identity colors
(house law: world muted, actors pop). Five families: oak greens, birch
yellows-greens + paper-white bark, pine cold blues-greens, deadwood greys-browns,
palm saturated tropical greens. Accents (snow dust, moss, coconuts, knots,
autumn leaves) are named entries, never mixed ad hoc.

## Silhouette language

- Species identifiable **by silhouette alone** at 30 m gameplay distance.
- Chunky, faceted masses; nothing thin enough to alias or shimmer at distance.
- Foliage = confident blob masses (6–10 for heroes), never scattered point-noise.
- Trunks taper visibly; root flare at ground; natural lean ±4°.
- Every hero variation tells one story detail: hollow knot, broken bough,
  lenticel banding, snow-laden skirt, woodpecker hole, coconut cluster.

## Scale & population

Human scale reference: 1.8 u soldier. Trees arebig — oak 8–12 u, birch 10–14 u,
pine 12–16 u, snag 7–10 u, palm 9–13 u tall. Origin at ground center, +Y up,
canonical footprint ≤ 0.45 × height radius. In-game scatter uses these at
`quality: 'lod'|'micro'` further out.

## Motion (wind)

GPU vertex bend only (no per-frame CPU work): `aBend` weight 0 at trunk base →
1 at canopy tips; fronds and birch branchlets bend more than oak mass. Shared
uniforms `uWindTime / uWindStrength`; sway = two desynced sines, phase from
vertex world position so a forest never moves as one board. Trees must look
ALIVE at default strength 0.5 and survive a gale at 1.0 without inversion.

## Lightweight law

Procedural — zero texture bytes, zero downloads beyond code. Triangle budgets
(frozen in `kit/budgets.ts`, enforced by test): **hero ≤ 6,500 / lod ≤ 1,200 /
micro ≤ 260** per tree. Every asset merges to **one mesh, one material, one draw
call** (two where a species genuinely needs a second pass — none do today).

## Camera & stage (viewer / judging)

Neutral stage: muted ground disc with soft contact shadow, gradient sky dome
(biome-tinted per species), camera at 35° three-quarter default, hero asset
framed at 65% frame height. Judged at three angles (front, three-quarter, high)
plus one 2 m close-up.
