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
| `vertexColors` on world materials, baked vertex AO | Out of envelope this round. Deliberate — see §6. |
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
6. **Tuning the pre-existing** hand-rolled vignette/grade shader in `scene.ts` and the pre-existing
   procedural canvas sprites (nameplates, light-pool blob, KART number roundels). These already
   exist; tuning them is not "adding post-processing". **Do not add new ones.**

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

Let **L** = perceptual lightness (CIE L*, 0–100). Use the `L()` helper in each palette file.

- **L1 — GROUND SEPARATION.** `L(mainWall) − L(ground) ≥ 20`. Floors are the darkest large
  surface. A floor may never be lighter than the walls it meets.
- **L2 — CONTACT BAND.** Every wall base and every prop base carries a contact band whose colour is
  `≥ 8 L` **below the ground**. This is how objects get grounded without AO. Non-negotiable — it is
  the entire replacement for ambient occlusion this round.
- **L3 — TRIM LIFT.** Trim, cornices and sun-facing detail sit `≥ 8 L` **above** the main wall, so
  articulation reads at distance.
- **L4 — HUE SPLIT.** `|hue(groundFamily) − hue(wallFamily)| ≥ 25°`, **or** the ground is
  ≥ 15 points less saturated. Warm architecture ⇄ cooler ground, or the reverse. A frame where
  every element sits in one 15° hue wedge fails, whatever its value spread.

### Sky law

- **S1 — ZENITH SEPARATION.** The sky dome's zenith stop must be **cooler and ≥ 12 L darker** than
  its horizon stop. A flat sky wash is a fail. `MapTheme` gains a `skyHigh` field for this.
- **S2 — FOG MATCH.** Fog colour matches the *horizon* stop, never the zenith.
- **S3 — NO FLOATING CONFETTI.** The current drifting diamond quads in the FPS sky read as render
  glitches, not clouds. They are **deleted** and replaced with proper layered cloud geometry
  (flattened, clustered, slow-drifting, horizon-hugging).

### Enforcement

Reviewers check L1–L4 and S1–S3 **numerically**, per map and per scene. A violation is a `major`
finding. Do not argue aesthetics with the ladder — hit the numbers, then art-direct inside them.

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
| `…Lit` | trim, cornices, sun-hit detail | base **+8…+14** |
| *(base)* | main wall / body surface | — |
| `…Dark` | secondary surface, shaded planes | base **−12…−18** |
| `…Deep` | **contact band**, plinths, crevices | base **−28…−40** |

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
| Frostbite | `snowShadow` (dropped) | `snow` / `concrete` rock | `snowDeep` | cold blue ground shadow ⇄ near-white lit snow; rock is the dark anchor |
| Urbana | `tarmac` / `concreteDark` (**stop using `plaster`** — the inversion) | `plaster` + `brick` | `plasterDeep` / `brickDeep` | cool street ⇄ warm plaster/brick facades |
| Bunker | `metalDeep` | `concreteDark` | `metalDeep` | near-monochrome by design — carry the split with **saturated skylight shafts** and warm emergency accents against cold concrete |

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
the build can actually change.

---

## §7 — FILE OWNERSHIP (disjoint; no file appears twice)

Architect-owned, **frozen before fan-out**, editable by nobody else:
`games/fps/shared/src/palette.ts`, `games/fps/shared/src/matColors.ts`,
`games/fps/shared/src/maps/types.ts`, `games/fps/client/src/contract/visual.ts`,
`games/kart/shared/src/palette.ts`, `games/bank/shared/src/palette.ts`, this document.

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
| K5 | `games/kart/client/src/style.css` |
| B1 | `games/bank/client/src/style.css` |
| B2 | `games/bank/client/src/game.ts` (DOM structure only — class names frozen in §8) |
| B3 | `games/bank/client/src/dice.ts` |
| S1 | `scripts/capture-visuals.mjs` (new) |

**Seam rules.** F8 owns the sky *dome geometry*; F7 owns the sky *shader and lighting* — F8 must not
add a competing dome. `makeWeaponModel` lives in F10's file and is imported by F9: F10 owns the
geometry, F9 owns only how it is attached. B1 owns all CSS and colour; B2 owns DOM structure and may
**add** classes from the §8 frozen list but never rename or remove an existing one.

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
