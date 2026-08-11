# SKI SPLAT — STYLE BIBLE (frozen art direction)

**Benchmark title: _Lonely Mountains: Downhill_** (Megagon Industries) — low-poly,
clean, readable at speed, beautiful through light and palette rather than
texture detail. Phase-4 blind comparisons pair our captures against its shots:
slope vista, descent at speed, vegetation close-up, finish area. Our framing is
first-person, but the ART must stand next to it.

## Mood + references

A bright winter morning on a friendly mountain. Cold air, warm sun, long soft
shadows, glittering snow. Cheerful, not extreme-sport. Think: the calm of an
empty blue run at 9am, kettle waiting at the lodge.

## Material model — ONE, enforced

**Flat-shaded low-poly, Lambert everywhere.** No PBR, no textures on geometry
(the only canvas textures allowed: sky dome gradient, snow sparkle noise,
HUD glyphs). Meshes come only from the frozen visual vocabulary
(`box/cyl/cone/sphere/at` factories + `bake()` geometry merge, cloned from the
kart pattern). All colors trace to `SPAL` in
`games/splat/shared/src/palette.ts` — ad-hoc hex in implementer code is a
contract violation.

## Palette (all names from SPAL)

- **Snow** is the canvas: `snowLit` (sun-facing), `snow` (base), `snowShade`
  (cool blue-violet shadow side — shadows on snow are BLUE, never grey).
- **Sky:** `skyZenith` deep azure → `skyHorizon` pale ice; `FogExp2` matched to
  `skyHorizon` so the world dissolves into the sky, never into grey.
- **Plants** (the antagonists, must read at 60 km/h): `pineLit/pine/pineDark`
  for conifer saplings; `shrubLit/shrub/shrubDark` for bushes; `thornLit/thorn`
  for thickets (warmer, more orange-brown — the "danger" read). Foliage is the
  ONLY saturated green on the mountain: plants pop against snow by hue AND by
  value (CIE L* at least 25 below `snow`).
- **Rock/bark:** `bark`, `rockLit/rock`, used on trunks, boulders, lodge.
- **Sun/gold:** `sunGold` — finish gate, UI accent, winner crown.
- **8 player colours** (`SKIER_COLORS`): mutually distinguishable at a glance
  AND under protanopia/deuteranopia simulation (test-enforced), each clearing
  snow by a wide value margin. Identity = colour + animal glyph.

## Lighting recipe

One directional sun (warm white, low morning angle, PCFSoft shadows, shadow
camera follows the player), one hemispheric fill (sky azure up / snow-bounce
below). ACESFilmic tone mapping, sRGB output. Real-time shadows ON — long
tree shadows across the piste are half the look. A subtle cool vignette +
warm highlight grade post pass (the kart render.ts pattern).

## Camera language

First person, eye ~1.55 m. FOV 65 → +15 with speed (capped). Carve roll banks
the world up to ~4° into turns. Micro-shake scales with speed; plant hits fire
a dip-spring + white-blue vignette flash. The horizon stays near the vertical
third-line; the fall line pulls the eye downhill. Never cut to third person.

## Silhouette language (model sheets)

- **Skier (others):** ~30–50 primitives. Two skis, boots, articulated legs,
  torso, arms with poles, head with helmet in the player colour + animal glyph
  on the chest. Readable at 30 m: the COLOUR block and the crouch.
- **Own skis:** two skis + boot toe-pieces visible at frame bottom, angling
  with carves — body presence without a body.
- **Pine sapling:** 3–4 stacked cones on a stub trunk, snow-dusted tips
  (`snowLit` cap cones). 1.2–2 m tall.
- **Powder bush:** 2–3 squashed icospheres of foliage, half-buried, snow cap.
- **Thorn thicket:** bare angular branch cylinders radiating low, warm `thorn`
  hue — reads "nasty" at a glance; the one plant an adult respects.
- **Start gate / finish gate:** two banner poles + a pennant string; finish
  gets `sunGold` flags and a lodge with chimney smoke beyond the line.
- **Slalom gate (flag checkpoint):** two slim flexible poles (~1.8 m) with
  small triangular pennants, alternating azure/ember by gate index (ski
  slalom language). The opening must read as a doorway at 30 m against snow;
  a passed gate gets a celebratory wobble, never a penalty state.
- **Mountain dressing:** ridge-line rock outcrops (`rockLit/rock`), sparse
  mature pines OUTSIDE the piste edges, distant peak cards in `skyHorizon`
  haze. The piste itself is a readable corridor of clean snow bordered by
  forest — the player should never wonder where the run goes.

## World population targets

In-piste gameplay plants are sparse and READABLE — ~1 per 250–300 m²
(≈150 over the run, clustered organically via seed-clustered Poisson, never a
uniform grid): every plant is a decision, not wallpaper. The DENSE look comes
from the dressing: mature-pine forest walls both sides of the piste (up to
~3k visual instances total), ridge outcrops, distant peaks. Snow sparkle:
subtle additive Points glints near the camera. Snow spray particles on hard
carves; powder puffs on plant hits; confetti pennants at the finish.

## Atmosphere

`FogExp2` density tuned so the finish fades in at ~150 m. Morning haze band at
the horizon. Day is fixed (no day/night cycle in v1) — the mood IS the morning.

## The bar

A screenshot at race speed must read: white-blue snow world, warm sun, GREEN
plants as obvious verbs, forest walls as rails, gold finish as the goal.
Generic grey plane + green cones = failed round.
