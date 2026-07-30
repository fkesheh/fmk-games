# STYLE BIBLE — STRICKEN

## Mood & references
Tactical, readable, low-poly military shooter with warm stylized lighting — competitive clarity
first, charm second. Touchstones: CS 1.6 blockout readability, Krunker minimalism, Bad North
silhouettes. Enemies must pop from the environment: team colors (CT blue / T amber) against
muted desaturated world materials.

## Material model (ONE model, never mixed)
Flat-shaded **MeshLambertMaterial** for every world surface, via the frozen `mat()` factory. No PBR,
no env map, no textures on world geometry. The only non-Lambert surfaces are the ones that already
exist: the sky domes (the map renderer's vertex-gradient dome and the rig's shader dome), the
sun-disc and vignette-grade shader quads in `scene.ts`, the procedural canvas sprites (nameplates,
light-pool blob) and particle `Points` materials.
VISUAL_UPGRADE.md §0 freezes exactly that list — they may be **tuned**, but no NEW vertex-coloured
material, canvas texture or post-processing pass may be added. "No textures" means the world
geometry stays untextured; it was never a ban on those pre-existing surfaces. Renderer:
ACESFilmicToneMapping, sRGB output, antialias on, PCFSoft shadow maps, pixelRatio ≤ 2.

## Palette
ALL colors come from the frozen `PALETTE` in `games/fps/shared/src/palette.ts`.
World materials are muted (sand/concrete/brick/snow); team identity is saturated
(ctBlue #3d5a9b / tAmber #c8912f); fx colors pop (muzzle/tracer). Ad-hoc hex = contract violation.
The `MatId` → PALETTE mapping is never restated here — it lives in
`games/fps/shared/src/matColors.ts`, alongside the partner tables keyed by the same `MatId`:
`CONTACT_MAT` (the plinth / contact-band partner, a step down), `TRIM_MAT` (the cornice / trim
partner, a step up), `DARK_MAT` (the alternating pilaster tier, a shallower step down) and
`IMPACT_MAT` (the impact-particle family a material spawns when shot).

### Value tiers
Every surface family carries up to four value tiers — `…Lit` (trim, cornices, sun-hit detail) /
base (main wall or body surface) / `…Dark` (secondary and shaded planes) / `…Deep` (contact band,
plinths, crevices). How those tiers may be combined is governed by the VALUE LADDER LAW in
VISUAL_UPGRADE.md §1, enforced numerically by `games/fps/shared/src/valueLadder.test.ts`.

## Lighting recipe (per map theme, from map data)
Hemisphere ambient (sky/ground tint, intensity theme.hemiIntensity) + one directional sun
(theme.sunColor/Intensity/dir, castShadow, 2048 map, frustum fitted to map bounds) + FogExp2
(theme.fog matched to sky/horizon — always). Sky = gradient dome; `MapTheme` carries three stops
(`skyHigh` zenith → `sky` → `horizon`), governed by VISUAL_UPGRADE.md §1 S1/S2. Outdoor
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
