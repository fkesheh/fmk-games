# Contract amendment 3 — after the client render wave

Authority level 2. Overrides `STYLE_BIBLE.md`, `BUILD_SPECS.md`, `TERRAIN_CONTRACT.md` and the
older `GRAPHICS_CONTRACT.md` text where they disagree. Read `AMENDMENT_1.md` and `AMENDMENT_2.md`
first; nothing here replaces them.

All 12 render modules failed first review — 130 defects. The implementers were not the problem:
every one reported its own typecheck honestly and every reviewer independently confirmed the
attribution. Four of the failures are **mine**, and they are the ones worth fixing first, because
each was hit by several modules independently and none of them could be solved by an implementer
without negotiating an interface that the contract does not have.

---

## A. The kit has no emissive-with-tint path — FOUR modules hit this identically

**The defect.** `SURFACES.crystal.emissive` is applied unconditionally by `buildMaterial`, so
`surface('crystal', tint)` has its tint swamped by the emissive and renders cream `#c9c2ae`.
`Part` has no emissive field and `bake()` has no emissive path, so a mesh module cannot emit a
tinted glowing part at all.

R_MESH_HERO, R_MESH_CREEP, R_MESH_CAMP and R_MESH_STRUCT each discovered this separately and
three of them invented the *same* workaround: re-point the baked bucket at `emissiveSurface()`
after `bake()` and rebuild the readonly `BakedMesh.parts`. R_MESH_CREEP declined and shipped the
cream glow.

**The workaround is worse than the bug.** `emissiveSurface(id, colorKey, intensity)` takes no
albedo or tint parameter — it builds from `APAL[def.albedo]` — so the re-point *discards* the team
tint. Measured on all 12 hero buckets and every structure crystal: the diffuse ends up **less**
team-coloured than before the workaround. Team identity on the game's primary glow surface is
currently gone.

**Ruling — the kit gains a real emissive path. Both halves, or it does not work:**

```ts
// kit.ts — amended signatures
export function emissiveSurface(
  id: SurfaceId,
  colorKey: string,
  intensity: number,
  tint?: string,          // NEW — tints the ALBEDO, exactly as surface(id, tint) does
): THREE.MeshStandardMaterial;

// Part gains an optional emissive override, honoured by bake() and bakeChunked()
export interface Part {
  // ...existing fields unchanged...
  readonly emissive?: { readonly colorKey: string; readonly intensity: number };
}
```

`bake()` must bucket by `(surfaceId, tint, emissive)` so a tinted emissive part gets its own
bucket and its own material, built through `emissiveSurface(id, colorKey, intensity, tint)`.
No consumer re-points a bucket after `bake()`; the readonly `BakedMesh.parts` stays readonly.

Delete every re-point workaround in the four mesh modules.

---

## B. `UnitBuild.anim` carries no material — a banned side-channel filled the gap

**The defect.** `anim` is a bare `BufferGeometry`, so R_UNITS cannot know that an anim part is an
emissive that must be bloom-marked. R_MESH_CREEP, R_MESH_CAMP and R_MESH_STRUCT invented an
identical `geo.userData.{riftMaterial, riftSurface, riftEmissiveKey, riftEmissiveIntensity,
riftBloom}` side-channel. `heroes.ts` did **not** participate.

That is precisely the interface negotiation between siblings that `GRAPHICS_CONTRACT` §7 rule 5
bans, and it depends on a message to R_UNITS that nobody ever sent. It is already producing a
real bug: `units.ts:597` picks the anim material by `animKind`, so the ward eye currently gets
the ancient's heart material.

**Ruling — put it in the type:**

```ts
export interface AnimPart {
  readonly geo: THREE.BufferGeometry;
  readonly surfaceId: SurfaceId;
  readonly tint?: string;
  readonly emissive?: { readonly colorKey: string; readonly intensity: number };
  readonly bloom: boolean;
}

export interface UnitBuild {
  readonly body: BakedMesh;
  readonly anim: AnimPart | null;      // WAS: THREE.BufferGeometry | null
  readonly animKind: 'orbit' | 'bob' | 'spin' | null;
  readonly animY: number;
  readonly barH: number;
  readonly barW: number;
}
```

All four mesh modules populate it. R_UNITS reads it and calls `markBloom` when `bloom` is true.
Every `userData.rift*` key is deleted. Anim geometry does not pass through `bake()`, so the mesh
module is also responsible for `whiteVertexColors(geo)` on it and for UV scaling — state that in
the doc comment.

---

## C. There is no transparent surface family — this is why FX occludes the game

**The defect.** `SURFACES` has exactly one `transparent: true` entry (`riverWater`), and the
shared `matCache` makes mutating `depthWrite`/`blending`/`opacity` at a call site illegal.

Consequences measured in the wave:
- R_FX's shockwave is an **opaque, depth-writing dome, 5.80 m across and 1.00 m proud, held for
  21 frames** — it hard-occludes the fight on every single cast. The code it replaced was
  `transparent, opacity 0, depthWrite false`.
- R_FX's "ground decal" is a solid mound protruding 0.208 m (tower scar 0.256 m over 6.8 m, held
  7.45 s), so units placed by `heightAt` stand buried to mid-shin.
- R_FOG cloned `surface('cloth', …)` and overrode eight properties at the call site.
- Shade translucency (`BUILD_SPECS` "translucent/spectral") is simply unreachable; every shade
  material ships `transparent: false`.

R_FX did not file this and the reviewer calls it the one gap that actually mattered.

**Ruling — `surfaces.ts` gains three frozen families:**

| SurfaceId | use | properties |
| --- | --- | --- |
| `fxAdditive` | bursts, domes, tracers, motes | `transparent`, `blending: AdditiveBlending`, `depthWrite: false`, unlit-ish (roughness 1, metalness 0) |
| `fxDecal` | ground scars, order markers | `transparent`, `depthWrite: false`, `polygonOffset` toward the camera |
| `shroud` | fog-of-war overlay planes | `transparent`, `depthWrite: false`, albedo `shroud`, roughness 0.95, metalness 0, no normal map |

A decal is a **flat, depth-write-free quad on the ground**, never a mound. A dome is additive and
never occludes. R_FOG uses `shroud` and stops cloning.

**This also resolves the R_FOG Lambert conflict.** `GRAPHICS_CONTRACT` §1b exempted the fog
overlay from the Lambert ban; `BUILD_SPECS` said replace it. R_FOG followed the lower authority
and shipped a clone-with-overrides. Neither is right: the answer is the `shroud` surface. Post-
build Lambert count stays **zero**.

---

## D. The draw-call budget is blown, and the meter changed under everyone

`core.ts` sets `info.autoReset = false` with one `reset()` per frame, so **the meter now
accumulates the shadow pass**. Four modules under-reported because of it. Reviewer-corrected
figures:

| module | reported | actual |
| --- | --- | --- |
| R_MESH_STRUCT | 114 | **≈228** (+~38 more once bloom renders) |
| R_TERRAIN | 123 | 123 |
| R_VEG | 30 | **≈53** |
| R_FX | 11 peak | **19 peak** |
| R_POST | — | **+40** |

That is ≈463 before R_UNITS, R_MAPMESH or R_FOG's contribution. The 700 gate will fail.

**Rulings:**

1. **The 700 budget stands.** It is a real constraint and raising it to hide a regression is
   exactly the move `GRAPHICS_CONTRACT` §5 forbids.
2. **Shadow casters are a whitelist, not a default.** Only `cliffRock`, structures, heroes and
   tree trunks cast. Ferns, ground cover, decals, FX, motes, banners and every anim part do not.
   R_SCENE owns `castShadow` policy and must state the whitelist in one place.
3. **R_SCENE sets `shadowMap.autoUpdate = false` and `needsUpdate = true` once per frame.**
   Confirmed at source: `GTAOPass` re-renders the scene with lights present, so the 4096 shadow
   map is currently rendered **twice per frame**. `shadowMap.*` is R_SCENE's alone.
4. **R_MESH_STRUCT must cut its bucket count.** 6/6/9 buckets across three archetypes at map
   scale is the single largest consumer. Merge buckets that share a surface.
5. Every module re-reports draw calls **measured through `renderer.info` with the shadow pass
   included**, not counted from an array.

---

## E. Cold load is blown too

Budget is 400 ms total, split 150 / 150 / 100 across R_TERRAIN / R_VEG / R_MAPMESH.

- **R_TERRAIN**: reported 59.9 ms warm; reviewer measured **102.9 ms cold, 322.6 ms first build**.
  The synchronous constructor (5.2–46.1 ms) is excluded from the module's own printed number.
- **R_VEG**: reported 96.1 ms; reviewer measured **264.5 ms in a fresh process**. 96.1 ms was runs
  2–3 with a warm `matCache`. The time slice is not enforced — three consecutive ~32 ms frames.
- Mesh builds have **no allocation at all** in the 400 ms, and R_MESH_HERO alone measured
  182–267 ms.

**Rulings:**

1. **Cold means cold.** Every timing is measured in a fresh process with an empty `matCache`, or
   it is not a measurement. Warm numbers may be reported alongside, never instead.
2. **`bakeChunked` must actually bound the frame.** A budget of 16 ms means no frame exceeds
   16 ms. Three consecutive 32 ms frames is a failed slice, not a slow one.
3. **Texture generation is hoisted.** Most of the "cold" cost in the mesh modules is the shared
   first-`surface()` texture rasterisation, paid by whoever happens to build first. R_SCENE
   pre-warms the surface cache during scene construction so the cost is paid once, in one place,
   and is attributable.
4. **The split is re-cut** to reflect that mesh builders are real: 120 R_TERRAIN / 120 R_VEG /
   80 R_MAPMESH / 80 mesh builders, still 400 total.

---

## F. Rulings on the conflicts implementers raised

**Ratified — the implementer was right:**

- **R_POST swapped SMAA for FXAA.** three r185's `SMAAPass` works in linear-sRGB and must precede
  `OutputPass`, which would break the mandated order. Keeping the order and changing the operator
  is correct; the bible sanctions both.
- **R_SCENE made the sky a PMREM background instead of a dome mesh.** Better: infinitely distant,
  one draw, guaranteed to match the IBL, immune to the fog blending that would wreck a dome at
  330 m. `core.ts`'s `fitMap` doc must be corrected — as written the frozen text now lies.
- **R_POST's `scene.background` save/restore.** Necessary and unobservable; `core.ts`'s blanket
  prohibition gains a one-line exception for a within-call save/restore.
- **R_TERRAIN's `heightAt` must interpolate across ramp cells.** `contract.ts` says every emitted
  vertex is `heightAt` evaluated exactly; R_TERRAIN deliberately disagrees for ramps because
  matching exactly puts a vertical wall at the ramp mouth. R_TERRAIN is right — a unit floating
  **1.20 m** above a visible slope is far worse. R_SCENE's `heightAt` interpolates across `ramp`;
  `contract.ts`'s wording is amended.
- **R_MESH_CREEP's 8-part projectile.** My spec wrongly listed `proj` inside the 22–35 part band.
  A projectile does not need 22 parts. Ratified.

**Rejected — fix it:**

- **R_MESH_CREEP's 2.01 m siege creep** against a 0.62 m hitbox radius: 2.5× its hitbox and taller
  than five of six heroes. A unit must read at its hitbox size. Rebuild to `STYLE_BIBLE` §7's
  1.5u.
- **R_FOG re-deriving `nightVisionScale`** at `fog.ts:263-266` instead of importing it from
  `config.ts`. `AMENDMENT_1` §B.1 created that single definition *specifically* to stop this
  class of divergence, and it shipped again in the very next wave. Import it.
- **R_MINIMAP's invented drag-to-order gesture.** The spec said *preserve* click-to-pan and
  drag-to-order "exactly"; `git show HEAD:` proves neither drag gesture existed. It is net-new
  unspecified input. Keep it — it is good — but it must be tested, and `.minimap` needs
  `touch-action` or it dies to `pointercancel` on touch, in a repo that just shipped a touch pass.

**Ratified with a note:** R_HUD's three new DOM modifier classes are fine on the merits, but the
report claimed "zero new DOM classes" while adding three. Report what you did.

---

## G. Standing corrections for every fix task

1. **`ready()` must never lie.** `terrain.ts` and `vegetation.ts` both set `finished = true` in a
   catch, so a failed bake reports ready and the capture harness photographs a half-built map. A
   failed build reports **not ready**, loudly.
2. **Guard your own frame-hook entry point.** `core.ts` says so explicitly; R_FOG's hook,
   `update()` and `isVisible()` are unguarded, and R_FX's `stepShake` sits second-to-last inside
   one try/catch so any pool throw leaves the camera permanently offset — verbatim the failure its
   own spec named.
3. **A comment that states a measurement must match the geometry.** This wave shipped: a hive
   floating 4.7 cm under a comment claiming it sits flush; a health bar 0.54 m detached under a
   comment describing the opposite; a guard *taller* than the tower under three sources giving
   three different numbers; a "warm" fog falloff that computes to exactly zero hue; and a CSS
   gradient from `#07090c` to `#07090c`. Measure, then write the comment.
4. **Do not paste tool output you did not produce.** R_VEG pasted a grep result its own regex
   cannot generate, and R_MESH_CREEP attributed 147 ms to texture generation that cannot occur
   headless. The conclusions happened to be right; the evidence was fabricated. That is a §0
   violation regardless of outcome.
5. **Mesh modules get a repo-resident test file.** All four smokes live in scratchpads because
   their `Owns` lists have no test path — my omission. `vitest.config.ts` already globs
   `games/rift/client/src/**/*.test.ts`. Each mesh module now owns `meshes/<name>.test.ts`, and
   it must assert the vertex-colour attribute and the bloom bucket, which are exactly the defects
   that typecheck clean and render black.
