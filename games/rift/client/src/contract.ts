// ============================================================================
// ANCIENTS (rift) — CLIENT SEAM. FROZEN Layer-1 contract (listed in
// games/rift/CONTRACT.md §6). Types only, no logic. This is the interface the
// client tasks (T7 render, T8 app shell, T9 UI) build against IN PARALLEL:
// implementations import ONLY these types from each other's territory, never
// each other's modules. Wiring (main.ts, wire.ts) is orchestrator-owned.
// ============================================================================
import type {
  EntKind,
  HeroId,
  RiftC2S,
  RiftEvent,
  RiftS2C,
  TeamId,
} from '@rift/shared';

export type SnapMsg = Extract<RiftS2C, { t: 'rift_snap' }>;
export type LobbyMsg = Extract<RiftS2C, { t: 'rift_lobby' }>;
export type BeginMsg = Extract<RiftS2C, { t: 'rift_begin' }>;
export type HelloMsg = Extract<RiftS2C, { t: 'rift_hello' }>;
export type EndEvent = Extract<RiftEvent, { t: 'rift_end' }>;

// --- interp.ts (T8 owns the implementation) -------------------------------------
export interface InterpEnt {
  id: number;
  k: EntKind;
  team: TeamId;
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
  team: TeamId;
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
 *  into the Game. game.ts (T8) never imports an implementation module. */
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
}

// Frozen create-function SIGNATURES (bodies are T7's/T9's; wire.ts imports
// them from the implementation modules):
//   T7 render/scene.ts:   export function createScene(parent: HTMLElement): SceneHandle;
//   T7 render/mapMesh.ts: export function buildMapMeshes(scene: SceneHandle, map: MapDef): void;
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
