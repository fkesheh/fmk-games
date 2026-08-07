// ============================================================================
// ANCIENTS (rift) — RENDER CORE (GRAPHICS_CONTRACT §6 render/core.ts). Layer-1,
// FROZEN, types + one accessor + one geometry helper. No scene logic lives
// here: R_SCENE builds the single concrete `SceneCore` inside createScene().
//
// This is the INTERNAL render seam — the surface render/scene.ts shares with
// every other render module (mapMesh, terrain, vegetation, units, fog, fx,
// post, meshes/*), because the frozen create-function signatures pass only the
// public `SceneHandle`. Splitting it out of scene.ts is what lets a dozen
// render tasks compile against the seam IN PARALLEL without importing each
// other's modules, and without importing scene.ts's implementation.
//
// It REPLACES the `SceneCore` that was private to render/scene.ts. Consumers
// now import `{ sceneCore }` and `type { SceneCore }` from './core.js'; the
// old './scene.js' import site is dead. `CAMERA_PITCH_DEG`, `cameraNormalY()`
// and `cameraNormalZ()` are NOT part of this seam and stay exported from
// render/scene.ts, where the camera rig they describe lives.
//
// TWO MEMBERS ARE GONE, DELIBERATELY — `mat(hex)` (the flat-shaded Lambert
// factory) and `vertexMat()` (the shared vertex-paint Lambert). GRAPHICS_
// CONTRACT §1 amended the material law: `MeshStandardMaterial` is the required
// material for every world and unit surface, and the kit's `surface()` /
// `emissiveSurface()` are the ONLY ways to obtain one (STYLE_BIBLE §2). A
// Lambert accessor left on this seam would let any module keep minting
// materials that silently take no part in IBL, screen-space AO or selective
// bloom, and the resulting frame would look like a half-converted build with
// nothing in the diff to point at. The removal IS the enforcement. `paintGeo()`
// is gone for the same reason — see the VERTEX-COLOR LAW block below for what
// replaced it.
// ============================================================================
import * as THREE from 'three';
import type { MapDef } from '@rift/shared';
import type { SceneHandle } from '../contract.js';

// ---- FRAME OWNERSHIP (GRAPHICS_CONTRACT §6) ---------------------------------
// Exactly one module drives the frame, and which one is decided by a single
// nullable slot on this seam. `SceneHandle.render(dtMs)`, implemented by
// R_SCENE, does this and only this, in this order:
//
//   1. `renderer.info.reset()`                      (metering, see below)
//   2. every registered frame hook, in registration order, with `dtMs`
//   3. the camera rig update (shake offsets move every frame)
//   4. the installed frame pass, `pass(dtMs)`, IF one is installed —
//      OTHERWISE `renderer.render(three, camera)`.
//
// Step 4 is an either/or, never both: a composer's own `RenderPass` already
// draws the scene, so an extra direct `renderer.render` would double the whole
// frame's cost and then throw away the antialiased composited result. Steps 2-4
// sit inside R_SCENE's existing try/catch (CONTRACT §10 robustness), so a
// throwing composer pass is a logged warning, never a white screen.
//
// `createPost(scene)` (R_POST) installs the composer by calling
// `setFramePass` at construction. IT IS THE ONLY CALL SITE. Nothing else — not
// terrain, not fx, not wire.ts, not the capture harness — may call it. There is
// no stacking: a second install would silently orphan the first composer, and
// because the frame would still look plausible the defect would survive review.
// The `null` argument exists for exactly one purpose: R_POST uninstalling its
// own stack when a pass fails to construct, which is the degradation path
// behind `PostHandle.enabled() === false` (direct `renderer.render`, a
// playable frame with no post — never a blank canvas).
//
// ---- DRAW-CALL METERING (GRAPHICS_CONTRACT §5) ------------------------------
// The draw-call budget (≤ 700, enforced by scripts/verify-rift.mjs through
// `SceneHandle.drawCalls()`) is the only mechanical check on the whole density
// strategy, and the mandatory post stack breaks it by default: `EffectComposer`
// resets `renderer.info` on every pass, so a naive read after the frame reports
// the last pass alone — roughly 1 — and the budget silently stops measuring
// anything. R_SCENE therefore implements, and nobody else may undo:
//
//   * `renderer.info.autoReset = false`, set once in createScene();
//   * `renderer.info.reset()` called EXACTLY ONCE per frame, at the very top of
//     `render(dtMs)` — before the hooks, before the frame pass;
//   * `drawCalls()` returns `renderer.info.render.calls` at read time, which is
//     therefore the accumulated per-frame total across the scene pass, the AO
//     pass, both bloom targets, the grade, the output pass and the AA pass.
//
// `renderer.info.render.triangles` accumulates through the identical mechanism
// and is read by the same harness against the ≤ 1.2 M budget; the post passes
// are fullscreen quads contributing two triangles each, so the per-frame total
// and §5's per-pass figure differ negligibly. R_POST must not re-enable
// `autoReset` and no module may call `renderer.info.reset()` a second time —
// either one collapses both meters.

/** The internal render seam. R_SCENE owns the single implementation (built in
 *  `createScene`); every other render module reaches it with `sceneCore(scene)`
 *  and treats every member as read-mostly shared state. Nothing here allocates,
 *  so every member is safe to call from a frame hook. */
export interface SceneCore {
  /** The one `THREE.Scene`. Add your baked groups to it; never replace its
   *  `background`, `fog` or `environment` — those are R_SCENE's, driven by
   *  `SceneHandle.setTimeOfDay` (STYLE_BIBLE §4: `environment` is a PMREM of
   *  the procedural sky and is never null). */
  readonly three: THREE.Scene;
  /** The one camera: fixed 55° pitch, fixed yaw, FOV 50 (STYLE_BIBLE §5). Read
   *  it for projection and culling; never move it — `SceneHandle.setCamera`
   *  and `setShake` are the only two things that position it. */
  readonly camera: THREE.PerspectiveCamera;
  /** The one `WebGLRenderer`, exposed so R_POST can construct its
   *  `EffectComposer` against the live context and read back the current
   *  drawing-buffer size for `PostHandle.resize()`.
   *
   *  What it is NOT: a licence to render. `renderer.render` is called by
   *  `SceneHandle.render(dtMs)` alone (see FRAME OWNERSHIP). `toneMapping`,
   *  `toneMappingExposure`, `shadowMap.*`, `setSize`, `setPixelRatio` and
   *  `info.autoReset` all belong to R_SCENE — STYLE_BIBLE §6 gives it exposure
   *  outright (2.75 day → 1.9 night) because `OutputPass` inherits both tone
   *  mapping settings from the renderer, and two owners of exposure is how a
   *  night frame ends up black or washed out. */
  readonly renderer: THREE.WebGLRenderer;
  /** Absolutely-positioned DOM layer over the canvas, for HTML overlays that
   *  must track world points (fx damage numbers, hero name labels). Pair it
   *  with {@link worldToScreen}; pointer events are off. */
  readonly overlay: HTMLElement;
  /** Map side length in metres. Valid after `fitMap`; defaults to a 3-lane
   *  map's side before then, so an early read is wrong but never a crash. */
  mapSide(): number;
  /** Ground height in metres at a world point — the SAME function and the same
   *  authority as `SceneHandle.heightAt` (see contract.ts for the full
   *  semantics), mirrored onto this seam so modules that hold only the core
   *  (fx decals, unit and marker y, label anchors) need not thread the public
   *  handle through as well. O(1), allocation-free, never throws,
   *  out-of-bounds clamps to the nearest in-bounds cell.
   *
   *  INVARIANT, restated because it decides construction order: it returns `0`
   *  for EVERY input until `SceneHandle.setTerrain` has been called, and
   *  wire.ts calls that as the first statement of `onBegin`, before any render
   *  module is constructed. Anything sampling height at module-construction
   *  time is therefore reading the real terrain — but anything sampling it
   *  before `rift_begin` gets a flat map, not a null and not a throw. */
  heightAt(x: number, z: number): number;
  /** Register a per-frame callback: canopy wind, river ripple scroll, chunked
   *  bake stepping, marker pings, pooled-particle integration. Called every
   *  frame with the frame delta in milliseconds, in registration order, BEFORE
   *  the frame pass draws (see FRAME OWNERSHIP). There is no unregister by
   *  design — every hook lives as long as the scene — so a hook must be cheap,
   *  must tolerate being called before its own data exists, and must not
   *  allocate (GRAPHICS_CONTRACT §5: no per-frame allocation). A hook that
   *  throws takes the frame down with it; guard your own entry point. */
  addFrameHook(fn: (dtMs: number) => void): void;
  /** Install (or, with `null`, remove) the frame pass that draws the scene in
   *  place of `renderer.render(three, camera)`.
   *
   *  ONE LEGAL CALLER: `createPost(scene)`, at construction, passing its
   *  composer's render step. Read the FRAME OWNERSHIP block above before
   *  touching this — an unauthorised call is not a style violation, it is a
   *  silently doubled or silently discarded frame. */
  setFramePass(fn: ((dtMs: number) => void) | null): void;
  /** Hand the scene the map's extents: sets {@link mapSide}, parks the sky
   *  dome on the map centre and sizes it to enclose the map at every legal
   *  zoom, and gives the lighting rig its ground footprint. Called exactly once
   *  per match, by `buildMapMeshes` (R_MAPMESH). Note that the sun's shadow
   *  frustum is NOT fitted here any more: STYLE_BIBLE §4 fits it to the
   *  camera's visible ground footprint and snaps it to texel increments, which
   *  is a per-frame job R_SCENE owns internally. */
  fitMap(map: MapDef): void;
  /** Camera shake offset in world metres, applied around the camera target and
   *  re-applied every frame. R_FX owns this: it writes a decaying sinusoid and
   *  must write `(0, 0)` when the shake ends, since the offset is state, not an
   *  impulse. */
  setShake(x: number, z: number): void;
  /** Add a mesh to the mouse-pick set. The mesh must carry a numeric
   *  `userData.entId` (`-1` = not pickable); `SceneHandle.pickUnit` raycasts
   *  this set, non-recursively, and returns the first hit's id. */
  registerPick(mesh: THREE.Object3D): void;
  /** Remove a mesh from the pick set. Mandatory when a unit despawns — a
   *  stale entry keeps a dead entity clickable and keeps its geometry alive. */
  unregisterPick(mesh: THREE.Object3D): void;
  /** Project a world point to {@link overlay} pixel coordinates, writing into
   *  the caller's `out` (pooled — this never allocates). Returns `false` when
   *  the point is outside the depth range, i.e. behind the camera, in which
   *  case `out` is left untouched and the caller must hide its overlay node. */
  worldToScreen(x: number, y: number, z: number, out: { x: number; y: number }): boolean;
}

/** The private shape `createScene` actually returns: the public `SceneHandle`
 *  plus the core hanging off it. R_SCENE types its handle literal with this so
 *  the whole object is checked in one place; EVERY other module goes through
 *  {@link sceneCore} instead and must never reach for `.core` directly. */
export interface SceneHandleInternal extends SceneHandle {
  readonly core: SceneCore;
}

/** Recover the internal core from a `SceneHandle` produced by `createScene`.
 *  The ONLY accessor, and the reason the frozen create-function signatures can
 *  keep passing the narrow public handle. Passing a handle from anywhere else
 *  (a test double, a facade) yields `undefined` at runtime with no type error —
 *  so a fake scene must carry a `core`. */
export function sceneCore(scene: SceneHandle): SceneCore {
  return (scene as SceneHandleInternal).core;
}

// ---- VERTEX-COLOR LAW (GRAPHICS_CONTRACT §2) --------------------------------
// `paintGeo(geom, hex)` — which baked a palette hex into a geometry's `color`
// attribute so a merged unit rendered through one shared vertex-paint Lambert —
// IS REMOVED, and has no direct replacement. Under the amended material law it
// would be actively wrong: every material `surface()` returns already carries
// its own palette albedo AND `vertexColors: true`, and three.js MULTIPLIES the
// vertex color into that albedo. Painting a second palette hex on top would
// multiply two colours and render a much darker, wrong hue — one of the two
// failure modes §2 names by hand ("every shared-family mesh renders black").
//
// What replaces it, per role:
//   * PER-PART COLOUR (a unit's team trim, a tinted prop) is now a SURFACE, not
//     a vertex paint: emit the part with its own `SurfaceId`, or with
//     `surface(id, tint)`, and let `bake()` bucket it. `bake()` merges one
//     geometry per (surface, tint) key, so a unit still costs one draw call per
//     distinct material instead of one per part — the same win paintGeo bought,
//     now with roughness, metalness and normal maps that a vertex paint could
//     never carry.
//   * THE COLOUR ATTRIBUTE ITSELF is reserved for MULTIPLICATIVE modulation:
//     baked ambient occlusion (`bakeVertexAO`, which multiplies into an
//     existing attribute and never creates one) and per-instance tint steps.
//     Its neutral value is white `(1,1,1)`, and it must be PRESENT on every
//     geometry that reaches the renderer.
//
// `bake()` emits that white default unconditionally. Every geometry path that
// does NOT go through `bake()` — the terrain heightfield, `scatter()` instance
// geometry, pooled FX meshes, anything hand-built with a raw THREE geometry
// constructor — is required to write the same default, and {@link
// whiteVertexColors} below is how. Skipping it is the other failure mode §2
// names: the attribute is missing, the shader falls back per-driver, and baked
// AO applied later silently does nothing.

/**
 * Give `geo` the neutral white `color` attribute the vertex-color law requires,
 * and return the same geometry (chainable, like the `paintGeo` it replaces).
 *
 * Call it on any geometry that did NOT come out of the kit's `bake()`, BEFORE
 * handing it to a `surface()` material and BEFORE `bakeVertexAO` — that helper
 * multiplies into an existing attribute and will not create one for you.
 *
 * Idempotent by design: a geometry that already carries a correctly-sized
 * 3-component `color` attribute is left exactly as it is, so calling this after
 * AO or a tint pass cannot erase either. A `color` attribute of the wrong size
 * (a stale one left over from a re-tessellation) is replaced, because a
 * mismatched attribute is a GPU-side read past the end of the buffer.
 *
 * Allocation: one Float32Array per geometry, at bake time. Never call it per
 * frame — GRAPHICS_CONTRACT §5 bans per-frame allocation in the render loop.
 */
export function whiteVertexColors(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  const n = pos.count;
  if (geo.hasAttribute('color')) {
    const existing = geo.getAttribute('color');
    if (existing.itemSize === 3 && existing.count === n) return geo;
  }
  const colors = new Float32Array(n * 3);
  colors.fill(1);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}
