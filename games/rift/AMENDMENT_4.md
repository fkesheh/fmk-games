# Contract amendment 4 — rulings raised by K_AMEND

Authority level 2. Read `AMENDMENT_1/2/3.md` first. K_AMEND landed §A/§B/§C of amendment 3
cleanly (24/24 mutations RED, all gates green) and correctly refused to invent mechanisms for
five things. Four are mine.

---

## A. `instanceSurface()` — the one legal uncached-material path

**The problem.** Two real needs cannot be met by a shared cached material:

1. **R_FOG's overlay carries per-sheet textures.** Its alpha comes from a `map` and an
   `emissiveMap` that differ between the low and high sheets. One cached `shroud` material
   cannot hold two different maps.
2. **`fxDecal` cannot fade.** Under normal blending, opacity is the only fade channel, and the
   vertex-colour attribute is `itemSize 3` by law, so a decal can currently only be removed or
   scaled — not faded out. A ground scar that vanishes instantly is a worse artifact than the
   mound it replaced.

Both are the same shape: a caller legitimately needs a material instance of its own.

**Ruling.** The kit gains exactly one escape hatch:

```ts
export function instanceSurface(
  id: SurfaceId,
  overrides?: {
    readonly map?: THREE.Texture | null;
    readonly emissiveMap?: THREE.Texture | null;
    readonly opacity?: number;
  },
): THREE.MeshStandardMaterial;
```

It builds through the **same** `buildMaterial` path — same surface definition, same
`vertexColors: true`, same blending/depthWrite/polygonOffset from the table — and returns an
**uncached** instance. Only the three listed channels may be overridden. Nothing else.

Constraints, in the doc comment:
- The caller **owns disposal**.
- Never call it per frame, and never per entity — per *sheet* or per *pool*, which is a small
  bounded number.
- It is not a licence to reintroduce call-site material mutation. Overriding anything outside
  the three channels is still banned; `.clone()`-and-override is still banned.

This makes `AMENDMENT_3` §C's "R_FOG stops cloning" precise: R_FOG stops cloning and stops
overriding blend state. It keeps two materials, because it genuinely has two sheets, and it gets
them from the kit.

## B. `SurfaceDef` gains `fog?: boolean`

The shroud overlay must not itself be scene-fogged, and `SurfaceDef` has no way to say so, so it
is unreachable through the table. Add `fog?: boolean` (default `true`), honoured by
`buildMaterial`. `shroud` and `fxAdditive` set `fog: false`.

## C. `SurfaceDef` gains `castShadow?: boolean` — this implements the §D.2 whitelist

`bakedMeshOf` sets `castShadow = true` unconditionally, so FX, decals and shroud planes baked
through `bake()` all cast shadows. `AMENDMENT_3` §D.2 made shadow casters a whitelist, and the
draw budget depends on it — the meter counts the shadow pass, and we are at ~463 draws against
700 before R_UNITS contributes.

Rather than have every consumer remember, put it in the data: `SurfaceDef.castShadow?: boolean`,
default `true`, and `bake()` honours it. `fxAdditive`, `fxDecal` and `shroud` set `false`.

R_SCENE still owns overall shadow policy and the light rig; this only stops surfaces that must
never cast from doing so by default. Ferns and ground cover remain R_VEG's to opt out per §D.2.

## D. `partMaterial()` is RATIFIED

K_AMEND exported `partMaterial(id, tint, emissive)` beyond the literal amendment text and flagged
it. Keep it. Without it, R_UNITS would re-derive the `surface` vs `emissiveSurface` branch when
mounting an `AnimPart`, which is exactly the second material-construction path the material law
exists to prevent. One resolver, used by `bake()`, `bakeChunked()` and R_UNITS.

## E. The breakage the typechecker will not catch — R_UNITS must be told

`units.ts:597/628` calls `animMatOf(variant.animKind, e.team)`, picking the anim material by
animation *kind*. It never referenced `UnitBuild.anim`'s type, so **it still compiles** — and it
is the reason the ward eye currently renders with the ancient heart's material.

R_UNITS must delete `animMatOf` entirely and use
`partMaterial(anim.surfaceId, anim.tint, anim.emissive)` plus `if (anim.bloom) markBloom(mesh)`.
This is a silent-runtime defect with a clean typecheck: exactly the class this build keeps
producing, so it is called out here rather than left in a diff.

## F. Re-measure bucket counts AFTER this lands, not before

Bucketing is now `(surfaceId, tint, emissive)`, strictly finer than the old `(surfaceId, tint)`.
Correct, but any module that previously got one bucket for a mixed emissive/non-emissive group
now gets two. **R_MESH_STRUCT's bucket-cut task (§D.4) must re-measure after K_AMEND, not
against the pre-amendment numbers.** Every module re-reports draw calls measured through
`renderer.info` with the shadow pass included.
