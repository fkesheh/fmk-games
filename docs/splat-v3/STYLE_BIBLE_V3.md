# SKI SPLAT — STYLE BIBLE §V3 (rev 2 — post-gauntlet, FROZEN)

> An **append** to `games/splat/STYLE_BIBLE.md`. §V1 and §V2 remain in force and
> are not reopened: flat-shaded Lambert, no PBR, no textures on geometry, all
> colours from `SPAL`, meshes from `contract/visual.ts`, shadows ON,
> first-person camera, fixed bright winter morning.
>
> **Rev 1 of this document was rejected by the pre-freeze gauntlet for aiming at
> the wrong axis.** Rev 2 replaces it. Do not consult rev 1.

## What rev 1 got wrong, and what actually costs us the gap

Rev 1's thesis was that the benchmark beats us on *occlusion, depth layering and
atmospheric separation*, all reachable inside flat Lambert. A reviewer opened
all 8 reference frames and refuted it. What the reference actually does, in
**every single shot**:

1. **Large near-camera occluders.** Cliff masses filling a third of frame,
   full-height pines in the near foreground, fronds, boulders, a rock shelf.
   Depth comes from *things passing close to the lens*.
2. **Macro terrain silhouette.** Cliffs, overhangs, gaps, a broken horizon.
3. **3–5 saturated, separated hues per frame.**

Splat has **none** of the three. Its terrain is three sines totalling **4.5 m of
undulation across an 800 m run** — an unbroken horizon that vertex AO cannot
fix. Its entire snow ladder (`#ffffff → #eef2f8 → #c3cfe8 → #93a5cc`) is one
desaturated hue family; an 18% value move inside it cannot close a chroma gap.

**Also be precise about what v2 already shipped**, because you are editing it,
not writing it: `terrain.ts:266-283` already computes a 4-tap Laplacian
curvature AO plus a forest-edge term, applied at `terrain.ts:178` with
`AO_MAX = 0.12`. Corduroy, foothills, clouds and the sun disc all shipped.

**And the benchmark itself was wrong.** `judge/reference-splat/` is _Lonely
Mountains: Downhill_ — a **third-person summer mountain-biking** game. No snow,
no skis, no first-person camera in any of the 8 shots. v2 spent three rounds
asking which of a white POV snow frame and a sunlit green canyon "looks like the
better game." That is subject matter, not art, and is the likeliest reason the
gap never moved. V3's primary benchmark is a **first-person snow** set
(`judge/reference-fp-snow/`, Steep + SNOW); LMD is retained only to anchor
occlusion and depth layering.

## The V3 levers, in priority order

**Lever 1 and 2 are the pass. Levers 3–6 are polish and will not carry the
round on their own.**

---

## §V3.1 LEVER 1 — Near-field occluders  (W2, `render/terrain.ts`)

The one thing the reference does in all 8 shots and splat does in none: **large
dark masses sweeping through the near frame.**

- **Placement law (owner-set, non-negotiable): off-piste only, `|x| >= 30`,
  and NEVER a collider.** They sit beyond the piste edge (28 m) with a 2 m
  margin, and out into the skirt. A player can never touch one, so the
  4-year-old law is untouched.

  **Why 30 and not 27** (corrected after looking at round 0): the camera has no
  collision and no near-plane push-out — round-0's `v3-atmosphere.png` caught it
  clipping straight through a full-height pine, which filled 60% of frame as a
  black wedge. A 6 m occluder at `|x| = 27` would be *inside* the driveable
  piste's outer metre and a player riding the edge would fly through it. 30 m
  puts every occluder outside anywhere a skier can be, so the near-field framing
  is bought without a clipping bug. Proximity comes from the player's own
  lateral weave (±20 m), which brings them within ~10 m regularly — so make them
  **tall**; height, not closeness, is what buys the frame break.

- **Hard dependency on the ambient floor (§12.5a.2).** Round 0 proves what an
  occluder looks like in this scene today: the pine's shadow side rendered
  essentially **black**, because there is one sun, one hemisphere light, and no
  ambient floor. **Occluders shipped without W4's ambient fix are black blobs
  that make the game look worse, not better.** W2 and W4 are parallel tasks with
  a real coupling here: W2 supplies the masses, W4 supplies the light that makes
  them read as blue-shadowed snow-country rock and pine rather than holes in the
  frame. Both must land for either to pay.
- **Cadence: 2–4 masses per 100 m of run**, alternating sides irregularly
  (seeded, never a rhythm), so at 26 m/s one enters frame every ~1–2 s.
- **Size: 2.5–6 m tall, 3–8 m wide.** They must be tall enough to break the
  horizon line from a 1.55 m eye and wide enough to occlude a meaningful slice
  of frame as they pass.
- **The bound is on the BOUNDING BOX, not the centre: every occluder satisfies
  `|x| >= 28.5` across its full width.** An 8 m-wide buttress *centred* at 27
  spans 23–31 and puts 5 m of rock inside the piste. Occluders may freely
  overlap the forest band and the skirt beyond — the earlier "they sit in the
  1.5 m slot between the piste edge and the forest wall" phrasing was wrong and
  is withdrawn.
- **Forms** — three archetypes, all baked, all from the frozen kit:
  - **Rock buttress:** 3–5 interlocking angular masses in `rockLit`/`rock`,
    snow skirt (`snowLit`) on the uphill face, a `snowShade` contact crease.
    The darkest thing in the frame — this is where the value contrast comes
    from.
  - **Mature pine cluster:** 2–4 full-height pines (6–9 m, taller than
    anything currently on the mountain), `pineDark`/`pine`, heavy snow load.
    Their boughs should clip the top frame edge as you pass.
  - **Wind lip / cornice:** a sculpted snow overhang, `snowLit` crest over a
    deep `snowShade` underside — the one occluder made of snow, and it earns
    its place by having a genuine dark underside.
- **Every occluder casts a shadow onto the piste.** A mass that doesn't lay a
  long morning shadow across the run is doing half its job. This is the single
  highest-value shadow in the game — budget for it.
- **Draw-call discipline:** all occluders bake into the existing terrain
  dressing bake. W2's net allowance is **+0**, funded by cutting `FOREST_MAX`
  from 2800 to 1900 (§12.3e).

## §V3.2 LEVER 2 — Macro terrain silhouette  (A1 constants, W1 `slope.ts`)

**Owner-approved gameplay change.** The horizon is currently a straight line
because the mountain is flat.

- **Use the exact constants frozen in CONTRACT §12.2a — do not improvise, and
  do not scale uniformly.** `UND_LONG_1_AMP 2.0 → 5.2`, `UND_LONG_2_AMP
  1.0 → 0.4`, `UND_LAT_AMP 1.5 → 2.5`. This *re-allocates* amplitude onto the
  longest wavelength rather than scaling everything, giving ~11 m of envelope
  with zero `GRADE_MIN` clamping. Uniform ×2.5–3.0 was measured against the real
  sim and is unshippable: it falsifies the frozen grade-safety proof, makes the
  safety clamp fire on 17–20% of the run, and breaks the kicker-spacing law.
  Uniform scaling caps out at ×1.576 (~7.1 m) — re-allocation is the only route
  to 11 m.
- **Constraint:** this changes jump arcs, landing points and kicker feel.
  §12.4 gate 7 re-runs the full 20-seed containment + finish sweep on the
  raised terrain **with the air lock active**. If it fails, the amplitude comes
  back down — that is the orchestrator's call, not an implementer's.
- **Flanking masses (W2):** beyond the piste edge, raise the skirt into
  irregular ridges and shoulders so the horizon is broken by *terrain*, not
  only by props. Three depth planes minimum on the horizon: flanking ridge →
  nearer foothills → distant peak cards.
- **RNG law:** any new randomness uses its own stream (§12.3c). W1 may not
  perturb `genSlope`'s sequential stream by a single draw.

## §V3.3 LEVER 3 — The chroma budget  (all visual tasks)

Snow cannot carry chroma; **stop asking it to**. Every saturated hue in the
frame must come from something that is not snow.

- **Target: 3–4 clearly separated hues visible in any gameplay frame** —
  today most frames are snow-white plus one green. Sources, in order of area:
  `rockLit`/`rock` (warm grey-brown mass), `bark`, `pineDark`/`pine`,
  `skyZenith` (deep azure), `sunGold` and the slalom `azure`/`ember` flags.
- **Raise the presence of rock and bark**, which are the only large warm
  masses available. The occluders of §V3.1 are the delivery mechanism.
- **Snow's job is value, not hue:** keep the ladder tight and let the
  non-snow elements do the colour work.
- **Hard rule unchanged:** no new `SPAL` key, no ad-hoc hex. Every colour named
  here already exists in `palette.ts:9-38`. The key name **`fog` is
  forbidden** (`valueLadder.test.ts:95`).

## §V3.4 Mid-distance dressing  (W3, `render/plants.ts`)

v2's residual complaint was that the world "reads sparse on clean-piste shots".
That is a **mid-distance** problem — 15–60 m out. Sub-metre props 4 m to the
side occupy the extreme bottom frame corners for a fraction of a second and
will not move a judge score. Rev 1 aimed there; rev 2 does not.

- **Band: `|x| >= 27` only** (see §12.3b — rev 1's placement was wrong by ~9×
  and would have put props in the racing line).
- **Nothing green and plant-shaped near the piste.** The gameplay plants are
  verbs; dressing that looks like them but can't be hit is a lie. Dressing
  archetypes are **rock, bark and snow** only — no `pineDark` blades, no
  saplings.
- **Three archetypes, ≤3 InstancedMeshes total, `castShadow = false`**
  (a shadow caster costs two draw calls):
  - snow-crusted stones 0.4–1.2 m (`rock` body, `snowLit` cap) — **~400**
  - half-buried logs 1.5–3 m (`bark`, `snowLit` cap) — **~250**
  - exposed twig clusters 0.5–1 m (`bark`) — **~250**
- **Distribution:** seeded Poisson, λ ≈ 1 per 5 m slice, cluster radius ~7 m,
  3–7 per cluster, with clearings — mirroring the gameplay-plant rule.
- **Cull distance 120 m.** Total instances ~900, inside the budget freed by
  W2's `FOREST_MAX` cut.
- **Draw-call allowance ≤ +7.**

## §V3.5 Fog band  (W4, `render/scene.ts`)

Rev 1 said the band was "parked in world space… you ski into and through it"
*and* "never fogs the near-field — it lives ≥ 60 m out." Those are mutually
exclusive. **Resolved: camera-parked.**

- A band of haze held at a fixed **60–140 m** depth from the camera, alpha
  ramped to **zero inside 60 m** so it never touches the near field and is
  never intersected.
- **ONE merged additive mesh**, `MeshBasicMaterial`, `transparent`,
  `AdditiveBlending`, `depthWrite:false`, `fog:false`. Tinted `skyHorizon` →
  `paper`.
- Purpose: separate the mid-ground from the distant peaks so the world reads in
  four depth planes, not two. It supports the occluders; it does not replace
  them.
- **Cut from rev 1: sun light shafts.** They needed forest-gap positions living
  in W2's file with no seam to W4. Removed rather than shipped broken.

## §V3.6 Bloom  (W4, `render/scene.ts`)

Rev 1 called this an "insertion". It is not — there is **no `WebGLRenderTarget`
anywhere in the client**. `scene.ts:495-502` renders the world straight to the
canvas then blends three untextured fullscreen quads over it. This is a render-
path rewrite and is specified as one:

1. Render the world into a `WebGLRenderTarget` (HalfFloat, linear).
2. Bright-pass into a quarter-res target. **Threshold: luma > 0.995, knee
   0.005** — so only pure `snowLit` (`#ffffff`), the sun disc and the sparkle
   glints qualify. A blown-out white piste is worse than no bloom.

   **Do not use 0.97/0.02** (rev 2's value — withdrawn). The piste is not
   painted in flat `snow`: `terrain.ts:167-169` lerps a *continuum* toward
   `COL_LIT = snowLit = #ffffff`, and `terrain.ts:165-167` states outright that
   "mid-slope must paint near snowLit or the piste goes dusk". At 0.97/0.02 the
   bright pass starts at 0.95 and **most of the lit piste blooms** — the exact
   failure the threshold exists to prevent. `paper` (`#f4f7fb`, luma 0.967) and
   `sunWarm` (`#fff1d6`, luma 0.949) also fall inside that knee, and `paper` is
   both the W5 glove cuff and a fog-band tint.

   **`scene.test.ts` must assert that a frame of pure `snow` and a frame of pure
   `paper` produce a zero bright-pass result.**
3. Separable blur, H then V, at quarter res.
4. **Composite in ONE pass that also absorbs the existing grade, vignette and
   hit-flash shaders** — this reclaims 2 draw calls and keeps the total ≤ 4.
5. `resize()` (`scene.ts:486-493`) must resize all render targets; `prewarm()`
   (`scene.ts:512-541`) must compile the new quad scenes.

**Colour-space hazard, stated so it is not misread as "the bloom looks wrong":**
`scene.ts:122` documents that the current post shaders are authored in raw sRGB
with no colour management. Introducing a linear render target shifts every
colour in the game. **Acceptance check: a bloom-disabled build must be
pixel-identical to HEAD.**

## §V3.7 First-person body presence  (W5, `render/skiers.ts`)

The *descent* shot — our worst-scoring — is currently two ski tips on snow.

- **Hands and poles in frame:** two gloved hands at the lower frame corners,
  `ink` gloves with a **`paper`** cuff. (Not the player's slot colour — the
  local slot never reaches `skiers.ts`, and reaching for it would need an
  `app.ts` edit that is out of scope. `paper` needs no plumbing.)
- **Pole plant on hard carves:** past a steer threshold the inside pole swings
  down and back in an eased ~0.4 s arc.
- **Ski flex and chatter:** flex up to **1.5°** under load in a turn; chatter
  **±0.3° at ~18 Hz**, amplitude scaling linearly with `v/MAX_SPEED`.
- **Air pose:** on launch skis pull together and level, hands come up and back,
  mirroring the §V2.4 remote air pose.
- The frame stays mostly mountain — body never occupies more than the bottom
  quarter.
- Everything above falls out of the existing `setOwnSkis(steer, v, dt)` and
  `setOwnAirborne(on)` signals. The rig is camera-space: no shadow cost.
  **No `app.ts` change is a legitimate gap for this task.**

## §V3.8 AO — a correction, not a new feature  (W2 + W1)

- **REPLACE, do not add.** W2 must **remove** the existing `curvatureAO` and
  `forestAO` computation (`terrain.ts:266-283`) and put the deepened version in
  its place. Stacking a new AO term on the old one double-darkens the piste —
  the exact muddy failure this is meant to avoid.
- **Deepen it:** two sample radii (**~3 m and ~8 m**, 8 taps each) instead of
  the single `AO_STENCIL = 2.5`; raise `AO_MAX` from **0.12 to ~0.22**.
- **Fix the inverted edge term — this is a live bug.** `terrain.ts:277-281`
  computes `edgeGap = halfW - |x|` then `forestAO = smooth01(edgeGap /
  FOREST_EDGE_FADE)`, which is **maximal at the piste centre and zero at the
  edges** — the exact opposite of its own comment. Invert it
  (`1 - smooth01(...)`) so the shade sits where the trees are. **W2's gate must
  assert the piste centre is not darker than the piste edge.**
- **Contact AO:** every occluder, forest instance and rock stamps a soft radial
  darkening into the terrain vertex colours at its base, radius ≈1.6× its
  footprint. This is what grounds objects; its absence is the "floaty" smell.
- **Carve tracks (W1, `trackMask`):** 6–10 seeded S-curves on the **groomed
  band** (`x = 0 ± 10.1 m`, keyed to the same `bandHalf`/`corrPhase` as the
  corduroy at `terrain.ts:188-201`), 12–25 m wavelength, 0.5–0.7 m wide, drawn
  as a `snowShade` trench with a thin `snowLit` spoil edge on the outside of
  each turn. Tracks cross, fade in and out, and a few run off a kicker lip and
  resume downhill of it. Drawn **over** the corduroy — machine and people must
  both read.

## §V3.9 Explicitly NOT permitted

- No PBR, no IBL, no material-model change. Lambert only, except §12.3d's
  narrow exemptions (fog-band billboard, bloom shader/render targets).
- No textures on geometry beyond §V1's list plus §12.3d.
- No ad-hoc hex. No new `SPAL` key. Never `fog`.
- No day/night cycle. No third-person camera, ever.
- **No occluder or dressing prop inside `|x| < 27`, and none may ever have a
  collider.**
- No change to plant placement, clearances, gate or kicker positions — the
  `rngDigest` gate (§12.5.4) proves it.
