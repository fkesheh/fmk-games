// ============================================================================
// ANCIENTS (rift) — CLIENT SEAM. FROZEN Layer-1 contract (listed in
// games/rift/CONTRACT.md §6, EXTENDED by games/rift/GRAPHICS_CONTRACT.md §6).
// Types only, no logic. This is the interface the client tasks (T7 render, T8
// app shell, T9 UI, and the R_* graphics tasks) build against IN PARALLEL:
// implementations import ONLY these types from each other's territory, never
// each other's modules. Wiring (main.ts, wire.ts) is orchestrator-owned.
//
// The INTERNAL render seam (`SceneCore`, the surface the render modules share
// with scene.ts) is not here: it lives in render/core.ts, is Layer-1 too, and
// is reached only through `sceneCore(scene)`.
// ============================================================================
import type {
  EntKind,
  EntTeam,
  HeroId,
  RiftC2S,
  RiftEvent,
  RiftS2C,
  TerrainDef,
} from '@rift/shared';

/** The `rift_snap` variant of the server->client union. Structurally
 *  UNCHANGED by this pass: it is an `Extract<>` over `RiftS2C`, so the
 *  `dayPhase` field TERRAIN_CONTRACT §6 adds to `rift_snap` in
 *  shared/src/protocol.ts arrives here automatically. Consumers read
 *  `snap.dayPhase` (0 = full day, 1 = full night, continuous, wraps) with no
 *  change to this file. */
export type SnapMsg = Extract<RiftS2C, { t: 'rift_snap' }>;
export type LobbyMsg = Extract<RiftS2C, { t: 'rift_lobby' }>;
export type BeginMsg = Extract<RiftS2C, { t: 'rift_begin' }>;
export type HelloMsg = Extract<RiftS2C, { t: 'rift_hello' }>;
export type EndEvent = Extract<RiftEvent, { t: 'rift_end' }>;

// --- interp.ts (T8 owns the implementation) -------------------------------------
export interface InterpEnt {
  id: number;
  k: EntKind;
  /** `EntTeam`, WIDENED from `TeamId` (GRAPHICS_CONTRACT §6): neutral jungle
   *  camps ride the same snapshot path as players' units and carry
   *  `NEUTRAL_TEAM` (2). Every consumer that indexes a per-team tuple, array
   *  or `Record` with this value MUST narrow with `isPlayerTeam` FIRST — an
   *  unnarrowed index is an out-of-bounds read that only appears once camps
   *  spawn, i.e. never in a unit test and always in a live match. The known
   *  sites are ui/nameLabels.ts (`TEAM_MARKER` / `TEAM_COLOUR`) and
   *  ui/minimap.ts (team colour + marker lookup); their owning tasks grep
   *  their own files for `.team` indexing and narrow all of them. Neutral
   *  entities are drawn in the neutral-camp palette family with their own
   *  marker shape — never by falling back to a player team's colour. */
  team: EntTeam;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  lvl?: number;
  hero?: HeroId;
  pid?: string;
  /** Basic-attack target since last snap (drives tracers). */
  atk?: number;
  /** 'proj' flight target + school tag. */
  tx?: number;
  tz?: number;
  fx?: string;
}

export interface GhostEnt {
  id: number;
  k: EntKind;
  /** `EntTeam`, widened from `TeamId` for the same reason as
   *  {@link InterpEnt.team}, and carrying the same `isPlayerTeam` obligation:
   *  a camp that walks out of vision leaves a ghost exactly like a hero does. */
  team: EntTeam;
  x: number;
  z: number;
  fade: number; // 1 -> 0 over 0.5s
}

export interface InterpHandle {
  push(msg: SnapMsg): void;
  /** Interpolated render positions, 2 snaps (100ms) behind. */
  sample(): readonly InterpEnt[];
  /** Fading last-known markers for vanished entities. */
  ghosts(): readonly GhostEnt[];
  /** Newest raw snapshot (HUD data source). */
  latest(): SnapMsg | null;
}

// --- render/* (T7 owns the implementations) ---------------------------------------
export interface SceneHandle {
  readonly canvas: HTMLCanvasElement;
  /** Fixed-angle MOBA camera: look at (x, z) from `height` metres. */
  setCamera(x: number, z: number, height: number): void;
  screenToGround(sx: number, sy: number, out: { x: number; z: number }): boolean;
  /** World ground point -> CSS pixel position (for DOM overlays like hero
   *  name labels). Returns false when behind the camera. */
  groundToScreen(x: number, z: number, out: { x: number; y: number }): boolean;
  /** Entity id under the cursor, -1 = none. */
  pickUnit(sx: number, sy: number): number;
  resize(): void;
  render(dtMs: number): void;
  /** renderer.info draw calls — the perf gate reads this. */
  drawCalls(): number;
  /** Ground height in metres at a world point — the renderer's SINGLE
   *  authority for placing anything on the terrain: terrain mesh vertices,
   *  prop feet, unit and structure y, decals, the camera's ride height
   *  (STYLE_BIBLE §5) and DOM label anchors. O(1), allocation-free, safe to
   *  call in the render loop.
   *
   *  It is a pure function of the installed `TerrainDef` and must AGREE with
   *  the shared gameplay model rather than merely resemble it: a cell whose
   *  `elevationAt` is `ELEV_HIGH` samples strictly higher than every
   *  neighbouring `ELEV_LOW` cell, and whatever visual relief the renderer
   *  adds on top must never contradict the two walkable levels of
   *  TERRAIN_CONTRACT §2 (DESIGN_DELTA §1: the player reads their level at a
   *  glance). Out-of-bounds (x, z) clamps to the nearest in-bounds cell, like
   *  every shared terrain query; it never throws.
   *
   *  INVARIANT: returns `0` for EVERY input until `setTerrain` has been
   *  called. A caller that samples too early therefore gets a flat map, not a
   *  crash and not a null check — which is why every consumer may treat this
   *  as total. */
  heightAt(x: number, z: number): number;
  /** 0 = full day, 1 = full night; continuous, wraps. Drives the sun/moon
   *  direction and intensity, the sky gradient, the PMREM environment rebuild
   *  (STYLE_BIBLE §4 — `scene.environment` is never null), the fog colour and
   *  density, and `renderer.toneMappingExposure` (2.75 day -> 1.9 night,
   *  R_SCENE's alone; STYLE_BIBLE §6). Idempotent and cheap when `t` has not
   *  moved: the PMREM rebuild is gated on a real change and never runs per
   *  frame.
   *
   *  This is the GAME-facing entry. game.ts feeds it `snap.dayPhase`, and
   *  `window.__rift.setDayPhase(t)` pins it for captures (`null` resumes
   *  snapshot-driven updates). It does NOT reach the post stack: the scene
   *  holds no `PostHandle`, and GRAPHICS_CONTRACT §6 makes `setFramePass` the
   *  only scene<->post link, so R_WIRE — which holds both handles — routes the
   *  same value into {@link PostHandle.setTimeOfDay}. */
  setTimeOfDay(t: number): void;
  /** Installs the terrain this scene samples, and the only thing that ever
   *  makes `heightAt` return non-zero.
   *
   *  Called EXACTLY ONCE, by wire.ts (R_WIRE), as the FIRST statement of
   *  `onBegin` — before `buildMapMeshes`, `createTerrain` and
   *  `createVegetation` are constructed, because every one of them samples
   *  `heightAt` while it builds. NO OTHER CALLER MAY INVOKE IT: a second call
   *  after the static geometry is baked would move the ground out from under
   *  meshes that have no rebuild path. Terrain is never on the wire — both
   *  sides derive it from the lane count (TERRAIN_CONTRACT §1) — so the
   *  argument is always `buildMap(begin.lanes).terrain`. */
  setTerrain(t: TerrainDef): void;
}

/** render/terrain.ts (R_TERRAIN). Owns the walkable heightfield mesh, the
 *  cliff faces ringing every plateau and base, the ramps cut through them, and
 *  the river bed + animated water surface — everything whose shape comes from
 *  `MapDef.terrain`. Scattered props are NOT its business (that is
 *  {@link VegetationHandle}), and neither are lanes, structure platforms or
 *  landmarks (those stay with `buildMapMeshes`).
 *
 *  It is deliberately NOT the height authority — `SceneHandle.heightAt` is.
 *  The camera, `buildMapMeshes` and `createVegetation` all need ground height
 *  without holding this handle, and two independent samplers would drift apart
 *  the first time either was tuned. This module TESSELLATES AGAINST
 *  `scene.heightAt`: every vertex it emits is that function evaluated at the
 *  vertex's (x, z), so the visible surface and the sampled surface cannot
 *  disagree. That is why this interface exposes no height query of its own.
 *
 *  Construction is chunked — 150 ms of the 400 ms cold-load budget
 *  (GRAPHICS_CONTRACT §5) — through the kit's `bakeChunked`, driven from this
 *  module's own frame hook; the river ripple scroll animates from the same
 *  hook. Neither needs an entry point here, and neither may allocate per
 *  frame. */
export interface TerrainHandle {
  /** `false` while the chunked bake still has work queued, `true` once every
   *  terrain chunk is in the scene. This is the only correct "the ground is
   *  finished" signal: R_WIRE reports it on `window.__rift` and the capture
   *  harness waits on it, so no judge shot photographs a half-built map.
   *  Cheap, pure, and safe to poll every frame. */
  ready(): boolean;
}

/** render/vegetation.ts (R_VEG). Owns every scattered prop: the six-plus tree
 *  archetypes that wall the jungle, undergrowth clusters, rocks, fallen logs
 *  and stumps, ruin fragments, and the river-bank reeds and wet stones — placed
 *  by the kit's seeded `scatter()` at the STYLE_BIBLE §8 densities, with the
 *  §8 variation law (scale, rotation, lean, tint step) applied per instance,
 *  and drawn as one `InstancedMesh` per archetype so the density is affordable
 *  inside the draw-call budget. Hand-placed landmarks are NOT vegetation; they
 *  stay with `buildMapMeshes`.
 *
 *  Everything it plants sits on `scene.heightAt`, so it must be constructed
 *  after `setTerrain` (wire.ts guarantees this). Canopy and fern wind motion
 *  runs from this module's own frame hook — allocation-free, and with no
 *  per-frame entry point on this interface, because nothing outside the module
 *  has any business tuning it. Construction is chunked to 150 ms of the 400 ms
 *  cold-load budget (GRAPHICS_CONTRACT §5) via the kit's `bakeChunked`. */
export interface VegetationHandle {
  /** `false` while the chunked scatter bake still has work queued, `true` once
   *  every instance batch is in the scene. Same contract and same consumers as
   *  {@link TerrainHandle.ready} — the harness waits on BOTH before a capture,
   *  since a jungle shot of an unplanted jungle grades nothing. */
  ready(): boolean;
}

/** render/post.ts (R_POST). Owns the `EffectComposer` and the fixed,
 *  mandatory STYLE_BIBLE §6 pass order: RenderPass -> screen-space AO ->
 *  layer-masked selective bloom (`BLOOM_LAYER`, never a luminance threshold)
 *  -> colour grade + vignette -> OutputPass -> SMAA/FXAA. Disabling a pass for
 *  performance is a banned regression; reduce capture resolution instead.
 *
 *  `createPost(scene)` installs the composer by calling
 *  `SceneCore.setFramePass` at construction — that is the ONLY call site of
 *  `setFramePass`, and it is what makes `SceneHandle.render(dtMs)` drive the
 *  composer instead of `renderer.render(three, camera)`. Nothing else ever
 *  touches the frame pass. Because the composer resets `renderer.info` on each
 *  pass, R_SCENE holds `renderer.info.autoReset = false` and resets once per
 *  frame; R_POST must not re-enable autoReset or the draw-call meter collapses
 *  to ~1 and stops measuring anything (GRAPHICS_CONTRACT §5).
 *
 *  Constructed once, at wire time, immediately after `createScene` — it
 *  depends on nothing map-shaped and must be live before the first frame. */
export interface PostHandle {
  /** Re-fits the composer and every pass render target to the renderer's
   *  CURRENT drawing-buffer size. Takes no arguments on purpose: the size and
   *  pixel ratio are read back from the renderer, which `SceneHandle.resize()`
   *  has already set, so the composer and the canvas can never disagree.
   *
   *  R_POST calls this itself from its frame pass whenever it observes the
   *  drawing-buffer size change — `SceneCore` carries no resize hook, so
   *  self-detection is the mechanism that makes a window resize reflow the
   *  stack. It is public so a host that resizes out of band (the capture
   *  harness switching resolutions) can force the re-fit immediately rather
   *  than one frame late. Reallocating targets is expensive: only call it on a
   *  real change. */
  resize(): void;
  /** 0 = full day, 1 = full night, the same value and the same scale as
   *  {@link SceneHandle.setTimeOfDay}. R_WIRE holds both handles and routes
   *  one phase value into both — the scene cannot forward it, see the note
   *  there. Ramps the night state of the stack: bloom strength and radius (the
   *  emissives must be pleasant by day and DOMINANT by night), AO intensity,
   *  and the grade/vignette curve.
   *
   *  It must NOT touch `renderer.toneMapping` or
   *  `renderer.toneMappingExposure`: STYLE_BIBLE §6 gives both to R_SCENE
   *  (NeutralToneMapping, 2.75 -> 1.9), and `OutputPass` inherits them from
   *  the renderer. Two owners of exposure is how a night frame ends up either
   *  black or washed out. */
  setTimeOfDay(t: number): void;
  /** `true` when the composer built and is installed as the frame pass.
   *  `false` means the stack failed to construct (no WebGL2, or a pass threw)
   *  and the scene fell back to a direct `renderer.render` — a readable,
   *  playable degradation, never a blank canvas (GRAPHICS_CONTRACT §5
   *  robustness). The gate asserts `true`: a stack that silently never
   *  installed is indistinguishable from one that was disabled, and the second
   *  is banned. */
  enabled(): boolean;
}

export interface UnitsHandle {
  sync(ents: readonly InterpEnt[], ghosts: readonly GhostEnt[], selfId: number): void;
  setSelected(id: number): void; // -1 = none
  orderMarker(x: number, z: number, attack: boolean): void;
}

export interface FogHandle {
  /** Generated visibility-mask canvas — the minimap (T9) reads this. */
  readonly maskCanvas: HTMLCanvasElement;
  update(snap: SnapMsg): void; // ~5Hz from snapshots
  isVisible(x: number, z: number): boolean;
}

export interface FxHandle {
  burst(x: number, z: number, kind: 'gold' | 'death' | 'tower' | 'phys' | 'magic' | 'heal'): void;
  tracer(x1: number, z1: number, x2: number, z2: number, kind: 'phys' | 'magic' | 'tower'): void;
  shake(amount: number): void;
  damageNumber(x: number, z: number, text: string, cls: 'gold' | 'danger' | 'paper'): void;
  tick(dtMs: number): void;
}

// --- ui/* (T9 owns the implementations) -------------------------------------------
/** Everything any UI module may read, refreshed by game.ts before render. */
export interface ClientState {
  readonly phase: 'menu' | 'lobby' | 'live' | 'ended';
  readonly connected: boolean;
  readonly error: string | null;
  readonly hello: HelloMsg | null;
  readonly lobby: LobbyMsg | null;
  readonly begin: BeginMsg | null;
  readonly snap: SnapMsg | null; // latest raw snapshot
  readonly interp: InterpHandle | null; // live only
  readonly fog: FogHandle | null; // live only (minimap reads maskCanvas)
  readonly end: EndEvent | null;
  readonly events: readonly RiftEvent[]; // last ~32, newest last (killfeed/audio)
  readonly shopOpen: boolean;
  readonly scoreboardOpen: boolean;
  readonly cameraX: number;
  readonly cameraZ: number;
  readonly cameraHeight: number;
  /** Transient cast-denied note from input.ts's preflight (via game.ts), or
   *  null. hud.ts shows it as a `.hint.hint--denied` pill while
   *  performance.now() < untilMs. Additive (T8 bugfix: silent cast failures). */
  readonly toast: { readonly text: string; readonly untilMs: number } | null;
}

/** Everything any UI module may DO. Implemented by game.ts (T8). */
export interface UiActions {
  send(msg: RiftC2S): void;
  toggleShop(): void;
  setScoreboard(open: boolean): void;
  centerCamera(): void;
  panCameraTo(x: number, z: number): void;
  leaveToMenu(): void;
}

export interface UiHandle {
  readonly root: HTMLElement;
  render(s: ClientState, a: UiActions): void;
}

export interface AudioHandle {
  event(ev: RiftEvent): void;
  ui(kind: 'click' | 'buy' | 'error' | 'levelup'): void;
  setPhase(p: 'menu' | 'live'): void;
}

/** The full module set, constructed by wire.ts (orchestrator) and injected
 *  into the Game. game.ts (T8) never imports an implementation module.
 *  UNCHANGED by GRAPHICS_CONTRACT §6: terrain, vegetation and post are held by
 *  wire.ts alone — game.ts has no reason to speak to any of them. */
export interface ClientModules {
  scene: SceneHandle;
  units: UnitsHandle;
  fog: FogHandle;
  fx: FxHandle;
  hud: UiHandle;
  shop: UiHandle;
  minimap: UiHandle;
  menus: UiHandle;
  audio: AudioHandle;
  nameLabels: import('./ui/nameLabels.js').NameLabelsHandle;
}

// Frozen create-function SIGNATURES (bodies are T7's/T9's; wire.ts imports
// them from the implementation modules):
//   T7 render/scene.ts:   export function createScene(parent: HTMLElement): SceneHandle;
//   T7 render/mapMesh.ts: export function buildMapMeshes(scene: SceneHandle, map: MapDef): MapStructureControl;
//     (also installs the same control as `scene.riftStructureControl` — hideStructure(id)
//      zero-scales a dead structure's baked instances; resetStructures() on rematch)
//   T7 render/units.ts:   export function createUnits(scene: SceneHandle, map: MapDef): UnitsHandle;
//   T7 render/fog.ts:     export function createFog(scene: SceneHandle, map: MapDef): FogHandle;
//   T7 render/fx.ts:      export function createFx(scene: SceneHandle): FxHandle;
//   T9 ui/hud.ts:         export function createHud(parent: HTMLElement): UiHandle;
//   T9 ui/shop.ts:        export function createShop(parent: HTMLElement): UiHandle;
//   T9 ui/minimap.ts:     export function createMinimap(parent: HTMLElement): UiHandle;
//   T9 ui/menus.ts:       export function createMenus(parent: HTMLElement): UiHandle;
//   T9 ui/audio.ts:       export function createAudio(): AudioHandle;
//   T8 game.ts:           export class Game { constructor(root: HTMLElement, modules: ClientModules); }
//   T8 interp.ts:         export function createInterp(): InterpHandle;
//
// Frozen SIGNATURES added by GRAPHICS_CONTRACT §6 — the new render modules and
// the four mesh builders. `UnitBuild` comes from render/kit.ts; `MapDef`,
// `StructureKind`, `EntKind`, `HeroId`, `EntTeam` and `TeamId` from
// @rift/shared. Mesh builders are pure: same arguments -> same geometry, all
// variation from the kit's seeded `rng()`, so they may be cached per key.
//   render/terrain.ts:           export function createTerrain(scene: SceneHandle, map: MapDef): TerrainHandle;
//   render/vegetation.ts:        export function createVegetation(scene: SceneHandle, map: MapDef): VegetationHandle;
//   render/post.ts:              export function createPost(scene: SceneHandle): PostHandle;
//   render/meshes/heroes.ts:     export function buildHero(id: HeroId, team: EntTeam): UnitBuild;
//   render/meshes/creeps.ts:     export function buildCreep(kind: EntKind, team: EntTeam): UnitBuild;
//   render/meshes/camps.ts:      export function buildCamp(tier: 'pack' | 'brute' | 'hive'): UnitBuild;
//   render/meshes/structures.ts: export function buildStructure(kind: StructureKind, team: TeamId): UnitBuild;
