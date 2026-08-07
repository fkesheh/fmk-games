# GRAPHICS CONTRACT — ANCIENTS (rift)

**Status: FROZEN on freeze-commit. Layer-2 spec text.** Embedded verbatim in every implementer
brief for this pass. Companion documents, also embedded: `games/rift/STYLE_BIBLE.md` (art
direction) and `games/rift/DESIGN_DELTA.md` (terrain gameplay intent).

**Immutability rule (inherited from `games/rift/CONTRACT.md`, restated because it binds here too):**
no implementer may modify, rename, or re-export any Layer-1 file, nor change any public signature
specified in this document. If the contract is wrong, the task **fails back to the orchestrator with
the contradiction cited**. Nobody patches around it locally, and nobody negotiates an interface with
a sibling task.

---

## 1. Amendment to the material law

`games/rift/CONTRACT.md` §6 and §7 froze a flat-shaded `MeshLambertMaterial`-only model with no
textures and no post-processing. **That law is hereby amended.** This is a deliberate, recorded
orchestrator amendment in the same manner as the earlier `CanvasTexture` carve-out, and it is the
only sanctioned change to it.

### 1a. What is now PERMITTED (and, where stated, REQUIRED)

- **`MeshStandardMaterial` is the required material for every world and unit surface**, constructed
  only through the frozen `surface()` factory in the kit (§2).
- **Image-based lighting is REQUIRED.** `scene.environment` must hold a `PMREMGenerator`-processed
  environment produced from the procedural sky scene, regenerated on time-of-day change. A build
  that renders PBR with `scene.environment === null` fails review.
- **Procedurally generated textures are permitted on world geometry** — albedo, roughness, normal
  and AO maps, generated in code via canvas/noise and produced only by the kit's generators. The
  earlier restriction of `CanvasTexture` to fog-of-war and minimap is lifted.
- **Post-processing is REQUIRED**, in the fixed stack of STYLE_BIBLE §6.
- **Emissive materials** are permitted for crystals, braziers, hearts and FX cores, and are the only
  inputs to selective bloom.

### 1b. What remains BANNED

- Any **image asset, font file, `TextureLoader`, or network-fetched resource**. Every pixel is
  generated at runtime by code. The bundle stays asset-free.
- **`MeshBasicMaterial` / `MeshLambertMaterial` / `MeshPhongMaterial` on any sun-lit surface.**
  (Unlit UI-space surfaces — the fog-of-war overlay planes, the sky dome shells — are exempt and
  keep their existing treatment except where §4 changes the sky.)
- **Material construction outside the kit.** `new THREE.Mesh*Material(...)` in an implementer file
  is a contract violation.
- **Ad-hoc hex.** All color still resolves to `APAL`, or `mix()`/`composite()` with both endpoints in
  `APAL`.
- **`Math.random` anywhere under `games/rift/`.** All variation comes from the kit's seeded RNG.
  Non-determinism breaks the judge loop, because successive rounds must capture the same framing.
- **Disabling shadows, AO or bloom for performance.** Reduce capture resolution instead.

### 1c. What is unchanged and still binds

The camera rig (fixed 55° pitch, fixed yaw, FOV 50, height clamp [18,55]); the value-ladder law and
its thresholds in `valueLadder.test.ts` (extended with new cases, **never weakened**); the sky laws
S1/S2/S4; the frozen client seam types in `client/src/contract.ts` except for the additions in §6;
the DOM class contract; and the robustness rules (one exception must never white-screen; WebGL
failure yields a readable error div; blur clears held keys; resize reflows).

---

## 2. The frozen kit — `games/rift/client/src/render/kit.ts` (NEW, Layer-1)

**This file is the shared visual vocabulary. It is what makes six independent art agents produce one
art-directed game instead of six.** Every visual implementer imports from it; nobody reimplements
any of it; nobody edits it.

It is authored as part of the contract, before fan-out, and frozen. Its complete public surface:

```ts
// --- Materials ---------------------------------------------------------------
/** The ONLY way to obtain a material. Cached per (id, tint) so identical
 *  surfaces share one material instance and bucket into one draw call. */
export function surface(id: SurfaceId, tint?: string): THREE.MeshStandardMaterial;
/** Emissive variant for crystals/braziers/FX cores; drives selective bloom. */
export function emissiveSurface(id: SurfaceId, colorKey: string, intensity: number): THREE.MeshStandardMaterial;

// --- Procedural texture generators (cached; call at bake time, never per frame)
export function noiseTexture(opts: NoiseOpts): THREE.CanvasTexture;
export function normalFromHeight(height: THREE.CanvasTexture, scale: number): THREE.CanvasTexture;
export function roughnessTexture(opts: NoiseOpts): THREE.CanvasTexture;
export function gradientTexture(stops: readonly ColorStop[]): THREE.CanvasTexture;

// --- Primitive factories (return geometry, already transformed) ---------------
export function box(w: number, h: number, d: number, o?: PartOpts): THREE.BufferGeometry;
export function cyl(rTop: number, rBot: number, h: number, seg: number, o?: PartOpts): THREE.BufferGeometry;
export function cone(r: number, h: number, seg: number, o?: PartOpts): THREE.BufferGeometry;
export function sphere(r: number, seg: number, o?: PartOpts): THREE.BufferGeometry;
export function ico(r: number, detail: number, o?: PartOpts): THREE.BufferGeometry;
export function capsule(r: number, len: number, o?: PartOpts): THREE.BufferGeometry;
/** Lathe/extrude helpers for carved stone and organic forms. */
export function lathe(profile: readonly Vec2[], seg: number, o?: PartOpts): THREE.BufferGeometry;
export function ribbon(path: readonly Vec3[], width: number, o?: PartOpts): THREE.BufferGeometry;

// --- Baking ------------------------------------------------------------------
/** Merge parts into ONE geometry per surface id. The draw-call budget depends
 *  on this being used for every static and every per-unit build. */
export function bake(parts: readonly Part[]): BakedMesh;
/** Bakes ambient occlusion into a vertex-color attribute. Applied to all static
 *  world geometry; this is the cheap half of the AO story, SSAO is the other. */
export function bakeVertexAO(geo: THREE.BufferGeometry, strength: number): THREE.BufferGeometry;

/** Chunked bake scheduler for cold-load budgets (§5). Driven from the owner's
 *  frame hook; step() returns false when the work is finished. */
export function bakeChunked(parts: readonly Part[], budgetMs: number): { step(): boolean };

// --- Unit builds -------------------------------------------------------------
export interface UnitBuild {
  readonly body: BakedMesh;                    // SurfaceId-bucketed
  readonly anim: THREE.BufferGeometry | null;
  readonly animKind: 'orbit' | 'bob' | 'spin' | null;
  readonly animY: number;
  readonly barH: number;
  readonly barW: number;
}

// --- Bloom masking -----------------------------------------------------------
export const BLOOM_LAYER: number;
/** Every object built with emissiveSurface() MUST be marked. */
export function markBloom(o: THREE.Object3D): void;

// --- Determinism -------------------------------------------------------------
/** Seeded RNG. The ONLY source of randomness in the game. */
export function rng(seed: string | number): Rng;   // { next(): number; range(a,b): number; pick<T>(xs: readonly T[]): T; sign(): number }

// --- Scatter -----------------------------------------------------------------
/** Poisson-disc scatter with per-instance seeded variation, honouring the
 *  density targets in STYLE_BIBLE §8. Returns instance transforms; the caller
 *  bakes or instances them. */
export function scatter(opts: ScatterOpts): readonly InstanceXform[];
```

`SurfaceId` is the union of the family keys in the STYLE_BIBLE §2 table, defined as Layer-1 data in
`games/rift/shared/src/surfaces.ts` together with its physical parameters. Adding a `SurfaceId`
requires an orchestrator amendment.

`bake(parts)` merges parts into one geometry **per surface id**; `BakedMesh` holds the resulting
`{ geo, material }[]` and a single parent `THREE.Group`. Every type named in this section —
`Part`, `PartOpts`, `BakedMesh`, `NoiseOpts`, `ScatterOpts`, `InstanceXform`, `ColorStop`, `Rng`,
`LatheVec` — is exported from `kit.ts`. The `lathe` profile uses
`export interface LatheVec { readonly r: number; readonly y: number }`, **not** the shared `Vec2`
(which is `{x, z}` in world space and would silently mean the wrong thing).

**Vertex-color law.** Every material returned by `surface()`/`emissiveSurface()` has
`vertexColors: true`. Consequently **every geometry reaching the renderer must carry a `color`
attribute**: `bake()` unconditionally emits one (white `(1,1,1)` where no AO has been baked), and any
geometry path that does not go through `bake()` — the terrain heightfield, `scatter()` instancing, FX
pooled meshes — is required to write the same white default. `bakeVertexAO` multiplies into an
existing attribute and never creates one. Getting this wrong has exactly two failure modes, both
seen in practice: baked AO silently does nothing, or every shared-family mesh renders black.

**UV law.** All kit textures are `RepeatWrapping` at a fixed convention of **1 UV unit ≙ 1 world
metre**. `bake()` rewrites UVs into world space at that scale before merging — planar XZ projection
for `ground`/`cliff`/`lane` families, cylindrical for trunk families, and per-part normalized UVs
preserved only where `PartOpts.uvLocal === true` (small props and unit parts). Texel density is
therefore uniform across the map by construction, and **no implementer sets `texture.repeat`.**

---

## 3. Palette extension

`APAL` is **extended, never re-valued.** Every existing entry keeps its exact current value, so every
existing ladder assertion continues to hold unchanged. New families are added for: cliff rock, dirt,
wet/river stone, water, canopy/bark/fern, the three metals (iron/bronze/gold already partly present),
the neutral-camp identity, and the night lighting state.

Rules for the extension, all enforced by extended cases in `valueLadder.test.ts`:
- Every new tiered family obeys the tier law: `Lit ≥ base + 8 L*`, `Deep ≤ base − 8 L*`.
- Every new large-surface family (cliff, dirt, canopy, water) is separated from `moss` by
  **≥ 12 L\* or ≥ 25° hue** — the ground must never merge with the terrain features standing on it.
- The neutral-camp identity is separated from **both** team colors by ≥ 25° hue or ≥ 20 L\*, and from
  every hero accent by the same margin. A neutral creep must never be mistaken for an enemy creep.
- The night sky obeys S1 (zenith cooler and ≥ 12 L\* darker than horizon) and S2 (night fog **equals**
  the night horizon stop, exactly), and S4 (night ground ≠ night horizon).
- The CSS-var mirror stays 1:1 and complete.

`valueLadder.test.ts` gains cases; **no threshold in it may be weakened.** If a new color cannot
satisfy a threshold, that is a contract gap: report it to the orchestrator, do not retune the test.

---

## 4. Terrain data model

Specified in §4 of this document's terrain addendum — see `games/rift/shared/src/terrain.ts`, which
is Layer-1 and authored by the orchestrator. Both the server sim and the client renderer derive
terrain from the **same pure function of the lane count**, exactly as `buildMap(lanes)` already
works. Terrain is never sent on the wire; both sides compute it and must agree bit-for-bit.

The gameplay semantics of terrain — impassable cliffs, uphill vision blocking, the 25% uphill miss
chance, foliage concealment, camp behaviour, and the day/night vision penalty — are specified in
`games/rift/DESIGN_DELTA.md` and are binding.

---

## 5. Non-functional budgets (build-time requirements, not a post-pass)

The PBR + post-processing conversion raises cost, so the budgets are **re-baselined** here. They are
requirements every implementer builds to, checked by the review lenses and measured in the gate — not
inspected at the end.

- **60 fps at 1080p** on a 2020 laptop at 3-lane / 8v8 peak with camps populated.
- **Draw calls ≤ 700** measured via `renderer.info.render.calls` (raised from 400 to pay for terrain,
  jungle density and camps), still enforced by `scripts/verify-rift.mjs` (owned by S_HARNESS, which
  raises `DRAW_CALL_BUDGET` to 700). **Because the composer resets `renderer.info` on every pass,
  `scene.ts` must set `renderer.info.autoReset = false` and call `renderer.info.reset()` once at the
  top of `render(dtMs)`; `drawCalls()` returns the accumulated per-frame total across all passes.**
  Without this the meter silently collapses to roughly 1 the moment the mandatory post stack lands,
  and the only mechanical enforcement of the whole density strategy stops measuring anything.
  S_HARNESS proves the meter live by asserting the reported count rises when a pass is added.
- **Triangles ≤ 1.2 M rendered per pass**, measured via `renderer.info.render.triangles` by the same
  harness that reads `drawCalls()`. A draw-call budget alone is gameable by merging the whole map into
  one unculled mesh; this is the gate that stops that.
- Everything static bakes **per 16×16 m spatial chunk, and everything repeated uses `InstancedMesh`
  per archetype — never one map-wide merge**, which has one draw call and zero frustum culling.
- **Frame budget:** snapshot parse + scene diff ≤ 4 ms client-side; sim tick ≤ 2.5 ms server-side at
  8v8 with camps (raised from 2 ms to pay for terrain queries and camp AI).
- **Terrain queries must be O(1)** — a grid lookup, never a scan. They run in the movement and vision
  hot paths for every unit every tick.
- **No per-frame allocation** in the render loop, sim tick, or interpolation. Pool particles, damage
  numbers, projectiles, and camp entities.
- **Bundle ≤ 2.0 MB gz** (raised from 1.5 MB for the post-processing addons; still asset-free, so the
  only growth is code).
- **Cold load:** the map bake — terrain mesh, scatter, AO — must not freeze the main thread on match
  start. Budget ≤ 400 ms total, **split 150 ms R_TERRAIN / 150 ms R_VEG / 100 ms R_MAPMESH; each
  owner measures its own.** Chunking uses the kit's `bakeChunked(parts, budgetMs)` scheduler, driven
  from the owner's frame hook — a synchronous factory cannot chunk itself, so this is the only
  sanctioned mechanism. (A prior pass in this repo shipped a 1 s join freeze from exactly this; it is
  a known trap.)

### Judge shot list (frozen)

The screenshot judge must photograph the features this build exists to add, or the loop grades a
world it cannot see. S_HARNESS extends the capture matrix with: `high-ground` (cliff face + plateau,
camH 24), `river-mid`, `camp-brute`, `jungle-wall`, and the night variants `night-wide-mid`,
`night-mid-lane`, `night-close-hero`. Every capture pins `dayPhase` explicitly via
`window.__rift.setDayPhase` before the shot, or captures become wall-clock dependent and no two judge
rounds are comparable. Reference captures for the new shots are sourced into `judge/reference/` by
S_HARNESS on the first green run.

**Capture liveness (measured defect).** The baseline `wide-mid` capture was taken while the local
hero was dead, so the entire frame came through the death-screen dim and was near-black — a judge
scoring that frame would be scoring an overlay, not the game. **S_HARNESS must assert the local hero
is alive and no full-screen overlay (death, countdown, end) is present before every in-world shot**,
and must re-drive the state and retry rather than emit a dimmed frame. A shot that cannot reach a
live state fails loudly instead of being captured.
- **Robustness:** one exception must never white-screen; WebGL2 or post-processing failure degrades
  to a readable error div rather than a blank canvas; window blur clears held keys; resize reflows.

---

## 6. Additions to the frozen client seam

`games/rift/client/src/contract.ts` is Layer-1. It is **extended** by the orchestrator with exactly
the following; every existing member keeps its current signature and semantics **except
`InterpEnt.team` and `GhostEnt.team`, which widen from `TeamId` to `EntTeam` (imported from
`@rift/shared`)**. Every consumer that indexes a per-team structure with one of these narrows first
with `isPlayerTeam`; the named sites are `ui/nameLabels.ts:86` (`TEAM_MARKER`/`TEAM_COLOUR`) and
`ui/minimap.ts:98,132`.

```ts
export interface SceneHandle {
  // ... all existing members unchanged ...
  /** Ground height at a world point — the renderer's authority for placing
   *  anything on the terrain. Must agree with the shared terrain model. */
  heightAt(x: number, z: number): number;
  /** 0 = full day, 1 = full night; drives lighting, sky, env map and fog. */
  setTimeOfDay(t: number): void;
  /** Installs the terrain the scene samples. Called exactly once, by wire.ts,
   *  on rift_begin, BEFORE buildMapMeshes/createTerrain/createVegetation. */
  setTerrain(t: TerrainDef): void;
}
```

**Invariant:** `heightAt` returns `0` for every input until `setTerrain` has been called. `wire.ts`
(R_WIRE) calls `scene.setTerrain(map.terrain)` as the first statement of `onBegin`, before any render
module is constructed. No other caller may invoke it.

**`render/core.ts` (NEW, Layer-1).** Re-declares the internal render seam, replacing the `SceneCore`
currently private to `scene.ts`. `mat()` and `vertexMat()` are **removed** — all materials come from
the kit's `surface()`. Added: `readonly renderer: THREE.WebGLRenderer`, `heightAt(x, z): number`, and
`setFramePass(fn: ((dtMs: number) => void) | null): void`. **Frame ownership:**
`SceneHandle.render(dtMs)` runs the frame hooks, then delegates to the installed frame pass if one is
set, else calls `renderer.render(three, camera)` directly. `createPost(scene)` installs the composer
via `setFramePass` at construction; nothing else may call it. `sceneCore(scene: SceneHandle):
SceneCore` keeps its signature and remains the only accessor.

**Wire parser (`client/src/net.ts`, owned by R_WIRE).** `teamOf` returns `EntTeam | null` and accepts
`0 | 1 | 2`. `entKindOf` gains `'campPack' | 'campBrute' | 'campHive'`. The `rift_snap` branch
validates `num(raw.dayPhase)` and carries `dayPhase` into the constructed `SnapMsg`. Sites that
require a player team (`parseYou`, `parseBoard`, `parseRoster`, `rift_structure`, `rift_end.winner`)
keep `TeamId` and narrow with `isPlayerTeam`.

**Debug surface.** `window.__rift` gains `setDayPhase(t: number | null): void` — pins the renderer's
time of day and suppresses snapshot-driven updates until called with `null`. R_WIRE owns the override
path from `game.ts` into `SceneHandle.setTimeOfDay`. Every capture pins `dayPhase` explicitly before
the shot.

New render modules and their frozen factory signatures:

```ts
render/terrain.ts:           export function createTerrain(scene: SceneHandle, map: MapDef): TerrainHandle;
render/vegetation.ts:        export function createVegetation(scene: SceneHandle, map: MapDef): VegetationHandle;
render/post.ts:              export function createPost(scene: SceneHandle): PostHandle;
render/meshes/heroes.ts:     export function buildHero(id: HeroId, team: EntTeam): UnitBuild;
render/meshes/creeps.ts:     export function buildCreep(kind: EntKind, team: EntTeam): UnitBuild;
render/meshes/camps.ts:      export function buildCamp(tier: 'pack' | 'brute' | 'hive'): UnitBuild;
render/meshes/structures.ts: export function buildStructure(kind: StructureKind, team: TeamId): UnitBuild;
```

`TerrainHandle`, `VegetationHandle` and `PostHandle` are declared in `contract.ts` by the
orchestrator. `buildMapMeshes` keeps its signature and cedes terrain and scatter to the two new
modules, retaining lanes, structures' platforms and landmarks.

**HUD and minimap (R_HUD, R_MINIMAP).** R_HUD shows a high/low-ground state chip on the self readout,
a concealed-state chip, a day/night phase mark on the match clock, and a `MISS` float on `rift_miss`.
R_MINIMAP draws neutral entities in the neutral-camp family with a distinct marker shape — never
colour alone.

---

## 7. Rules restated for every implementer (the RULES block)

Every implementer brief in this pass carries these verbatim:

1. Create and modify **only** the files your task owns. No file is owned by two tasks.
2. The contract, the palette, the kit, the surface table and the terrain model are **immutable**.
   If one is wrong, fail back to the orchestrator citing the contradiction.
3. **No stubs, no TODOs, no placeholder art.** A task is done when it is finished, not when it
   compiles.
4. All color from `APAL`; all materials from `surface()`; all randomness from `rng()`; all primitives
   from the kit; all static geometry through `bake()`.
5. Never negotiate an interface with another task. Everything you need is in the contract.
6. Build to the budgets in §5 — pool, bake, instance. No per-frame allocation.
7. Guard your entry points: one thrown exception must not white-screen the game.
8. Your definition of done is **your own workspace's** gate, not the repo's: `npm run typecheck -w
   @rift/shared` / `-w @rift/server` / `-w @rift/client` for the workspace you edited, plus the
   `npx vitest run <your suites>` you own. The **workspace-wide** `npm run typecheck` and
   `npm run build` are the INTEGRATION gate and are expected to be red mid-build, because the frozen
   contract changes types that other tasks' files have not yet caught up to. Do not "fix" a red
   typecheck in a file you do not own — report it instead; it is almost certainly another task's
   work, and editing it will collide with them.
9. Every object you build with `emissiveSurface()` must be passed to `markBloom()`. Unmarked
   emissives do not bloom; marked non-emissives haze the frame.
10. Any site in a file you own that indexes a per-team tuple, array or `Record` by an entity's
   `team` must narrow with `isPlayerTeam` first. Grep your own files for it — neutral camps make an
   unnarrowed index an out-of-bounds read.
