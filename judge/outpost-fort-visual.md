# OUTPOST — FORT VISUAL REVIEW (art director)

**Date:** 2026-08-12 · **Branch:** splat-v3-air-lock-and-visuals
**Reviewed:** `screenshots/outpost/fort-roof-out.png`, `fort-core.png`, `fort-ramp.png`,
`fort-parapet.png`, `wave1-dusk.png` (all 23:09–23:10, post-redesign) against
`screenshots/aaa-fps-maps-1.png`, `aaa-fps-light-1.png`, `aaa-fps-maps-2.png`,
`aaa-fps-chars-1.png` (STRICKEN).
**Method:** pixel histograms of every frame (HUD masked), plus a live headless probe
against the built client to establish where the camera actually is.

---

## 0. The finding that invalidates the other four screenshots

**The player cannot stand on the roof, or on floor 2, or anywhere except y = 0.**
They spawn on the roof and fall through both slabs to the ground floor within ~1.5 s.

Live probe, built client, wave 1:

```
SPAWN pos = [-6, 5.465, -6]        (ROOF_H = 7.0 — already falling at t≈0.4s)
A-roof-out-north  pos=[-6.00, 0.00, -7.30]
B-roof-out-flat   pos=[-6.00, 0.00, -7.30]
C-roof-back-core  pos=[-6.00, 0.00, -7.30]
D-roof-down-45    pos=[-6.00, 0.00, -7.30]
E-roof-up         pos=[-6.00, 0.00, -7.30]
F-core-close      pos=[-6.00, 0.00,  4.40]
G-core-wide       pos=[-6.00, 0.00,  4.40]
```

y is pinned to **0.00** for the entire session. Mechanism, proven by reading the code:

`games/outpost/shared/src/map.ts:246` —
```ts
function band(y: number): LevelBand {
  return y < GROUND_H ? 'ground' : y < ROOF_H ? 'floor2' : 'roof';
}
```
`stepPlayer` (`physics.ts:155-161`) applies gravity **before** the ground query. A player
resting exactly on the roof at y = 7.0 is nudged to y = 6.999; `band(6.999)` is now
`'floor2'`, and `groundHeight` for floor2 returns `GROUND_H` (3.5). They fall. They land
at 3.5, get nudged to 3.499, `band` says `'ground'`, `groundHeight` returns 0. They fall
again. Every floor in the fort is a trapdoor. The bands are computed with a strict `<` on
the *post-gravity* feet height, so standing on a surface always classifies you into the
band **below** it.

Consequences that explain every screenshot in the set:

- `fort-roof-out.png` and `wave1-dusk.png` are not roof shots. They are the camera at
  y = 0 pressed against the inside face of a ground-floor wall, ~1 m away. That is the
  entire "big warm gradient" filling the frame. My probe reproduced it exactly
  (`B-roof-out-flat`: a flat brown wall, 0 % of the frame below luma 32, no sky, no
  horizon, no horde).
- `fort-parapet.png` contains no parapet. It is the ground floor.
- `fort-core.png` contains no core. The core sits at `core.y = ROOF_H = 7.0`, behind two
  solid slabs. **The object the entire game mode is built to defend — with a CORE 100 %
  bar pinned to the HUD all game — is never visible to a player, in any frame, ever.**
- Only `fort-ramp.png` shows what it claims, and only because ramps *are* walkable
  (inside band `'ground'`, `groundHeight` returns `rampHeight`).

Ramps up, floors gone. Until this is fixed, no screenshot of this map is evidence of
anything, and no art judgement about the roof, the parapet or the core is possible.

---

## 1. Is the fort rendering as a 3-level structure?

**The geometry is built. Almost none of it is reachable or visible.**

What is genuinely there and correct in `render/outpost.ts`: floor slabs at `GROUND_H` and
`ROOF_H` with the ramp shafts boolean-subtracted (`makeFloorSlab` + `slabRects`), solid
inclined ramp planes with a correctly-derived up-normal (`makeRamp`), floor-2 perimeter
walls, the parapet with its own `tag === 'parapet'` branch, the core assembly lifted onto
`core.y`. The decomposition is sound. Draw calls are 88–121 — a third of the 220 budget.
Zero console errors. This is not a modelling failure.

Broken / buried / missing, in order of severity:

**(a) The ceiling is painted with a contact band, and it z-fights.** `outpost.ts:353-354`:

```ts
out.push(place(makeBox(w, SLAB_T, d, 'concrete'),               cx, levelY - SLAB_T, cz));
out.push(place(makeBox(w + 0.1, 0.12, d + 0.1, 'concreteDeep'), cx, levelY - SLAB_T, cz));
```

Two boxes, **same origin**, and `place` sets the *feet* height (the origin convention at
`outpost.ts:126`). So both bottom faces sit at exactly `levelY − 0.5`, coplanar, with the
dark one 10 cm larger in x and z. Two things follow:

1. What you see when you look up is not `concrete` — it is `concreteDeep` (#23272d), the
   crevice swatch, hanging 5 cm proud on every edge. Measured across the ceiling region of
   `G-core-wide`: mean **#141417, luma 20.9**. Large flat areas of it read **#0d0a0c,
   luma 10.8**, and that identical value recurs across `fort-ramp`, `fort-parapet` and
   `fort-roof-out`. It is a black lid over the whole ground floor.
2. Coplanar bottom faces ⇒ **visible z-fighting**. The striped moiré across the top of
   `fort-ramp.png` (x≈1200–1800, y≈100–140) and the top-centre of my `G-core-wide`
   (x≈600–1100, y≈90–190) is depth fighting, not dither. Measured: stddev-luma **36.2** in
   that band versus **17.6** for clean ceiling. It shimmers when the camera moves. This
   alone is a ship-blocker.

A `…Deep` band is a *floor-line* device — the dark seam where a vertical surface meets the
ground. Wrapping it around the underside of a ceiling is a misreading of the style bible
and it costs you a third of every interior frame.

**(b) Point lights leak through the floor slabs.** `coreLight` (`scene.ts:356`, intensity
20, range 24, decay 2) sits at y ≈ 9.55 on the roof. Point lights don't cast shadows here
(deliberately — `scene.ts:370`, cube-map budget), so its light passes straight through the
roof slab *and* the floor-2 slab and washes the ground floor warm. That is why cool
`concrete` (#4c525a, a blue-grey) renders as tan-brown #7a5c50 in `fort-roof-out` and
`wave1-dusk`. You have a black ceiling and a hot orange floor lit by a beacon two storeys
above it, through 1 m of concrete.

**(c) Near-field blowout.** `fort-core.png` samples **#dcc5bd, luma 201** on geometry a
metre from the camera; `fort-parapet.png` **#dbc3bc, luma 200**. With decay 2 and base
intensity 20 (core) / 14 (lanterns at dusk), anything within ~2 m of a light source is
driven off the top of the ACES curve. Combined with (a) you have a frame that is
simultaneously crushed and clipped, with almost nothing in the readable middle.

**(d) The parapet, the roof deck and the core have never been photographed.** Not because
they aren't modelled — because of §0.

---

## 2. Is the scene still too dark?

**Outdoors: fixed. Interiors: worse than before, and for a different reason.**

The hemisphere raise did land where it was aimed. Looking *out* from the wall the frame is
healthy:

| Frame | mean luma | < 16 | < 32 |
|---|---|---|---|
| probe `E-roof-up` (sky) | 108.7 | 0.0 % | 0.1 % |
| probe `B-roof-out-flat` | 97.1 | 0.0 % | 0.1 % |
| probe `A-roof-out-north` | 94.9 | 0.0 % | 0.1 % |
| STRICKEN `aaa-fps-light-1` | 108.2 | 2.6 % | 4.9 % |
| STRICKEN `aaa-fps-maps-1` | 108.1 | 1.7 % | 3.1 % |

That is parity with STRICKEN. Credit where due.

Now the interiors — which is where this map now spends its whole first act:

| Frame | mean luma | **< 16 (near-black)** | < 32 | < 64 |
|---|---|---|---|---|
| `fort-parapet.png` | 46.7 | **38.1 %** | 43.4 % | 79.3 % |
| `fort-ramp.png` | 42.8 | **35.4 %** | 45.4 % | 84.5 % |
| probe `G-core-wide` | 44.8 | **35.7 %** | 44.8 % | — |
| probe `F-core-close` | 53.0 | **29.2 %** | 32.2 % | — |
| probe `C-roof-back-core` | 53.6 | **22.3 %** | 47.3 % | — |
| STRICKEN `aaa-fps-maps-2` (its darkest) | 79.2 | **2.0 %** | 3.9 % | 47.4 % |

**Answer: roughly 35–38 % of an interior frame is near-black, against STRICKEN's 2 %.
That is 18× worse than the benchmark.** Not "moody" — dead. And the mud floor you walk on
measures **luma 15.9**: you cannot see the ground under your feet.

This is not the same bug as last round. The hemisphere fill is real now
(`fillColour()` correctly normalises the swatch to luminance 1). Two things eat it:

1. **The `concreteDeep` ceiling of §1(a).** You lifted the fill and then painted the
   largest surface in the frame with the darkest swatch in the palette.
2. **`HEMI_FILL_NIGHT = 1.2` is still too low for an interior.** three's Lambert divides
   irradiance by π, so an intensity of 1.2 delivers an effective **0.38×** albedo
   multiplier to an unlit-by-key face. Every enclosed surface in the fort is such a face —
   the fort roof blocks the key light from the entire ground floor. Outdoors the sky dome
   and the key carry the frame and the shortfall never shows; indoors the hemi *is* the
   whole light budget, and 0.38 × concrete lands at luma ~55 at best, ~27 for
   `concreteDeep`. Measured is lower still.

---

## 3. Do zombies read at distance, as a threat?

**No. The horde is effectively invisible.**

Saturated-green pixels (hue 55–105°, sat > 0.25) as a fraction of frame:

| Frame | zombies alive | green |
|---|---|---|
| `fort-roof-out.png` | 4 | 0.014 % |
| `fort-core.png` | 6 | 0.014 % |
| `fort-ramp.png` | 8 | **0.024 %** |
| `fort-parapet.png` | 8 | 0.014 % |
| probe `B-roof-out-flat` | 4 | 0.015 % |
| probe `G-core-wide` | 8 | 0.084 % |
| STRICKEN `aaa-fps-chars-1` | — | 1.269 % |
| STRICKEN `aaa-fps-light-1` (no enemies) | 0 | 0.235 % |

Read that last row: **a STRICKEN frame with no enemies in it has 2–16× more green than an
OUTPOST frame with eight zombies alive.** Your 0.014 % floor is scene noise, not zombies.

The one time the horde does appear — `G-core-wide`, a single shambler behind the east
barricade at ~8 m — the material itself is fine: mean **#7da45d**, saturation 0.69, and it
pops cleanly off the lavender wall behind it. **The zombie art is not the problem.** The
problem is that 7 of 8 are never in frame, and the two mechanisms are:

- Occlusion. Zombies path along the ground floor; the black ceiling and the fort shell
  swallow them. From the roof (once reachable) the parapet plus the roof slab will hide
  everything at the wall base — check `D-roof-down-45`.
- Fog. `fog.far` is 62 at dusk and `fog.near` is 8. A zombie on the r=30 spawn ring is
  ~41 % lerped to `fogDusk` (#2c2538, a cool violet) before it is ever drawn — which
  desaturates the one saturated family in the game straight into the background. The
  style bible's promise, "Zombies carry a faint `zeye` emissive so the horde reads in the
  dark," is not surviving the fog blend.

Threat read: **zero.** There is no frame in this set where a player would feel hunted.

---

## 4. Core, ramps, buy stations, parapet — do they read?

- **Core** — cannot be evaluated. Never visible (§0). Its *light* is visible, through two
  concrete floors, which is worse than not seeing it.
- **Parapet** — cannot be evaluated. Never reachable.
- **Ramps** — the strongest structural read in the set, and the only feature that survives
  the fall-through. In `fort-ramp` / `fort-parapet` they read unambiguously as a climbable
  incline: stepped orange slabs, clear rise. Two problems. They are `'concrete'` in code
  (`makeRamp`, `outpost.ts:386-388`) but render **#623219 / #6f3a1d** — a saturated rust
  orange, because the near lantern is cooking them; they are the most saturated thing in
  the frame, competing with the zombie ramp for attention, which is a direct violation of
  the one-saturated-family rule. And the ramp underside is another unlit black wedge.
- **Barricades** — the best-executed asset in the game. Crossed `wood`/`woodDark` planks,
  clear intact silhouette, they read instantly at 8 m and correctly signal "this is the
  weak point." Nothing to change.
- **Buy stations** — barely legible. `#3a394b` frame at luma 58 against a `#46404d` wall
  at luma 67: **9 luma of separation**. The station is nearly invisible; the only thing
  that finds it is the glowing price plate, and the price text itself is a sub-pixel smear
  at any distance. Compare STRICKEN's buy zones, which use a saturated hue block against a
  neutral wall. Yours relies on a value contrast that isn't there.
- **Perk station** — reads better than the buy station (the `survivor` blue stripe does the
  work) but is still ~90 % silhouette.
- **Walls** — flat, featureless, single-value planes. `G-core-wide` wall region: stddev-luma
  **7.3** over a 300×220 px area. That is a solid colour swatch. No panel breakup, no
  crenellation on the interior face, no `concreteLit` trim catching anything, no contact
  band visible at the floor line. This is the single clearest "programmer art" tell in the
  build — STRICKEN's equivalent walls carry trim lines, pilasters and a visible base.

---

## 5. Top 5 must-fix

**1 · Make the floors solid. `games/outpost/shared/src/map.ts` (contract amendment — needs sign-off).**
`band()` at line 246 classifies a player standing on a surface into the band beneath it,
because gravity is applied before the height query. Fix `groundHeight` to return the
highest walkable surface at or below `y + EPS` (EPS ≈ 0.05, comfortably under
`STEP_DOWN_MAX`), rather than switching on a strict `<` band test. Everything else in this
report is cosmetic next to this: until it lands, the roof, floor 2, the parapet and the
core do not exist for the player. Add a regression test that spawns a player at
`ROOF_H`, steps 60 ticks with zero input, and asserts `y === ROOF_H`.

**2 · Stop painting the ceiling black, and kill the z-fight. `render/outpost.ts` (`makeFloorSlab`, lines 345-357).**
The two boxes share an origin, so their bottom faces are coplanar (z-fighting) and the
dark `concreteDeep` one is what the player sees overhead. Split them: keep the `concrete`
slab occupying `[levelY − SLAB_T, levelY]`, and move the `concreteDeep` band to a thin
skirt at the **top** edge (`levelY`, where the deck meets the walls) where a contact band
belongs — never on the underside, never coplanar, and never oversized past the outer
walls. Then give the underside an actual read: `concreteDark` field with a
`concreteLit` beam grid every ~4 m. That is the single biggest value win available; it is
~35 % of the interior frame.

**3 · Light the interior and stop the leak. `render/scene.ts`.**
(a) Raise `HEMI_FILL_NIGHT` from 1.2 to **≥ 3.5** — three's Lambert divides by π, so 1.2 is
a 0.38× multiplier and every key-occluded surface in the fort is starved. Target: an
interior frame with **< 8 % of pixels below luma 16** and a mud floor above luma 40.
(b) Cut `CORE_LIGHT_BASE` from 20 and `pointBase` from 14, and clamp their `distance` so
they cannot reach through the slabs — the ground floor is currently lit by a beacon two
storeys above it. (c) Add a small per-level fill (a second hemi, or bake ambient into the
slab-underside vertex colours) so the enclosed levels are not left with only the leak.
Verify by re-measuring the histogram, not by reading the constant back.

**4 · Make the horde read. `render/zombies.ts` + fog in `render/scene.ts`.**
The material is right (#7da45d, sat 0.69) and it is being erased before it reaches the
eye. Push the `zeye` emissive up so it survives the fog blend, and exempt the zombie
materials from fog (or give them a much longer `fog.far`) so a shambler at 30 m keeps its
chroma instead of lerping 41 % into `fogDusk` violet. Target: **≥ 0.5 % saturated-green
pixels in any frame with 6+ zombies alive.** Currently 0.014–0.084 %; STRICKEN clears
0.5 % with no enemies on screen at all.

**5 · Give walls and buy stations a silhouette. `render/outpost.ts` (`makeWall`, `makeBuyStation`) + `render/terrain.ts`.**
Walls are single-value planes (stddev-luma 7.3). Add the `concreteLit` trim the model sheet
already specifies, a pilaster every ~4 m, and a visible `concreteDeep` base band on the
*interior* faces. Buy stations sit 9 luma from their backing wall — give the plate a real
value break (`charcoal` body against `concrete` wall) plus a saturated `pointsGold` frame,
and scale the price label so it survives at 10 m. In `render/terrain.ts`, lift the interior
mud floor out of luma 15.9 and soften the dark patches, which currently read as holes in
the floor rather than ground shading.

---

## Verdict

**Blocking visual bugs.** (1) Players fall through the roof and floor 2 to y = 0 within
~1.5 s of spawn — the 3-level fort is unreachable and the core is never visible, which
invalidates all four "fort" screenshots; (2) the floor-slab contact band is coplanar with
the slab and z-fights on every interior frame; (3) that same band renders the ceiling at
luma ~11, putting 35–38 % of interior frames below luma 16 versus STRICKEN's 2 %; (4) the
core and lantern point lights bleed through the concrete slabs, washing the ground floor
warm while the ceiling stays black; (5) the horde is invisible at 0.014–0.084 % green
pixels, less than a STRICKEN frame containing no enemies.
