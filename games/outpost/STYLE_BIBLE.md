# STYLE BIBLE — OUTPOST

Embedded **verbatim** in every visual implementer's prompt. Six art agents read this instead of
each other's code; it is the only thing making their output cohere into one art-directed game.

---

## Mood & references

A timber watchtower on a bare plateau at the end of the day, floodlit against a treeline that is
already dark. Warm, human, hand-built light — lanterns, braziers, a floodlight cone — pushing back a
cold blue dusk that is losing patience. The fort is the only warm thing in the frame; everything
outside the fence is cold, and the horde arrives out of that cold as **pale figures against dark
trees.** Lived-in, not pristine: sandbags sag, timber is patched with scavenged corrugated sheet,
there is mud where sixteen people have walked the same line to the fence a hundred times.

**Benchmark titles — this build is blind-compared against these, and must win or tie:**
- **Deep Rock Galactic** — stylized low-poly geometry, dramatic coloured key light, heavy
  atmospheric fog, silhouettes that stay readable in the dark. Its lighting *drama* is the target.
- **Valheim** — a palisade-fenced base raided at night, torchlight pools on wet ground, misty
  conifer treeline, moody blue ambient with warm fire accents. Its *fiction and palette* are the target.

Both are stylized, so this is a comparison the build can genuinely **win**, not merely survive. We
are not competing on texture fidelity — we compete on art direction, composition, colour harmony,
lighting mood, silhouette readability and density.

---

## Material model — ONE model, never mixed

**Flat-shaded `MeshLambertMaterial`.** Crisp facets, no specular, no textures, no PBR, no env map.
This is inherited from STRICKEN and is proven at 2,400+ source meshes baked under 60 draw calls.

- Every material comes from `mat(hex, opts)` in the frozen `client/src/contract/visual.ts`. Raw
  `new THREE.Mesh*Material` or `new THREE.BoxGeometry` in implementer code is a contract violation.
- Renderer: `ACESFilmicToneMapping`, `SRGBColorSpace`, `antialias: true`, `PCFSoftShadowMap`,
  pixel ratio capped at 2.
- **Materials are draw calls.** Primitives are free; materials are not. Budget: **max 6 palette
  entries per repeated asset** (a zombie, a fence segment, a weapon). Static art goes through
  `bake()`, which merges to one mesh per material.
- **Draw-call budget is 420** (`PERF.maxDrawCalls`), not 200 — the density this style bible mandates
  (articulated near-LOD zombies, 16 individually-damaged fence segments, per-character shadows) is
  honestly costed near there. To keep 420 comfortable rather than tight, two things are **mandated**:
  far-LOD zombies render as **one `THREE.InstancedMesh`**, never N separate meshes; and a character's
  contact shadow is **baked into its model**, not a live sibling mesh. `InstancedMesh` is an
  explicitly permitted exception to the visual.ts-only rule, in `render/zombies.ts` and
  `render/world.ts`.
- Exceptions, and only these: `ShaderMaterial` for the sky dome / sun-moon disc / post grade,
  `PointsMaterial` for particles, `MeshBasicMaterial` for light-pool decals and emissive quads.

---

## Palette

All colours trace to `PALETTE` in `@outpost/shared/palette` — STRICKEN's 81-colour ramp plus the
OUTPOST family. **An ad-hoc hex literal anywhere is a contract violation a reviewer checks for.**

The families you will reach for most:

| Role | Keys |
| --- | --- |
| The horde | `rotPale` `rotFlesh` `rotDark` `rotDeep` `gore` · `zeye` (emissive only) |
| Fort timber | `woodLit` `wood` `woodDark` `woodDeep` |
| Scavenged sheet | `rustLit` `rust` `rustDark` |
| Emplacements | `sandbagLit` `sandbag` `sandbagDark` |
| Ground | `mudLit` `mud` `mudDark` `mudDeep` `gravel` |
| Treeline | `pineLit` `pine` `pineDark` `pineDeep` |
| Stone/concrete/steel | `concrete*` `stone`-family, `steelLit` `steel` `metalDark` `metalDeep` |
| Sky & fog | `duskSky` `duskSkyHigh` `duskHorizon` `duskFog` · `skyNight` `skyNightHigh` `fogNight` · `moonlight` |
| Warm light | `floodBeam` `torchCore` `emberGlow` `fire` `muzzle` |
| HUD | `hudText` `hudAccent` `scrapGold` `reviveCyan` `downedRed` `danger` `hpGreen` |

**Static geometry is stamped with a `MatKind`, not a palette key — resolve it, never name it as one.**
`map.ts` tags every `STATIC_BOXES` entry with one of nine `MatKind`s (`timber`, `timberDark`,
`stone`, `concrete`, `steel`, `rust`, `sandbag`, `mud`, `gravel`). `timber` and `timberDark` are NOT
entries in `PALETTE` — only `wood`/`woodLit`/`woodDark`/`woodDeep` are. Resolve every `MatKind`
through `MAT_COLORS` in `@outpost/shared`, which maps all nine kinds to their body/trim/dark/contact
palette tiers (e.g. `timber` → body `wood`, `timberDark` → body `woodDark`). Do not invent your own
mapping — that is exactly how the tower's timber and the world's props stopped sharing a value ladder
in the first draft.

**The four-tier value ladder is the law**: `Lit` ≥ base +8 L*, `Dark` ≤ base −8 L*, `Deep` ≤ dark
−8 L*. Use all four on every built surface. A box painted one flat colour is the single clearest
programmer-art tell — the previous build was measured at **stddev-luma 7.3 over a 300×220 wall
patch** and called "a solid colour swatch". Use `articulate()` (plinth / cornice / pilasters /
mid-rail) on every built surface over 1.5 m — the fence is 1.6 m and its 16 segments (~256 m², the
largest built surface in the game) are explicitly in scope; at a 2 m threshold they silently stopped
tripping this rule.

**One swatch, one job.** The previous build let a single pale cream serve as key light, lantern
bulb, status light *and* the hero object, and every one of them read as an unlit marshmallow. If two
things in the frame have different storytelling roles, they get different keys.

---

## Lighting recipe — and the trap that killed the last build

The previous OUTPOST shipped with **65% of every frame below luma 20** (STRICKEN: 2–3%) and a mud
floor measuring luma 15.9 — "you cannot see the ground under your feet." The cause was not taste,
it was arithmetic, twice:

1. **A `HemisphereLight`'s colour multiplies its intensity.** Its swatches sat around 0.2 linear, so
   `intensity: 1` delivered ~0.2 of the intended fill.
2. **three's Lambert divides irradiance by π**, so a nominal 1.2 delivers ~0.38× albedo to any face
   the key doesn't reach.

**Therefore: you may not tune lighting by reading a constant back.** `scripts/capture-outpost.mjs`
measures the rendered PNG and fails the shot against `VISUAL_GATES` in the frozen config:
`minMedianLuma` over the 3D region (canvas minus the HUD rects), `maxShadowShare` of pixels below the
shadow-luma threshold, `maxBlowoutShare` above `blowoutLuma` — deliberately NOT 240: the near-field
blowout the previous build was condemned for measured luma 200–201, so a 240 cut-off passed the exact
frame it existed to catch — and `minSurfaceStddev` over each shot's declared `sampleRect`. The
numbers live only in `VISUAL_GATES`, not here, so this section cannot drift from the frozen config
again.
**Tune until the histogram passes.** The number in the source is not the deliverable; the pixels are.

The rig:

- **Hemisphere ambient** — sky tint over ground bounce. This is the floor of the image; nothing may
  fall into pure black. Set it so unlit faces still read.
- **Key: a directional moon/last-light**, `castShadow`, 4096 map, one static ortho cascade fitted in
  light space to the map bounds, raking at ~22° elevation for long dramatic shadows across the
  compound.
- **Cool sky-bounce fill** from the opposite azimuth, shadowless.
- **Camera-follow fill**, shadowless, ~0.4 — the proven STRICKEN trick that keeps a zombie's shaded
  face readable while you are aiming at it. Without it the horde becomes black cutouts, exactly as
  it did before.
- **Warm practicals**: 4 floodlights on the top deck aimed outward-and-down over the fence, plus
  braziers at the gate and on deck 1. These are the fort's *character*.
  **Hard rule, learned the hard way: no point/spot light may have a range that crosses a floor slab.**
  The previous build lit its ground floor through a metre of concrete from a beacon two storeys up.
  Deck-2 practicals stop above `DECK2_Y`; ground-floor practicals stop below `DECK1_Y`. This forbids
  leaking LIGHT ACROSS a slab — it does not forbid lighting the ground floor. **The ground floor is
  not an enclosed room**: `towerBoxes()` builds it as an open post-and-beam undercroft, 14x14, with
  parapets only at deck level — it is open on all four sides, a shaded space under a deck that
  ambient and the key already reach from every side. Its lighting job is therefore shaping and
  warmth, not rescuing an interior from darkness: it gets its OWN dedicated practical set (braziers,
  the ammo-crate practical), clamped to `distance < DECK1_Y` so it physically cannot leak upward past
  the deck-1 slab, and it is still gated at the same `VISUAL_GATES.minMedianLuma` (≥ 48) as every
  other kept frame — under-deck is not an exemption from the lighting gate, it is a different light
  source reaching the same bar.
  At most ONE practical casts shadows (perf).
- **Fog**: `FogExp2`, colour **always** the mood's `…Fog` key (`duskFog` / `fogNight`) — **never**
  the horizon band (`duskHorizon`). `duskHorizon` is L* 46.6 and `duskFog` is L* 35.6; painting fog
  with the horizon band collapses the horde's dusk value contrast from ~48 L* to ~37.5 L*, invisibly
  to `palette.test.ts` (which only checks `duskFog`), for waves 1–3 — the exact waves a new player
  sees first. A fog colour that does not harmonise with the sky reads as a grey wall at the draw
  distance; matching the mood's `Fog` key is how it harmonises without erasing the horde's contrast.
- **Two moods, both shippable and both captured**: `dusk` (waves 1–3) — cool sky and fog with one
  warm horizon band, long shadows; `night` (wave 4+) — deep blue, moon key, the floodlights become
  the dominant light source and the compound reads as an island of warmth. Fog density rises with
  the mood.
  **Dusk uses OUTPOST's own `duskSky`/`duskSkyHigh`/`duskHorizon`/`duskFog` keys, NOT STRICKEN's warm
  desert `skyDusk`/`fogDusk`.** Against STRICKEN's dusk the horde's value contrast collapsed to
  11.8 L* (versus 65.8 L* at night), which would have reproduced the previous build's readability
  failure — in value space instead of hue space — for the exact waves (1–3) a new player sees first.

---

## Camera & framing

First-person, `BASE_FOV` 75°, near 0.1 / far 500. Eye = feet + height − `PLAYER.eyeOffset`.
Three framings must always read well because the judge captures all of them:
- **From the top deck** looking out over the fence at the treeline — the establishing shot. The
  fence line, the approach, and the treeline must all be legible with foreground parapet framing.
- **On the ground at the fence** — the fight. Frame it FROM `courtyardNE` or `stairFoot` looking AT
  the fence feature point (`fenceNorth`/`fenceEast`/`fenceSouth`/`fenceWest`/`gate` are look-at
  TARGETS only — they sit dead-centre in the segment's 0.35 m AABB and are never legal camera
  positions). Fence texture, firing step, and zombies at 3–15 m.
- **Inside the tower ground floor** looking out — the interior test. This is where the previous
  build measured 35–38% of pixels below luma 16 and failed hardest.

**Break the horizon.** The previous build's horizon was called out as "a dead-flat horizontal line
at almost exactly frame centre, running uninterrupted from x=0 to x=1920." The 4.5 m corner
watch-posts, the tower, the field wrecks, and a treeline with varied crown heights exist
specifically to break it. No two adjacent treeline conifers may share a height.

---

## Silhouette language

Chunky low-poly with generous chamfers. Nothing thin enough to vanish at 40 m. Human survivors
~1.8 u with pivot-anchored limbs. Structures read as **stone footing → timber frame → patched sheet**
top to bottom. Timber is *stacked and lashed*, never extruded: visible cross-beams, bracket plates,
and diagonal bracing on every span over 3 m.

**The horde's silhouettes must be distinguishable at 40 m by SHAPE ALONE**, before colour or
animation help — the previous build's judge could not tell shambler from runner from brute, or
zombies from fence posts:

| Kind | Silhouette rule |
| --- | --- |
| **Shambler** | Hunched, head below shoulder line, arms hanging low, wide slow stagger. Reads as a lowercase "n". |
| **Runner** | Upright and lean, head thrust forward ahead of the chest, arms swept back, narrow. Reads as an arrow. |
| **Brute** | 2.5 m, enormously wide shoulders, tiny head sunk between them, one oversized arm. Reads as a "T" twice as wide as anything else on screen. |
| **Spitter** | Distended barrel torso, thin limbs, head tipped back. Reads as a lightbulb on legs. |

---

## The horde reads by VALUE, not hue — the mechanism that must not fail

The previous build's stated art thesis was "the horde is the one saturated element". It measured
**0.00% saturated-green pixels in every frame with zombies alive**, because fog lerped them into the
background before they were ever drawn and the mitigation (emissive eyes) was sub-pixel at range.
A hue-based plan cannot survive fog. A value-based one can:

1. **`rotPale` is high-value (L* ~84).** A pale figure against `pineDeep` trees and `mudDark` ground
   holds contrast at any distance and through any fog density, because fog moves colour toward a
   mid-value sky and the figure stays lighter than its backdrop either way.
2. **`rotPale` is the silhouette colour: chest, skull and forearms** — the parts that break the
   horizon line first. Per `palette.ts`, chest coverage is the single largest contributor to the
   `minHordePixelShare` gate, whose margin is the thinnest in the file, so this assignment is
   load-bearing, not cosmetic. Shoulders and remaining torso `rotFlesh`, shaded/clothing `rotDark`,
   contact `rotDeep`.
3. **Eyes are emissive `zeye` on quads whose world scale grows with distance** so they never fall
   below ~3 px on screen. Distance-independent by construction, not by hope.
4. **It is measured.** With ≥ `VISUAL_GATES.hordeMinZombiesForGate` (6) zombies alive within
   `hordeGateRadius` (12 m), ≥ `minHordePixelShare` (0.25%) of the **3D region** (canvas minus the
   HUD rects — not "frame pixels") must carry the horde signature. The capture harness fails the
   shot otherwise.

---

## World population & atmosphere

An empty plane reads as a tech demo. Target densities — hit these:

- **Treeline**: ~180 conifers in the ring r = 56…84, in clusters of 6–14 with clearings between,
  crown heights varied 6–14 m, never two adjacent the same. Baked. `HORDE.spawnRing` is 58, sitting
  just inside this ring, so the horde genuinely emerges from among the trees rather than popping in
  from open ground beyond them. `PLATEAU_RADIUS` is 84, so the ground reaches the full treeline —
  this is the wall the horde emerges from and it must read as a forest, not a fence of cones.
- **Mid-field**: ~40 stumps, deadfall logs and burnt snags scattered r = 24…58, thinning toward the
  fence (the defenders cleared their firing lines — the thinning *is* the storytelling).
- **Inside the compound**: ~120 props — crates, oil drums, sandbag stacks, a tool bench, coils of
  wire, planks, a wheelbarrow, laundry line, ammo tins, tarps. Cluster them against walls and under
  the tower, never evenly scattered.
- **Ground**: `mud`/`mudDark`/`gravel` as separate baked tier meshes (one draw call each, and crisp tier boundaries suit flat-shaded Lambert better than a smooth blend) — worn gravel paths radiating from the tower
  stairs to each fence side (the paths sixteen people wore), mud pooling in the low spots. The
  ground must never be one flat colour polygon.
- **Ambient motion**: brazier flame flicker, floodlight cone dust motes, a tarp and a flag edge
  swaying, conifer crowns drifting. Stillness reads as a screenshot, not a world.
- **Real-time shadows ON** in the shipped product. If a verification pass is slow, reduce
  resolution — never disable shadows or post.

---

## Per-asset model sheet

Every asset below is specified as **silhouette + part budget + storytelling detail**. "Detailed and
nonblank" is a banned brief. Colours are named palette keys.

### Structures (`render/outpost.ts`)

- **`makeTower`** — the hero object, 90–140 prims total. `stone` rubble footing course; nine
  `woodDark` corner and mid posts with visible bracket plates and diagonal knee-braces — 4 corners,
  2 east/west mid, 2 flanking the south stair doorway (these two read as a doorframe), and 1 north
  mid; two `wood` deck slabs with individually-jittered plank lines; `wood` parapets with `rust`
  corrugated sheet patches lashed over the gaps; a canvas awning (`sandbag` tone) over one corner of
  deck 1; a ladder-and-rope detail; a hanging lantern on deck 1; coiled rope, a water barrel, and a
  spotter's stool on deck 2. Storytelling: the tower is *finished* on the bottom and *improvised* on
  the top — the higher you go the more scavenged it looks.
- **`makeStairRun`** — 12 treads, 25–40 prims: `wood` treads with a `woodDark` stringer either
  side, a `steel` handrail on the outboard side with turned posts, and one visibly replaced tread of
  a lighter `woodLit`.
- **Deck slab undersides** — currently unowned, and it is ~35% of the interior framing: the ceiling
  of the ground floor and the underside a player on deck 1 looks up at. A `woodDark` joist grid every
  ~2 m with `woodLit` bracket plates at the joins, so the ground floor's ceiling gets an actual value
  read instead of being one flat dark field.
- **`makeFenceSegment(hp01, breached)`** — 30–55 prims, and it must read its state at 15 m:
  - **Intact**: a row of 14–18 `wood`/`woodDark` palisade timbers of jittered height and lean, tops
    cut to points, lashed with two horizontal `woodDark` rails and `steel` brackets; one or two
    `rust` corrugated sheets wired over the middle; `sandbag` firing step inside with 6–9 individually
    placed bags.
  - **Damaged** (hp01 < 0.6): timbers splintered and canted, one or two missing entirely showing a
    gap, `gore`-stained rails, splinter debris on the ground.
  - **Breached** (hp01 = 0): the palisade is gone; a `rubbleHeight` scatter of broken timber,
    twisted `rust` sheet and spilled sandbags — walkable, and unmistakably a hole from 30 m away.
    **The breach must be the most legible thing on the fence line** — it is where the player must go.
- **`makeGate`** — segment 2: two heavy `woodDark` leaves with iron `steel` strapping and a
  drop-bar, flanked by `stone` piers with a lantern on each. Reads as a gate in silhouette alone.
- **`makeWatchPost`** — 4.5 m corner mast, 12–20 prims: `woodDark` pole, small crow's-nest
  platform, a hanging lantern, guy-wires.
- **`makeWeaponRack`** (deck 1) / **`makeAmmoCrate`** (ground floor) — 15–25 prims each, and they
  must be **findable**: silhouette + a warm practical light + a `hudAccent` painted stencil.
  The previous build's buy stations had "9 luma of separation from the wall behind them" and prices
  that were "a sub-pixel smear at any distance" — these get their own value separation and a
  world-space label that is legible at 8 m.

### World (`render/world.ts`)

- **`makeConifer(variant)`** — 6–14 m, 8–14 prims: tapered `woodDark` trunk with 3–5 stacked
  `pine`/`pineDark`/`pineDeep` frond tiers narrowing upward, per-variant jitter from the seeded RNG.
  At least four distinct variants plus a dead snag variant (bare `woodDark` branches).
- **`makeGround`** — a plane out to `PLATEAU_RADIUS` built as SEPARATE meshes per palette tier (never one polygon, and NOT vertex-tinted — `bake()` carries only position/normal/uv, so a vertex-coloured ground bakes to pure black), blending `mud` / `mudDark` /
  `gravel`, with worn gravel paths from the stair feet to each fence side and puddles catching the
  sky colour in the low spots. Never one flat polygon.
- **`makeRidges`** — layered silhouette ridges beyond the treeline, `pineDeep` to `fogNight`,
  2–3 depth layers, purely decorative, giving the horizon depth without a skybox photo.
- **`makeSky`** — 3-stop gradient dome (horizon / mid / zenith) per mood + a moon disc with a soft
  halo + a `Points` starfield that fades in with the `night` mood. The top 30% of frame must not be
  a clean empty gradient: give it cloud banding.

### Characters (`render/zombies.ts`, `render/survivors.ts`)

- **`makeZombie(kind, variant)`** — 24–40 prims, ≤6 palette entries. Pivot-anchored limb groups at
  shoulder and hip so walk/lunge/attack/stagger are pure functions of gait phase. Per-variant
  jitter (height ±8%, one asymmetric detail: a missing forearm, a hanging jaw, an embedded plank, a
  torn coat tail) so a wave of 40 never reads as 40 clones. Silhouettes per the table above.
  Emissive `zeye` eye quads. **Near LOD** (< 20 m, max 14) is the articulated model; **far LOD**
  renders as ONE `THREE.InstancedMesh` (per `PERF`'s mandate — a literal single merged mesh would
  freeze every far zombie in world space), keeping the same silhouette and the same `rotPale` value
  read, with per-instance matrices driven by gait phase.
- **`makeSurvivor`** — 30–45 prims: layered coat over webbing, a helmet or knit cap variant,
  a shoulder lamp that is lit, visible hands, a `hudAccent` armband so teammates read instantly at
  range. Downed pose is a distinct, unmistakable silhouette (prone, one arm raised) with a
  `reviveCyan` beacon above it visible through geometry.
- **`makeViewModel(weapon)`** — first-person hands + gun, ≤6 palette entries, camera-parented at
  a scale picked to taste so it is FOV-independent. **The viewmodel must never depend on world lighting** — the
  previous build's was "present and completely unlit… OUTPOST reads as a walking sim." Give it its
  own dedicated light or emissive floor so it reads in every mood.

### FX (`render/effects.ts`)

Pooled, never allocated per burst: muzzle flash + smoke, tracers, blood spray and pooling decals,
**fence splinter bursts** when a segment is struck, dust kicked from the mud, spitter acid arc with a
glowing trail and a lingering `zeye`-tinted pool, revive beacon column, scrap pickup sparkle, brazier
embers, floodlight dust motes, screen-shake trauma on brute impacts and nearby breaches.

---

## Non-negotiables checklist for every art agent

- [ ] Every colour is a `PALETTE` key. Zero hex literals.
- [ ] Every surface uses ≥3 tiers of its value ladder; every built surface over 1.5 m uses
      `articulate()` — the fence (1.6 m, 16 segments, ~256 m², the largest built surface in the game)
      included.
- [ ] Static art is `bake()`d; animated parts stay live via `userData.animate`.
- [ ] Nothing is coplanar with anything else — offset by `COPLANAR_EPS`. The previous build shipped
      a z-fighting ceiling band measured at stddev-luma 36.2 and called it "a ship-blocker".
- [ ] Every prop and character has a `contactShadow()` so it sits on the ground rather than floating;
      for characters it is baked into the model, not a live sibling mesh, and far-LOD zombies render
      as one `InstancedMesh`.
- [ ] Shadows on, post on, both moods correct, fog colour == the mood's `…Fog` key
      (`duskFog` / `fogNight`) — NEVER `duskHorizon`.
- [ ] No practical light's range crosses a floor slab.
- [ ] The frame passes `VISUAL_GATES` when measured, not when the constant looks right.
