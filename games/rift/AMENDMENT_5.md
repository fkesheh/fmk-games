# Contract amendment 5 — rulings raised by R_FX

Authority level 2. Read `AMENDMENT_1`–`4` first. R_FX fixed 11 of 12 defects with 12/12 mutations
RED and correctly refused to invent mechanisms for the rest. Several of its gaps are real, and
one is a contradiction I introduced in amendment 4.

---

## A. `SceneCore.isVisible(x, z)` — the visibility route

**The gap.** R_FX's ambient field draws 88 emissive motes over **unexplored terrain**. It cannot
fix this: `createFx(scene: SceneHandle)` has no route to `FogHandle.isVisible`, and R_FX
correctly declined to negotiate with R_FOG directly (that is the banned sibling negotiation that
already cost this build the `userData.rift*` side-channel).

**Ruling.** `SceneCore` gains `isVisible(x: number, z: number): boolean`, owned by **R_SCENE**,
which delegates to whatever visibility provider is installed. R_FOG installs itself; R_FX and any
other consumer ask the core. No module holds a reference to another module.

Before a provider is installed it returns `true` — fail-visible, never fail-black. The one thing
worse than drawing a mote over unexplored ground is hiding the whole world because a provider
was late.

This is R_FX's own suggested shape and it is the right one.

## B. `SceneCore.timeOfDay(): number` — a getter to match the setter

`SceneHandle.setTimeOfDay` is write-only, so R_FX's ambient field is phase-neutral and cannot be
pollen by day and fireflies by night as `STYLE_BIBLE` §9 asks. Add the getter to `SceneCore`.
Trivial, and it removes a reason for a module to cache a value it does not own.

## C. `instanceSurface`'s disposal obligation is unsatisfiable — my error

Amendment 4 §A says "the caller owns disposal". R_FX correctly points out that `FxHandle` has no
`dispose()` and `SceneCore` has no teardown hook, so the obligation cannot be honoured. I wrote a
contract clause with no mechanism behind it.

**Ruling.** Soften it to match reality: an `instanceSurface` material is expected to live as long
as the scene. The real constraint is the one that matters — **never per frame, never per entity;
per sheet or per pool only** — and that stands. The disposal sentence is struck. If a teardown
hook ever exists, this becomes an obligation again.

## D. R_FX's pool merge is RATIFIED

R_FX collapsed 4 spark pools into 1 and 3 dome pools into 1, sharing one `surface('fxAdditive')`
with per-effect colour on the instance channel — 11 meshes to 6, and 15 accumulated draw calls
saved, which matters against a 700 gate we are close to.

It flagged this for review, correctly, because it looks like the banned vertex paint. It is not.
The banned failure is a palette hex multiplied *on top of* a palette albedo, which yields a
wrong, darker hue. R_FX divides by the family albedo first (`albedoRatio(paper, arcane)`), so the
product equals the palette entry **exactly**. `core.ts` explicitly reserves the colour attribute
for "per-instance tint steps"; this is that. Ratified, and the technique is available to any
module that needs per-instance colour off one shared additive material.

## E. `FxHandle` §9 gaps — scoped, not dismissed

R_FX filed four gaps against `STYLE_BIBLE` §9 that need interface changes it does not own. My
rulings on scope:

**Take now** (cheap, and §9 names them):
- **Per-family death.** One `'death'` kind currently covers hero, creep and structure. §9 wants a
  hero to collapse into a fading soul wisp, a creep to topple and dissolve, a structure to
  crumble and leave rubble. `FxHandle.burst` gains `'deathHero' | 'deathCreep'` alongside the
  existing `'death'` and `'tower'`. R_WIRE routes by `EntKind`.

**Defer** (they need the frame clock or the post handle, and the build is not yet integrated):
- **Hit-pause** (40–70 ms on heavy hits) needs a time-scale where the frame delta is produced —
  R_SCENE's. Revisit at R_WIRE integration.
- **Cast-start.** R_FX currently delays its own strike behind an internally-timed gather, which
  is visually correct but starts the wind-up when the *strike* is reported. A real
  `castStart(x, z, school)` needs the snapshot path. Revisit with R_WIRE.
- **Damage vignette pulse** needs a route from FX to `PostHandle`. Revisit with R_WIRE, which
  holds both handles.

These are recorded so they are decisions, not omissions.

## F. Unverified, and honestly flagged

R_FX could not confirm two things because **the client build is still broken** on `units.ts` and
`mapMesh.ts`, so no pixels exist:

- whether `fxDecal`'s `fog: true` reads correctly at the fog horizon (it declined to file a table
  amendment on speculation — right call)
- its draw-call figures come from an isolated harness reproducing the real pass structure, not
  from an assembled frame

Both must be re-confirmed through `verify-rift.mjs` once R_UNITS and R_MAPMESH land. This is the
general rule for the whole render wave: **every number measured in isolation is provisional until
the build assembles.**
