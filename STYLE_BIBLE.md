# STYLE BIBLE — STRICKEN

## Mood & references
Tactical, readable, low-poly military shooter with warm stylized lighting — competitive clarity
first, charm second. Touchstones: CS 1.6 blockout readability, Krunker minimalism, Bad North
silhouettes. Enemies must pop from the environment: team colors (CT blue / T amber) against
muted desaturated world materials.

## Material model (ONE model, never mixed)
Flat-shaded **MeshLambertMaterial** everywhere via the frozen `mat()` factory. No PBR, no env map,
no textures (nameplate canvas sprites + sky vertex-gradient dome excepted). Renderer:
ACESFilmicToneMapping, sRGB output, antialias on, PCFSoft shadow maps, pixelRatio ≤ 2.

## Palette
ALL colors come from the frozen `PALETTE` in `shared/src/palette.ts` — 41 named entries.
World materials are muted (sand/concrete/brick/snow); team identity is saturated
(ctBlue #3d5a9b / tAmber #c8912f); fx colors pop (muzzle/tracer). Ad-hoc hex = contract violation.
MAT_COLORS mapping (mapRenderer): sand→sand, sandDark→sandDark, concrete→concrete,
concreteDark→concreteDark, metal→steel, metalDark→metalDark, wood→wood, crate→crate,
brick→brick, plaster→plaster, roofRed→roofRed, carpet→carpet, desk→deskTop, paper→paper,
snow→snow, ice→ice, rock→rockDark, leaf→leaf, cactus→cactus.

## Lighting recipe (per map theme, from map data)
Hemisphere ambient (sky/ground tint, intensity theme.hemiIntensity) + one directional sun
(theme.sunColor/Intensity/dir, castShadow, 2048 map, frustum fitted to map bounds) + FogExp2
(theme.fog matched to sky/horizon — always). Sky = vertex-gradient dome (sky→horizon). Outdoor
maps: bright sun, soft long shadows. Indoor maps (office/bunker): dimmer sun + stronger hemisphere,
denser fog — reads as interior gloom without darkness crushing visibility (min ambient floor:
players always clearly lit).

## Camera & framing
First person, eye ~1.62u, BASE_FOV 75°, sniper scope 25°. Viewmodel bottom-right, compact, never
occludes center. Screen shake small and rare (damage taken, nearby explosions none — only own
fire kick + damage). No camera roll while strafing (keep it clean-competitive).

## Silhouette language
Chunky low-poly, 1.8u soldiers, weapons oversized ~15% for readability, cover crates at exactly
1.2u (head-glitch height), doorways/corridors ≥ 1.4u wide, nothing thin enough to alias at distance.
Every weapon reads as itself in silhouette alone (long thin sniper, curved-mag rifle, tube shotgun,
stubby smg, compact pistol, blade knife).

## World population
Maps are tactical arenas, not empty planes: every map carries its deco scatter (crates, barrels,
rocks, shrubs, pipes, pallets, plants, paper stacks per theme) in organic clusters that never block
lanes (non-collidable, minSpacing respected). Corners and dead zones get the most dressing.
