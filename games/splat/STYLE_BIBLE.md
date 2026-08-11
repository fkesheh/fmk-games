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

---

# §V2 — JUMPS + THE FULL GRAPHICS OVERHAUL (frozen art direction)

Same mood, same mountain, MORE mountain. The benchmark stays _Lonely
Mountains: Downhill_ — the bar for every v2 shot is "which of these two looks
like the finished, art-directed game?" V2 adds jump ramps to the run and
raises the density/detail of every workstream. All colours still trace to
SPAL; meshes only from `contract/visual.ts`; shadows ON; draw calls < 80.

## V2.1 Kicker ramps (new structure, the v2 hero asset)

A sculpted SNOW ramp, not a scaffold: a tapered snow wedge (~2.4 m long, ~1.6 m
wide, 0.85 m tall) with a clean takeoff lip — `snowLit` sun face, `snowShade`
shadow side, `snowDeep` contact crease where it meets the piste, and a thin
`bark` lip on the takeoff edge (the one warm note — the "ride me" read). Baked
wind-crest detail: a small snowLit spray fan swept downwind off the lip (3–5
tiny cones), so the ramp reads "AIR!" at 30 m as a wedge + spray signature
against the clean corridor. Ramps sit ON the piste (not buried): the base
height = terrain height, wedged smoothly so the run-in reads as a natural
roll. They must read as a friendly invitation, never a hazard — a 4-year-old
sees a bump, not a cliff.

## V2.2 Terrain — groomed piste, powder, banks, richer rocks

- **Groomed piste:** the centre run reads as corduroy — a subtle lighter
  `snow` band down the fall line with faint parallel ridge lines in the vertex
  colours (2–3 m spacing, ±1% value, deterministic from the seed). Off-piste
  stays deeper `snowShade`/`snowDeep` powder. The corridor and the powder must
  read as DIFFERENT snow at 60 km/h.
- **Snow banks:** seeded rounded mounds (visual only, never inside the
  corridor or the plant clearances — they are dressing, not colliders) tucked
  against the piste edges: squashed `snowLit`-capped `snowShade` half-spheres
  with a wind-scallop overhang, clustered like the plants.
- **Rocks:** boulder clusters get angular fracture — 2–3 interlocking
  squashed spheres/boxes in `rockLit`/`rock` with `snowLit` snow skirts on the
  uphill face and a tiny `snowShade` shadow crease. A few single small debris
  rocks (0.3–0.6 m) near the piste edge for foreground scale.
- **Depth:** a NEARER foothill layer between the distant peak cards and the
  piste — hazed to ~50% toward `skyHorizon` (not the full pre-haze of the
  peaks), so the world reads in three depth planes instead of two.

## V2.3 Plants — model-sheet upgrade (silhouette + snow detail)

- **Pine:** leaner and taller; 4–5 tiers with the LOWEST tier drooping
  (rotated ~0.25 rad outward — the weight-of-snow read); snow dust DEEPENS
  (a second nested cap per tier, not just a cone); per-instance lean (small
  rot.z jitter) so no two pines stand bolt-upright.
- **Bush:** 4–5 foliage blobs (was 3), layered snow caps, 2–3 exposed twig
  tips poking through the snow on the shadow side.
- **Thorn:** 9–11 branches (was 7) with kinked twigs; snow caught in the
  branch crotches (tiny snowLit spheres where branches fork); the warm
  `thorn` hue unchanged — it is the danger read.
- All kinds keep their GREEN pop against snow (the value-ladder test is
  frozen). Hits still squash/shake; nothing is consumed.

## V2.4 Skiers — detail + the AIR POSE

- **Body pass (remotes):** torso gains a shoulder-panel taper (two small
  colour boxes over the ink block); backpack in `ink` with a slot-colour
  strap across the chest; helmet gains a `paper` visor band + `ink` strap;
  arms get elbow joints (two cylinders, not one); poles keep baskets.
  The 30 m read is STILL the colour block + the crouch — detail must not
  muddy the silhouette.
- **AIR POSE (new, the v2 silhouette):** while airborne the body extends —
  legs straighten, torso uprights, arms raise/back, skis pull together and
  lift slightly; a shallow forward pitch holds; on landing the body absorbs
  (crouch deeper for ~0.3 s, then eases back). The transition is eased, and
  the AIR POSE must be readable as "flying" at 30 m (the flat skis + upright
  body vs the carve crouch).
- **Own skis:** top-sheet stripe (`paper`) + sidewall (`ink`) + visible
  binding; in air the skis tuck up and level (tips rise, spread narrows);
  on landing the rig dips once (the land spring), then rides again.

## V2.5 Scene — sky, sun, and air feel

- **Clouds:** 6–10 low-poly flat-shaded cloud puffs (2–4 squashed spheres
  each) parked in a ring ~450–520 m out, `fog:false`, tinted
  `skyHorizon`→`paper` with `snowShade` undersides — they must sit IN the
  haze, not pop. Static (no per-frame motion; the run is 40 s, drift would
  cost the draw-call budget).
- **Sun disc:** a small warm `sunWarm` disc at the SUN_DIR azimuth, low in
  the sky, ringed by the existing glow blob — the light reads directional
  from a real source.
- **Air feel:** on launch the camera holds level (pitch bias eases to ~-2°),
  FOV punches +~4° and eases back; micro-shake cuts in the air; on landing
  the dip spring fires (the existing mechanism, `land()` retriggers it) and
  the warm grade blinks slightly. All deterministic from the sim stream.

## V2.6 Gates/finish/lodge — festive finish, cosier lodge

- **Finish:** a second pennant row (sunGold + the 8 skier colours alternating)
  slung BELOW the existing banner; a short flag line of small sunGold
  pennants along the runout edges (both sides, ~6 each) guiding the eye
  through the sprint; the banner panel gets a `paper` fringed edge.
- **Lodge:** second chimney; porch posts + a small porch roof; a ski rack
  with 2–3 pairs of skis (SKIER_COLORS tops); a sunGold sun sign above the
  door; a soft warm light spill quad on the snow in front of the windows;
  deeper roof snow; a barrel + more firewood. Still one bake pass.

## V2.7 FX — land, launch, air

- **`land`:** a powder ring + upward billow at the touchdown point — the
  biggest burst in the game (~24 particles, snowLit→snowShade, gravity light,
  ring velocity), so landings FEEL weighty from any distance.
- **`launch`:** a fast spray kick + small puff at the takeoff lip (14
  particles, quick, directional downwind) so other racers SEE the pop.
- Pools rebalanced to ≤ 512 live total (§8); nothing allocates per frame.

## V2.8 HUD — the JUMP button

- A round JUMP chip (bottom-right, above the touch zones): sunGold ring,
  `ink` arrow-up glyph on `paper`, 64 px min touch target. Press → ONE hop
  edge (no repeat on hold). Keyboard Space/↑ do the same.
- First-run hint grows one line: "SPACE / JUMP button = hop — ramps send you
  flying!" (the same once-per-localStorage timing).
- The chip must not fight the steering zones (a thumb on JUMP is a thumb not
  steering — acceptable for a dodge; the zones are big).

## V2.9 The v2 bar

A v2 screenshot at race speed must read: groomed corridor with kicker wedges
popping off it, plants as obvious green verbs, a remote skier who reads as
FLYING (air pose) mid-arc, clouds + sun disc holding the sky, and a festive
gold finish. Programmer-art smells (flat grey, z-fighting, no ground contact,
ad-hoc hex) are failed rounds.
