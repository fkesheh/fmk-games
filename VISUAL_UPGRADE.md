# VISUAL UPGRADE CONTRACT — FROZEN

Addendum to `STYLE_BIBLE.md`. Governs one job: **raise the visual quality of STRICKEN, KART GP and
BANK** without changing render technology. Every implementer reads §0, §1 and its own game section.
This document is **immutable** during the build. If it seems wrong, report it — do not edit it.

---

## §0 — CONSTRAINT ENVELOPE (hard rules, no exceptions)

This upgrade is deliberately scoped to **polish within the existing render tech**. The point is to
prove how far art direction alone goes.

### FORBIDDEN — adding any of these is a contract violation that fails review

| Forbidden | Why |
| --- | --- |
| `EffectComposer`, `postprocessing`, bloom, SSAO/GTAO, SMAA/FXAA passes, any new render target | No new post-processing. |
| `MeshStandardMaterial`, `MeshPhysicalMaterial`, `MeshPhongMaterial`, PBR, env maps, IBL | Material model stays flat Lambert. |
| `TextureLoader`, image files, `.png`/`.jpg`/`.hdr` assets, normal/roughness/AO maps | Stays 100% procedural, zero assets. |
| **New** surface texturing of world geometry (canvas textures mapped onto walls/ground/track) | "No textures" means the world stays untextured. |
| **NEW** `vertexColors` materials, or baked vertex AO | Out of envelope this round. Deliberate — see §6. **Not a ban on the existing ones:** KART's world already runs on a shared vertex-coloured Lambert (`trackMesh.ts:93`) and a vertex-coloured sky dome (`render.ts:378`), and FPS's map sky dome uses one (`mapRenderer.ts`). Retuning those existing colour attributes is not only permitted, it is how K1/K2 must do their work. Do not introduce a vertex-coloured material where one does not already exist. |
| Ad-hoc hex literals anywhere outside the three palette files | Kills cross-agent cohesion. |
| Raw `new THREE.Mesh*Material` / raw geometry in FPS renderer code | Use the frozen factories. |
| Lowering shadow quality, disabling shadows, or dropping pixelRatio "for perf/tests" | Known regression that flattens the look. |

### PERMITTED — the whole toolkit for this round

1. **Palette values and hue relationships** — the three palette files (§2) are being rewritten by
   the architect; you consume them.
2. **Detail geometry** — trim, plinths, cornices, pilasters, panel reveals, sills, frames, pipes,
   vents, seams, bevel chamfers. Flat shading turns every new edge into a free value break. This is
   your single biggest lever after the palette.
3. **Deco density and placement** — prop counts, clustering, dressing dead corners.
4. **Light and shadow settings** — intensities, hemisphere sky/ground tints, sun direction and
   colour, shadow map resolution, frustum fit, bias, fog density.
5. **Animation, easing, timing, layout, typography, CSS** (2D surfaces).
6. **Tuning the pre-existing**, exhaustively: the hand-rolled vignette/grade shader and sky/sun-disc
   shaders in `scene.ts`; the procedural canvas sprites (FPS nameplates and light-pool blob, KART
   number roundels, and KART's `cloudTexture()` / `radialTexture()` in `render.ts`); the vertex
   colour attributes of the materials named above. These already exist; tuning them is not "adding
   post-processing" or "adding textures". **Do not add new ones.**
7. **`mix()` and `composite()` from `@platform/shared`** — the ONLY sanctioned way to produce a
   colour that is not a literal palette entry, and only for **atmospheric perspective** (fading a
   far tier toward the fog) and for verifying contact-shadow composites. Both endpoints must be
   palette entries, so the result stays traceable. Anything else is an ad-hoc hex.
8. **2D surfaces (CSS) may use gradients, box-shadows, borders and filters.** The "no textures / no
   post-processing" rules describe the 3D render path; they are not a ban on CSS depth. BANK's rail
   and dice bevels are expected to be CSS gradients and shadows.

---

## §1 — THE VALUE LADDER LAW (universal, all three games)

**This is the root cause of the current look and the highest-value fix in the build.**

Today every 3D frame is a monochrome soup. Measured:

| Map | Ground | Main wall | Verdict |
| --- | --- | --- | --- |
| Crossfire | `concrete #8d8d83` | `concrete #8d8d83` | **identical hex** |
| Urbana | `plaster #d8cfc0` (L≈83) | `brick #9b5a4a` (L≈47) | **inverted** — floor brighter than walls |
| Dustbowl | `dust #b09a6a` (L≈63) | `sand #cbb678` (L≈73) | 10 L apart, same hue — soup |
| Frostbite | `snowShadow` | `concrete` | flat |

A frame with a 10-point value spread cannot read as anything but unfinished, no matter how much
geometry you add. **Fix the ladder first; everything else is secondary.**

### The law — every 3D scene MUST satisfy all four

Let **L** = perceptual lightness (CIE L*, 0–100), from `L()` in `@platform/shared`
(`platform/shared/src/color.ts`), alongside `hue()`, `saturation()`, `hueSplitOk()`, `mix()` and
`composite()`.

- **L1 — GROUND SEPARATION.** `L(mainWall) − L(ground) ≥ 20`, where **`mainWall` is the single
  material named as the L1 reference in §3a** — not every material present. Floors are the darkest
  large surface. A floor may never be lighter than the walls it meets.
- **L2a — WALL PLINTH.** A wall's plinth is `≥ 8 L` below **that wall's own material**. Keyed by
  the wall, so `CONTACT_MAT` can express it. Where a material is already at the bottom of its
  ladder the table returns `null` and `articulate()` emits no plinth — a zero-contrast plinth is
  worse than none.
- **L2b — PROP CONTACT SHADOW.** Under every prop and character, the **alpha composite** of the
  shadow over the ground is `≥ 8 L` below the ground — verify with `composite()`, not the raw hex.
  `composite()` blends in **linear light**, as three.js does; an 8-bit sRGB lerp overstates the
  darkening by ~13 L* and will tell you a failing shadow passes.
  Exempt where the ground is below `L 20` (Bunker only): no alpha can darken a near-black floor,
  and grounding is carried by plinth geometry instead.
  *(These two were a single incoherent rule in the first draft — it defined the band relative to
  the ground but keyed the table by the wall, and failed on 4 of 6 maps. Do not merge them again.)*
- **L3 — TRIM LIFT.** Trim, cornices and sun-facing detail sit `≥ 8 L` **above** the material they
  trim, so articulation reads at distance. `null` at the top of a ladder, same rule as L2a.
- **L4 — HUE SPLIT.** `|hue(ground) − hue(mainWall)| ≥ 25°`, **or** the ground is ≥ 15 saturation
  points less saturated. Warm architecture ⇄ cooler ground, or the reverse.
  **Monochrome exemption:** a map declared monochrome-by-design in §3a (Frostbite, Bunker) is
  exempt from L4 provided it clears `L1 ≥ 28`. Snow and concrete bunkers genuinely are one hue;
  there, value does the work that hue does elsewhere. No other map may claim this.

- **S4 — GROUND ≠ HORIZON.** A map’s `theme.ground` must not be the same hex as `theme.horizon`.
  Identical values collapse the ground plane into the backdrop and erase the horizon line.

- **L5 — BRIGHTNESS FLOOR (readability).** No map may set a ground below `L 22`, and no L1
  reference wall below `L 30`. The ladder law sets a floor on *contrast* but originally set no
  ceiling on *darkness*, and the first fan-out crushed half of Crossfire to near-black — in a
  competitive shooter that is a gameplay regression, not a mood choice. **Readability wins every
  tie.** Enforced by `valueLadder.test.ts`.

- **L6 — SILHOUETTE SEPARATION (judge axis, NOT yet a frozen rule).** A team colour should clear the
  ground and the main wall it is seen against by `>= 18 L` **or** `>= 30°` of hue. Measured today,
  **6 of 12 map/team pairs fail**: `ctBlue` sits 4–10 L* and ~8° from the cool grey floors
  (tarmac, carpet, metalDeep), and `tAmber` is warm-on-warm against sand and plaster. This is a
  PRE-EXISTING weakness, not a regression from this round. It is deliberately **not** frozen as a
  test, because satisfying it requires re-tuning `ctBlue`/`tAmber` themselves — a palette change
  that ripples into nameplates, HUD, minimap and killfeed, and that must not be rushed. The
  art-director judge scores it and reports the gap; fixing it is a scoped follow-on.

### Sky law

- **S1 — ZENITH SEPARATION.** The sky dome's zenith stop must be **cooler and ≥ 12 L darker** than
  its horizon stop. "Cooler" means a higher blue-minus-red bias — use `blueBias()` / `isCooler()`
  from `@platform/shared`, which is exactly what the gate checks. A flat sky wash is a fail. `MapTheme` gains a `skyHigh` field for this.
- **S2 — FOG MATCH.** Fog colour matches the *horizon* stop, never the zenith.
- **S3 — NO FLOATING DIAMONDS.** The pale diamonds in the FPS sky are **not** clouds or confetti:
  they are the **skyline ring's tips** poking over their own front ranks (`mapRenderer.ts`
  `buildSkyline()`, fed by `SkylineDef` in each map). A runtime workaround, `stripSkylineCaps()` in
  `scene.ts`, currently deletes offending triangles.

  **That workaround is a landmine and must be removed.** It deletes any triangle whose centroid is
  above `y 5.5` beyond `r 36` from **every mesh with `castShadow && receiveShadow`** — and `bake()`
  sets both flags on everything. Any new cloud band or layered skyline built this round would be
  **silently eaten**, producing an empty sky with no error to diagnose. Assignments:
  - **F7** deletes `stripSkylineCaps()`, its `SKYCAP_*` constants and its call site. Nothing else
    may depend on it.
  - **F1–F6** retune each map's `SkylineDef` height band so tips no longer breach the skyline.
  - **F8** — and only F8 — builds the replacement: two layered cloud bands, flattened, clustered,
    horizon-hugging, with the far tier faded toward the fog colour via `mix()`.

### Enforcement — a test, not an opinion

`games/fps/shared/src/valueLadder.test.ts` (plus KART and BANK equivalents) asserts L1, L2a, L3, L4,
S1 and S2 over every palette tier and every `MapDef.theme`, and runs in `npm test`. **It is part of
every task's gate.** Reviewers additionally check L2b composites and S3 by reading the code.

A violation is a `major` finding. Do not argue aesthetics with the ladder — hit the numbers, then
art-direct inside them. If a number is unreachable, that is a contract gap: report it, do not
weaken the test. **No implementer may edit the ladder tests.**

#### The freeze baseline: 17 assertions are RED on purpose

At freeze the suite is **221 passed / 17 failed**. Every failure is a per-map theme or `floorMat`
value in `games/fps/shared/src/valueLadder.test.ts`, and every one is **F1–F6's assigned work**:

| Map | Failing |
| --- | --- |
| dustbowl | L1, L4, S2 — `floorMat` is `sand`, the same MatId as its main wall (ladder = 0.0); §3a says `dust` |
| crossfire | L1, L4 — `floorMat` is `concrete`, the same MatId as its main wall (ladder = 0.0); §3a says `tarmac` |
| office | S1 |
| frostbite | L1, L4-exempt, S1, S2, S4 — `floorMat` is `snow`, the same MatId as its main wall; §3a says `snowShadow` |
| urbana | S2, S4 |
| bunker | L1, L4-exempt, S1, S2 — `floorMat` should be `metalDeep`, not `metalDark` |

All 17 are reachable inside the frozen palette — this is tuning, not a contract gap.

**Gate rule.** F1–F6 gate on *their own map's assertions going green*. **Every other task gates on
"no NEW failures versus this 17-failure baseline"**, plus green typecheck and build. Do not "fix" a
failure belonging to another map.

**Known flaky test, not yours:** `games/fps/server/src/game.test.ts` "GameRoom armor absorb" fails
roughly 1 run in 3 with "no hit landed within the tick budget". It fails identically at the parent
commit and predates this work. **Ignore it; do not fix it.**

---

## §2 — PALETTE SOURCES OF TRUTH (architect-owned; implementers consume, never edit)

| Game | File | Status |
| --- | --- | --- |
| FPS | `games/fps/shared/src/palette.ts` | rewritten with value tiers |
| FPS | `games/fps/shared/src/matColors.ts` | **NEW** — `MatId → hex`, moved out of `mapRenderer.ts` |
| KART | `games/kart/shared/src/palette.ts` | rewritten with value tiers |
| BANK | `games/bank/shared/src/palette.ts` | **NEW** — was CSS-only, now a real palette |

**Tier naming, consistent across all three palettes:**

| Suffix | Role | Relative L |
| --- | --- | --- |
| `…Lit` | trim, cornices, sun-hit detail | base **+8 or more** (hard floor) |
| *(base)* | main wall / body surface | — |
| `…Dark` | secondary surface, shaded planes | descriptive: a visible step down |
| `…Deep` | **contact band**, plinths, crevices | base **−8 or more** (hard floor) |

Only the two **hard floors** are enforced, because they are what L2a and L3 actually depend on. The
`…Dark` band is guidance. (The first draft specified narrow ranges for all four and then violated
them 15 times — a header that states a law the file breaks is worse than no header.)

Colours are consumed by name. If you need a value you cannot name, you have found a contract gap —
**report it, do not invent a hex.**

---

## §3 — STRICKEN (FPS) art direction

**Mood target:** the same tactical low-poly game, but shot at golden hour by someone who understands
value structure. Chunky, readable, grounded, with real depth cueing. Competitive clarity still wins
every tie: enemies must pop harder after this pass, never less.

### 3a. Per-map ladder assignments (apply the §1 law; these are the intended reads)

| Map | Ground | Main wall | Contact band | Hue split |
| --- | --- | --- | --- | --- |
| Dustbowl | `dust` (dropped + cooled) | `sand` (lifted) | `sandDeep` | warm sand walls ⇄ cooler packed-earth ground; **violet-cool zenith** over warm dusk horizon — this pairing is the map's signature |
| Crossfire | `tarmac` (**new** — must stop being `concrete`) | `concrete` | `concreteDeep` | cool tarmac ⇄ warm-neutral concrete + rust accents |
| Office | `carpet` (darkened) | `plaster` | `carpetDeep` | cool blue-grey carpet ⇄ warm plaster; screens are the only saturated light |
| Frostbite | `snowShadow` (dropped) | **`snow`** is the L1 reference — `concrete` is NOT a main wall here (it is 13 L *below* the ground and would recreate the Urbana inversion); use `rock`/`rockDeep` as the dark anchor for masses only | `snowDeep` | **monochrome by design** — exempt from L4, must clear `L1 ≥ 28` |
| Urbana | `tarmac` (**stop using `plaster`** — the inversion) | **`plaster`** is the L1 reference; `brick` is a secondary facade mass and must still clear `tarmac` by 20 | `plasterDeep` / `brickDeep` | cool street ⇄ warm plaster/brick facades |
| Bunker | `metalDeep` | `concreteDark` | `metalDeep` | **monochrome by design** — exempt from L4, must clear `L1 ≥ 28`. Carry interest with **saturated skylight shafts** and warm emergency accents against cold concrete. Also L2b-exempt: the floor is below L 25, so props are grounded by geometry, not by shadow quads |

### 3b. Wall articulation — the second-biggest lever

Every wall over 3 m long currently renders as one flat untextured quad. That, more than anything
else, is what reads as blockout. Every such wall gets, via the frozen `articulate()` helper:

- a **plinth** (0.25–0.4 m tall, `…Deep`, proud by 0.04 m) — satisfies L2 and kills the floating look;
- a **cornice / cap** (0.15–0.25 m, `…Lit`, proud by 0.06 m) — catches the sun, satisfies L3;
- **pilasters** every 4–6 m (0.3 m wide, proud by 0.05 m, alternating `…Dark`) — breaks the span and
  self-shadows;
- a **mid rail** on walls above 4 m.

Budget: **+8–20 primitives per long wall.** All of it is baked by `bake()`, so it costs draw calls
nothing. Openings (doors, windows) get a **reveal frame** in `…Lit`.

### 3c. Per-asset detail budgets (raise density; "detailed" is a banned brief)

| Asset | Now | Target | Required specifics |
| --- | --- | --- | --- |
| Soldier | ~30 prims, flat single-colour limbs | **45–60** | value break every limb (thigh `…Dark` vs shin base); helmet gets a brim + strap + rear counterweight; chest rig gets 3 discrete pouches + 2 straps; boots get a sole in `…Deep`; knee + elbow pads; a shoulder patch in team colour; **keep the contact-shadow disc and darken it to L2** |
| Viewmodel weapons | near-black blobs | **25–40 each** | mandatory three-value break: body `metalDark`, upper receiver/slide `steel`, furniture `wood`/`charcoal`; add sights (front post + rear notch), a charging handle, a mag well lip, sling loops, an ejection port. **A weapon that is one flat colour fails review.** |
| Crate / barrel / pallet | 1–4 prims | **8–16** | crates get corner braces + a lid seam + a stencil plate; barrels get 2 rims + a bung + a `…Deep` base ring; pallets get visible slats |
| Skyline ring | flat silhouettes | layered | **two depth tiers**, the far tier desaturated toward the fog colour — atmospheric perspective is free depth |
| Sky | flat wash + confetti diamonds | 3-stop + clouds | delete the diamonds (S3); add 2 layered cloud bands, flattened and clustered |
| Deco density | sparse; large empty floors and walls | **+60–100%** | dead corners and long blank walls get the most dressing; lanes stay clear (`minSpacing` respected, non-collidable) |

### 3d. Lighting

Shadow map **2048 → 4096** with the frustum tightened to the actual map bounds (the current
`SHADOW_EXTENT=40` over-covers small maps and wastes texels — that is why shadows read mushy).
Re-balance `hemiIntensity` **down** on outdoor maps: it is currently so high that the sun's shadows
barely register. Give the hemisphere a **cool sky tint and a warm ground tint** — free hue split (L4)
on every surface for zero cost. Keep the min-ambient floor: players stay clearly lit.

---

## §4 — KART GP art direction

**Mood target:** bright, crisp arcade racer — Mario Kart / Horizon Chase clarity. The track must
read as a ribbon through a *place*, not a black stripe on green paper.

| Problem now | Required fix |
| --- | --- |
| **Grass is one flat uniform saturated green** across the whole world — the single worst thing in KART | Break it up: a second and third green tier in patches, mown-stripe bands along the track, dirt/wear at the track edge, scattered geometry detail. No large surface may be one uncut colour. |
| Road is a uniform black ribbon | Add a centre crown value break, longitudinal seams, patch repairs in `asphaltLight`, darkened racing-line wear, and a **`…Deep` shoulder band** where road meets grass (L2). |
| Terrain hills are flat lit silhouettes | Value-tier the ridgelines by distance and desaturate the far tier toward fog — atmospheric perspective. |
| Trees read as broccoli | 3 species exist; give each a two-tier canopy (`treeLeaf` + `treeLeafLight`), vary scale ±30 %, and cluster organically instead of scattering evenly. |
| Grandstand has **no crowd** | Populate it: instanced/baked low-poly spectator blocks in varied palette colours. An empty stand reads as a dead world. |
| Kart is low-contrast at distance | Value break the body vs floor tray vs pods; darken tyres to `tire`; add a `…Deep` under-shadow band. Driver gets a helmet visor + a colour-matched suit. |
| Sky | Apply S1/S2 — cooler, darker zenith; fog matched to horizon. Improve the cloud layers. |
| HUD (`style.css`) | Flat grey boxes. Give panels depth (borders, inner shadow, better hierarchy), tighten typography, keep it readable at speed. |

---

## §5 — BANK art direction

**Mood target:** a real casino table you would sit down at — warm felt, weighty gold, chips with
heft. Currently handsome but **compositionally broken**.

| Problem now | Required fix |
| --- | --- |
| **The bottom ~35 % of the viewport is dead black space** — the layout does not fill the screen. This is BANK's single biggest flaw | Rebalance the composition to fill the viewport: centre the table vertically, give the log a real home, scale the rail up. |
| Table is a rounded rect floating on near-black | Give it a surround: a wood/leather rail ring, an inner felt gradient with a stitched edge line, and a grounded drop shadow. |
| Dice are flat white with a soft shadow | Add bevelled edges, pip depth, a warmer cream face, and a proper contact shadow that tracks the roll. |
| Player chips are small and low-hierarchy | Enlarge; make "current turn" unmistakable (not colour alone — see accessibility); show banked totals with real typographic weight. |
| Event log is unstyled text in the void | Give it a panel, per-event-type accents, and entry animation. |
| No palette source of truth; hardcoded hex in `dice.ts` and `game.ts` | All colour moves to the **new** `games/bank/shared/src/palette.ts`, mirrored to CSS custom properties. |

**Accessibility:** never encode meaning in colour alone — current turn, banked and busted states each
need a second cue (icon, weight, border, position).

---

## §6 — THE BAR

Each game runs its own **capture → art-director judge → fix** loop, bounded by the bar, not by a
round count. Per-axis scores of **≥ 8/10** on: composition, colour cohesion, value structure,
world density, lighting/mood, silhouette readability, and absence of programmer-art smells.

Explicitly **out of scope this round** and not a valid finding: missing SSAO/bloom/post-processing,
missing textures, missing PBR, missing vertex AO. The judge is told the envelope so it grades what
the build can actually change. **Camera framing and FOV are fixed** (they live in
`clientGame.ts`, unowned this round) — the judge may not fault composition for framing it cannot
change; it grades what is *inside* the frame.

### S1 — `scripts/capture-visuals.mjs` spec (this is the task brief)

Reuse the proven pattern in `scripts/e2e.mjs`: `npm run build`, spawn
`platform/server/dist/server.js` on `E2E_PORT`, drive with Puppeteer, screenshot, kill the server.
Viewport **1600×900**, `deviceScaleFactor: 1`. Write to `screenshots/vN/<name>.png`. Print a JSON
manifest of `{name, game, file}` on stdout so the judge loop can pair shots to owners.

Required shot list — **31 shots**:

| Prefix | Shots |
| --- | --- |
| `launcher` | the `/` page (P1) |
| `fps-<map>-{a,b,c}` | all **6 maps** × 3 poses: a long sightline down the main lane, a close-up on an articulated wall + prop cluster, and a low angle toward the sun. **18 shots** — this is the core of the FPS judgement |
| `fps-char` | two soldiers at ~8 m, one CT one T, viewmodel in frame |
| `fps-hud` | live round HUD |
| `fps-buy` | buy menu |
| `fps-scoreboard` | scoreboard overlay |
| `kart-{grid,chase,corner}` | grid at countdown, chase cam at speed on a straight, mid-drift through a corner with FX |
| `kart-{hud,results}` | HUD at speed, results table |
| `bank-{table,roll,results}` | table mid-round, dice mid-roll, match-end banner |

If a shot cannot be produced, **fail loudly** — a missing shot is a hole in the judgement, and a
harness that silently skips is the "gate that scores nothing" this contract exists to prevent.

---

## §7 — FILE OWNERSHIP (disjoint; no file appears twice)

Architect-owned, **frozen before fan-out**, editable by nobody else:
`games/fps/shared/src/palette.ts`, `games/fps/shared/src/matColors.ts`,
`games/fps/shared/src/maps/types.ts`, `games/fps/client/src/contract/visual.ts`,
`games/kart/shared/src/palette.ts`, `games/bank/shared/src/palette.ts`,
`platform/shared/src/color.ts`, `platform/shared/src/index.ts`,
the `valueLadder.test.ts` files, `vitest.config.ts`, `CONTRACT.md`, `STYLE_BIBLE.md`,
and this document.

| ID | Owns (exclusive) |
| --- | --- |
| F1–F6 | `games/fps/shared/src/maps/{dustbowl,crossfire,office,frostbite,urbana,bunker}.ts` |
| F7 | `games/fps/client/src/render/scene.ts` |
| F8 | `games/fps/client/src/render/mapRenderer.ts` |
| F9 | `games/fps/client/src/render/playerModels.ts` |
| F10 | `games/fps/client/src/render/viewModel.ts` |
| F11 | `games/fps/client/src/render/effects.ts` |
| F12 | `games/fps/client/src/ui/hud.ts` |
| F13 | `games/fps/client/src/ui/menus.ts` |
| K1 | `games/kart/client/src/render.ts` |
| K2 | `games/kart/client/src/trackMesh.ts` |
| K3 | `games/kart/client/src/kartMesh.ts` |
| K4 | `games/kart/client/src/fx.ts` |
| K5 | `games/kart/client/src/style.css` + `games/kart/client/index.html` |
| K6 | `games/kart/client/src/app.ts` — **DOM structure and inline-style removal only.** Owns ~60 HUD/lobby/results class names and 24 JS-set inline styles that currently override any CSS K5 writes. Class names frozen in §9 |
| K7 | `games/kart/client/src/main.ts` — mirror `KPAL` into CSS custom properties at boot |
| B1 | `games/bank/client/src/style.css` + `games/bank/client/index.html` |
| B2 | `games/bank/client/src/game.ts` (DOM structure only — class names frozen in §8) |
| B3 | `games/bank/client/src/dice.ts` |
| B4 | `games/bank/client/src/main.ts` — mirror `BPAL` into CSS custom properties at boot, per `BPAL_CSS_VARS` |
| F14 | `games/fps/client/src/main.ts` + `games/fps/client/src/style.css` + `games/fps/client/index.html` — complete the PALETTE→CSS-var mirror (`--c11-accent` is consumed but never set, so `style.css` silently falls back to a hardcoded hex) and remove the fallback literals |
| P1 | `platform/server/src/index.ts` — the launcher page at `/`, the product's front door. Its HTML/CSS is inlined here with 7 raw hex literals and is currently owned by nobody |
| S1 | `scripts/capture-visuals.mjs` (new) — spec in §6. Also owns `scripts/screenshot.mjs` (an existing 1600×900 Puppeteer helper): reuse or supersede it, do not silently duplicate it |

### Seam rules (read the one that names you)

1. **Sky — there are TWO domes, and only one of them is visible.** `mapRenderer.makeSkyDome()`
   builds a 2-stop vertex-gradient dome; `scene.ts`'s rig then builds its own opaque 3-stop shader
   dome that **covers it** (see the comment at `scene.ts:373`). Any sky work F8 does on the
   mapRenderer dome is invisible.
   - **F7 owns the visible sky**: the rig dome shader, the sun disc, lighting and fog.
   - **F7 must make `theme.skyHigh` actually do something.** It is currently **dead data** — all six
     maps set it, `valueLadder.test.ts` asserts S1 on it, and *no renderer reads it*: the rig dome
     hardcodes `PALETTE.fogDay / skyDay / paper` in its uniforms. Until F7 wires the zenith stop to
     `theme.skyHigh` (and the horizon stop to `theme.horizon`), **S1 is a gate that scores nothing.**
     This is the single highest-priority item in F7's brief.
   - **F8 owns the cloud bands and the layered skyline ring**, and must either delete the now-covered
     `makeSkyDome()` or leave it strictly alone — not "improve" it, since nobody will ever see it.
   - F7 must delete `stripSkylineCaps()` (§1 S3) — until it is gone, F8's clouds are deleted at
     runtime with no error.
2. **Articulation is F8's alone.** §3b trim is implemented **exclusively** in `mapRenderer.ts` by
   calling `articulate()`. **F1–F6 must NOT express trim as extra `BoxDef`s.** `MapDef.boxes` is
   the SERVER's collision source (`games/fps/server/src/game.ts`), so trim authored as map data
   becomes solid world geometry and silently changes gameplay. F1–F6's role in §3b is limited to
   `floorMat`, `theme` and `MatId` choices.
3. **Weapons.** `makeWeaponModel` lives in F10's file and is imported by F9. F10 owns the geometry;
   F9 owns only how it is attached.
4. **BANK.** B1 owns all CSS and colour; B2 owns DOM structure and may **add** classes from the §8
   list but never rename or remove one. B3's `bd3d-*` classes are B3's alone — B1 must not style
   them. B4 owns the palette→CSS mirror; B1 writes `:root` fallbacks that must match `BPAL`.
5. **KART.** K5 owns all CSS; K6 owns DOM structure and **must strip the inline styles in
   `app.ts`** or K5's rules lose the cascade. K7 owns the palette→CSS mirror. K1 owns
   `render.ts` including its `mat()` factory and the material handed to K2 as `MatFn` — K2 consumes
   it and must not build its own materials.
6. **Boot-guard background.** Each client `index.html` carries an inline `<style>` with the pre-boot
   page colour (a raw hex). Its owner (F14 / K5 / B1) must keep it equal to that game's `:root`
   page background, or the pre-boot flash will diverge from the app.
7. **Palette `:root` fallbacks.** §0 bans ad-hoc hex outside the palette files. The one exception:
   `:root` declarations in `style.css` that mirror a palette entry exactly, in B1/K5 only, kept in
   sync with B4/K7's runtime mirror. Any other literal is a violation.

---

## §8 — BANK DOM CLASS CONTRACT (frozen)

B1 (`style.css`) and B2 (`game.ts`) run in parallel and are coupled only through these names. B2 may
add new elements using the **reserved** names below; B1 styles every name here. **Neither may rename
or delete an existing class** — that is the whole reason this list exists.

**Existing — must keep working:**
`hidden` · `screen` · `menu` · `menu-title` · `menu-sub` · `menu-notice` · `menu-name` ·
`menu-options` · `menu-actions` · `menu-code` · `menu-code-input` · `menu-rooms-title` ·
`menu-rooms` · `room-empty` · `room-row` · `room-title` · `room-label` · `room-meta` · `btn` ·
`btn-gold` · `btn-small` · `table` · `table-top` · `table-round` · `table-variant` ·
`table-invite` · `table-invite-code` · `felt` · `pot-label` · `pot-value` · `pot-flash` ·
`dice-area` · `timer-bar` · `timer-fill` · `low` · `player-rail` · `player-chip` · `current` ·
`you` · `offline` · `player-name` · `player-you` · `player-score` · `player-banked` · `on` ·
`table-actions` · `btn-roll` · `pulse` · `btn-bank` · `event-log` · `log-line` · `table-banner` ·
`banner-win` · `error-banner`
Dice-internal (owned by B3, styled in `dice.ts`, **B1 must not style these**):
`bd3d-dice` · `bd3d-row` · `bd3d-die` · `bd3d-face` · `bd3d-pip`

**Reserved for this upgrade** — B2 may emit them, B1 must style them:
`table-stage` (the viewport-filling wrapper that fixes the dead-space flaw) · `felt-rail` ·
`felt-inner` · `felt-stitch` · `log-panel` · `log-title` · `log-kind-roll` · `log-kind-bank` ·
`log-kind-bust` · `log-kind-join` · `player-avatar` · `player-state` · `chip-stack` ·
`banner-lose` · `banner-sub`

**Inline-style hazard.** `menu-options`, `table-variant`, `table-invite` and `table-invite-code` are
currently styled **100 % from JS inline styles** with no CSS rules, so B1's rules will silently lose
to them. B2 must strip those inline styles and B1 must add real rules for all four — coordinate
through this clause, not with each other.

**JS-driven properties that must keep working:** `.timer-fill { width }` (set every 100 ms) and the
public-room `.room-row` hover handlers.

---

## §9 — KART DOM CLASS CONTRACT (frozen)

K5 (`style.css`) and K6 (`app.ts`) run in parallel and are coupled only through these names. K6 may
add elements using the **reserved** names below; K5 styles every name here. **Neither may rename or
delete an existing class.**

### Structure

Two sibling `screen` divs are appended to `#app`. Visibility is `classList.add/remove('hidden')` on
`.screen.menu` / `.screen.race` (`showMenu` 1823, `showRace` 1831); every in-race overlay is toggled
once per frame in `updateHud` (1563). No element has an `id`. All elements come from the factory
`el(tag, className?, text?)` at **app.ts:419-428** — it assigns `node.className` wholesale, so
multi-class strings like `'screen race hidden'` are literal.

```
div.screen.menu
  h1.menu-title · p.menu-sub · div.menu-notice(.hidden) · input.menu-name
  div.menu-actions > button.btn.btn-gold ×1, button.btn ×2
  div.menu-code   > input.menu-code-input, button.btn
  label.menu-kids > input[checkbox], span.menu-kids-label
  h2.menu-rooms-title
  div.menu-rooms  > div.room-empty | div.room-row > span.room-title, span.room-label, span.room-meta

div.screen.race(.hidden)
  canvas.race-canvas
  div.race-top > button.btn.btn-small
  div.hud(.hidden)
    div.hud-left
      div.hud-pos > div.hud-pos-main > span.hud-pos-num, span.hud-pos-suf, span.hud-pos-total
                  > div.hud-pos-gap(.hud-pos-leader)
                  > div.hud-kids(.hidden)
      div.hud-lap
      [div.race-invite parks here during countdown/racing]
    div.hud-right
      div.hud-speed > div.hud-gear-row  > span.hud-gear-label, span.hud-gear
                    > div.hud-speed-row > span.hud-speed-num, span.hud-speed-unit
      canvas.hud-minimap
    div.hud-times > div.hud-time-row ×2 > span.hud-time-label, span.hud-time-value(.hud-best)
    div.hud-nitro > div.hud-turbo-label
                  > div.hud-nitro-pips > span.hud-nitro-pip ×NITRO_CHARGES (.pip-flash)
    div.hud-gate-wrap(.hidden) > div.hud-gate, div.hud-gate-label
  div.lobby-overlay(.hidden) > div.lobby-panel
      div.lobby-title · div.lobby-players > div.player-chip(.you) > span.player-color,
        span.player-name > span.player-you, span.player-slot
      div.lobby-status · div.lobby-hint
  div.hint-card(.hidden) · div.countdown-overlay(.hidden) · div.race-msg(.hidden)
  div.race-invite(.hidden) > span.race-invite-code, button.btn.btn-small
  div.results-overlay(.hidden) > div.results-panel
      div.results-title
      table.results-table > thead > tr > th ×4 (no class) ; tbody > tr(.you) >
        td.result-place, td.result-name, td.result-time, td.result-best
      div.results-note
  div.fx-speedlines > div.fx-speedline ×N   (built by fx.ts:230-244 into .race)
body > div.error-banner                     (main.ts:11, boot failure only)
```

**Conditional classes.** `hidden` on: `.menu-notice` (1860) · `.lobby-overlay` (1566) · `.hud`
(1567) · `.results-overlay` (1571) · `.countdown-overlay` (1586) · `.race-msg` (1589) ·
`.hint-card` (1596) · `.hud-kids` (1639) · `.hud-gate-wrap` (1683) · `.race-invite` (1934) ·
`.screen.menu`/`.screen.race` (1825-1834). Also `hud-pos-leader` on `.hud-pos-gap` when place === 1
(1631/1637) · `you` on `.player-chip` (1896) and results `tr` (1914) · `pip-flash` re-added to the
just-spent `.hud-nitro-pip` with a forced reflow (1668-1670).

**Canvases.** `canvas.race-canvas` — the Three.js target. `canvas.hud-minimap` — 2D, backing store
`MINIMAP_SIZE*2`, redrawn at 4 Hz by `drawMinimap` (1702). Offscreen texture canvases in `fx.ts:95`,
`render.ts:192/211`, `kartMesh.ts:87` are not in the DOM.

### Existing — must keep working

`hidden` · `screen` · `menu` · `menu-title` · `menu-sub` · `menu-notice` · `menu-name` ·
`menu-actions` · `menu-code` · `menu-code-input` · `menu-kids` · `menu-kids-label` ·
`menu-rooms-title` · `menu-rooms` · `room-empty` · `room-row` · `room-title` · `room-label` ·
`room-meta` · `btn` · `btn-gold` · `btn-small` · `race` · `race-canvas` · `race-top` · `hud` ·
`hud-left` · `hud-right` · `hud-pos` · `hud-pos-main` · `hud-pos-num` · `hud-pos-suf` ·
`hud-pos-total` · `hud-pos-gap` · `hud-pos-leader` · `hud-kids` · `hud-lap` · `hud-speed` ·
`hud-gear-row` · `hud-gear-label` · `hud-gear` · `hud-speed-row` · `hud-speed-num` ·
`hud-speed-unit` · `hud-minimap` · `hud-times` · `hud-time-row` · `hud-time-label` ·
`hud-time-value` · `hud-best` · `hud-nitro` · `hud-turbo-label` · `hud-nitro-pips` ·
`hud-nitro-pip` · `pip-flash` · `hud-gate-wrap` · `hud-gate` · `hud-gate-label` · `lobby-overlay` ·
`lobby-panel` · `lobby-title` · `lobby-players` · `lobby-status` · `lobby-hint` · `player-chip` ·
`player-color` · `player-name` · `player-you` · `player-slot` · `you` · `hint-card` ·
`countdown-overlay` · `race-msg` · `race-invite` · `race-invite-code` · `results-overlay` ·
`results-panel` · `results-title` · `results-table` · `result-place` · `result-name` ·
`result-time` · `result-best` · `results-note` · `error-banner`

FX-internal (owned by `fx.ts`, styled in `style.css` §speed-lines — **K6 must not emit these**):
`fx-speedlines` · `fx-speedline`

**No CSS rule today** — K5 must add rules; these currently render unstyled or inline-only:
`menu-kids` · `menu-kids-label` · `race-invite` · `race-invite-code` · `result-name` ·
`result-time` · `result-best`

### Reserved for this upgrade

K6 may emit, K5 must style: `hud-chip` (shared chip surface under pos/lap/times/nitro) ·
`hud-chip-lo` · `hud-chip-hi` (two-tier value ladder) · `hud-scrim` (corner gradient so chips read
over any track) · `hud-corner-tl` · `hud-corner-tr` · `hud-corner-bl` · `hud-corner-br` ·
`hud-rule` (hairline divider) · `hud-pos-crown` (P1 accent) · `hud-speed-bar` (meter fill) ·
`hud-nitro-pip-full` (lit pip — replaces the inline opacity write) · `race-invite-chip` (real pill
class replacing the inline block) · `results-row-you`.

### Inline-style hazard

24 JS-set inline styles in `app.ts` beat any stylesheet rule. K6 strips all but the data-driven
ones; K5 supplies real rules.

**Strip — pure static styling** (the `.race-invite` block, 816-831): `position` 816 · `top` 817 ·
`left` 818 · `zIndex` 819 · `display` 820 · `alignItems` 821 · `gap` 822 · `pointerEvents` 823 ·
`inviteCodeEl.padding` 825 · `border` 826 · `borderRadius` 827 · `fontSize` 828 · `letterSpacing`
829 · `color` 830 · `background` 831. Plus `row.cursor='pointer'` on `.room-row` 1876.

**Convert to class toggles:** `inviteEl.position` static/absolute per parent 1580 →
parked/floating classes · `gearEl.opacity` upshift flash 1647 → animation class ·
`pip.style.opacity` per pip per frame 1663 → `hud-nitro-pip-full` toggle.

**Keep — genuinely dynamic:** `hintEl.opacity` fade 1600 · `gateEl.transform = rotate(…)` 1692 ·
`sw.style.background = KART_COLORS[…]` 1899. **Transient, out of scope:** clipboard textarea
1958-1959.

Also outside `app.ts`: `fx.ts:237-240` writes `left`/`top`/`transform`/`opacity` on every
`.fx-speedline` — **K5 must not set those four properties on that class.**

---

## §10 — PRECEDENCE (which frozen doc wins)

Three frozen documents now describe this codebase. Where they conflict, precedence is:

**VISUAL_UPGRADE.md  >  STYLE_BIBLE.md  >  CONTRACT.md**

This document is the newest and is scoped to this round. `CONTRACT.md` and `STYLE_BIBLE.md` remain
authoritative for everything this document does not mention — protocol, physics, gameplay, module
boundaries. Do not "fix" this document to agree with them.

### Known live conflicts — resolved here, so nobody has to guess

| Subject | CONTRACT.md says | THIS DOCUMENT SAYS (wins) |
| --- | --- | --- |
| Soldier primitive budget | 22–32, "≤ 28" in the budget table | **45–60** (§3c). F9 builds to the new number. |
| Weapon primitive budget | 6–12 | **25–40 each** (§3c). A weapon that is one flat colour fails review. |
| Deco prop budget | 3–10 | **8–16** (§3c). |
| Directional shadow map | 2048 | **4096 with the frustum tightened to map bounds** (§3d). F7 owns the change; CONTRACT.md's 2048 describes the code *before* this round. |
| `MAT_COLORS` location | `mapRenderer.ts` (C3) | `games/fps/shared/src/matColors.ts`, re-exported by mapRenderer. |
| Sky dome | one 2-stop vertex gradient | **two domes; the rig's 3-stop shader dome is the visible one** (seam rule 1). |

The primitive-budget rows are deliberate: this round exists to raise density, and the old budgets
were written for the build these screenshots came from. **Raising them is the assignment.**

### Performance guard

Higher budgets are not a licence to regress frame time. Everything static still goes through
`bake()`, so added trim and props cost draw calls nothing. The non-functional budgets in
`CONTRACT.md` (target FPS at peak entity count, frame-time ceiling, no per-frame allocation in hot
paths, pooling) are **unchanged and still binding**. If a density increase costs frame time, that is
a finding against the implementer, not a reason to relax §3c.
