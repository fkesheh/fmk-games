// ============================================================================
// ACES client seams — FROZEN Layer-1 interfaces.
//
// The import law makes app.ts the only composer and forbids siblings from
// importing each other. These are therefore THE shapes through which they
// meet: C_NET implements NetClient, C_FX implements EffectsApi (+ drawCrate),
// C_AUDIO implements AudioApi, C_UI consumes HudModel, C_APP implements
// nothing here but orchestrates all of it. No side may invent extra required
// surface; optional extensions go in each module's own file.
// ============================================================================

import type { CrateState, GameEvent, MatchPhase, ScoreRow } from '@aces/shared/types';
import type { DebugCmd, PlaneClassId, RoomSettings, TeamId } from '@aces/shared/config';
import type { SnapPlane } from '@aces/shared/protocol';

// ---- input -----------------------------------------------------------------------------

/** Sampled by the net sender at TICK_RATE. Pure read; no side effects. */
export interface InputSource {
  readonly th: number; //   −0.3..1
  readonly tr: number; //   −1..1
  readonly fire: boolean;
  readonly boost: boolean;
}

// ---- net --------------------------------------------------------------------------------

export type JoinKind =
  | { kind: 'quick' } //                    lobby quick_join (public room, bot fill)
  | { kind: 'private'; settings: RoomSettings }; // create_private (e2e/debug/friends)

export interface NetHandlers {
  onWelcome(w: { id: string; seed: number; tickRate: number; snapRate: number; settings: Required<RoomSettings>; roster: ScoreRow[] }): void;
  onSnapshot(fn: (snap: SnapshotView) => void): void;
  onEvent(e: GameEvent): void;
  onPhase(phase: MatchPhase, endsAtS: number, winner: TeamId | undefined): void;
  onScore(board: ScoreRow[]): void;
  onClose(): void;
}

/** Minimal view of a snapshot msg — see protocol.ts SnapshotMsg. */
export interface SnapshotView {
  tick: number;
  phase: MatchPhase;
  timeLeftS: number;
  tickets: { royal: number; iron: number };
  you: SnapPlane | undefined;
  planes: SnapPlane[];
  bullets: ReadonlyArray<{ id: number; team: TeamId; x: number; y: number; vx: number; vy: number }>;
  crates: readonly CrateState[];
  rttMs: number;
}

/** C_NET's product. App owns exactly one. */
export interface NetClient {
  connect(name: string, join: JoinKind, handlers: NetHandlers): Promise<void>;
  sendInput(frame: { seq: number; th: number; tr: number; fire: boolean; boost: boolean }): void;
  sendSpawn(cls: PlaneClassId): void;
  /** Debug verbs — server ignores them unless the room was created with debug. */
  sendDebug(cmd: DebugCmd, x?: number, y?: number): void;
  close(): void;
  rttMs(): number;
}

// ---- fx -----------------------------------------------------------------------------------

/** Screen-space projection result (HUD consumes; computed by C_APP's camera rig). */
export interface ScreenPoint {
  sx: number;
  sy: number;
  visible: boolean;
}

/**
 * ACES 3D (GRAPHICS_3D.md §2): camera-rig view handed to render consumers.
 * x/y = camera world position (server coords), zoom = CAM_DISTANCE multiplier
 * (the __ACES.zoomTo pin, 1 = default chase distance). `project` maps server-
 * world coordinates to screen pixels via the perspective camera — HUD uses
 * this for crosshair, lead pip, target markers and edge arrows.
 */
export interface CameraView {
  x: number;
  y: number;
  zoom: number;
  project(wx: number, wy: number, wz?: number): ScreenPoint;
}

/**
 * C_FX's consumer API. All emit methods are fire-and-forget; the system
 * owns pooling, lifetimes and its seeded rng. SHAKE magnitudes come from
 * config.SHAKE (SMALL/MEDIUM/LARGE).
 */
export interface EffectsApi {
  muzzleFlash(x: number, y: number, h: number): void;
  /** Cosmetic local tracer fired optimistically at trigger-down (RULES 10). */
  tracerStub(x: number, y: number, h: number): void;
  /** Snapshot projectiles rendered as tracer rounds (world-space). */
  drawProjectiles(ctx: CanvasRenderingContext2D, bullets: ReadonlyArray<{ x: number; y: number; vx: number; vy: number }>): void;
  hitSpark(x: number, y: number, angle: number): void;
  explosion(x: number, y: number, size: 'small' | 'large', overWater: boolean): void;
  /** Per-frame trail emitter hook for smoking/burning planes. */
  trail(id: string, x: number, y: number, level: 'smoke' | 'fire' | null): void;
  crateFx(kind: 'land' | 'pickup', x: number, y: number): void;
  shake(mag: number): void;
  /** Accumulated shake magnitude since last call (app adds to camera); resets to 0. */
  consumeShake(): number;
  update(dt: number): void;
  draw(ctx: CanvasRenderingContext2D, cam: CameraView): void;
}

// ---- audio ------------------------------------------------------------------------------------

export interface AudioApi {
  unlock(): Promise<void>;
  setMuted(muted: boolean): void;
  /** Own-plane engine voice; called each frame with smoothed values. */
  ownEngine(throttle: number, speedFrac: number, boosting: boolean): void;
  shot(own: boolean, distU: number): void;
  hitConfirm(): void; //    YOU landed a hit
  hurt(): void; //          YOU took a hit
  killConfirm(): void;
  explosion(distU: number): void;
  pickup(): void;
  overheatJam(): void;
  streak(n: number): void;
  ui(kind: 'click' | 'spawn' | 'win' | 'lose'): void;
  wind(speedFrac: number): void;
}

// ---- hud model ----------------------------------------------------------------------------------

/** Live combat overlay data — recomputed by C_APP each frame alongside HudModel. */
export interface OverlayModel {
  alive: boolean;
  heading: number;
  speedFrac: number; //   speed / class speedMax
  heat: number;
  jammed: boolean;
  /** Enemy planes in snapshot order, world-space (HUD projects for edge arrows). */
  targets: ReadonlyArray<{ x: number; y: number; team: TeamId; cls: PlaneClassId; hpFrac: number }>;
  cam: CameraView;
  /** Snapshot ticks of the last own-hit-confirm / own-hurt (marker & arc flashes). */
  hitConfirmTick: number;
  hurtTick: number;
}

export interface KillFeedEntry {
  id: number;
  killerName: string;
  victimName: string;
  killerTeam: TeamId;
  crash: boolean;
  killerCls: PlaneClassId;
  bornTick: number;
}

export interface Banner {
  kind: 'ace' | 'legend' | 'suddendeath';
  text: string;
  bornTick: number;
}

/**
 * Everything the HUD renders, assembled by C_APP from snapshots + events.
 * C_UI holds NO network objects of its own — this is the whole world it sees.
 * `tick` is the last-applied snapshot tick (drives killfeed/banner expiry).
 */
export interface HudModel {
  tick: number;
  phase: MatchPhase;
  timeLeftS: number;
  suddenDeath: boolean;
  tickets: { royal: number; iron: number };
  you: {
    cls: PlaneClassId;
    team: TeamId;
    hp: number;
    maxHp: number;
    heat: number;
    jammed: boolean;
    boost: number;
    throttle: number;
    alive: boolean;
    respawnT: number;
    streak: number;
  } | null; //            null while spectating pre-first-spawn
  board: ScoreRow[];
  feed: readonly KillFeedEntry[];
  banners: readonly Banner[];
  muted: boolean;
}

// ---- creator signatures (each module exports EXACTLY this factory) ------------------------------
//
// C_NET      createNet(): NetClient
// C_FX       createEffects(seed: number): EffectsApi
//            drawPlane(ctx, sp: SnapPlane, t): void   — world-space, planes.ts
//            drawCrate(ctx, c: CrateState, t): void   — world-space, planes.ts
// C_AUDIO    createAudio(): AudioApi
// C_WORLD    createWorldRenderer(canvas, map): { drawBelow(ctx,cam,t); drawAbove(ctx,cam,t);
//            resize(w,h) } — canvas is the main world canvas; bake happens lazily on first draw
// C_UI       createHud(hudCanvas) → { update(m: HudModel, o: OverlayModel): void; destroy(): void }
//            createScreens(root, hooks) → Screens (see below), DOM injected under root
// C_APP      startAces(container: HTMLElement): AcesApp — AcesApp = { destroy(): void }
//
// export interface Screens {
//   showMenu(prefName: string): void;
//   showConnecting(): void;
//   showLobby(countdownS: number | null, roster: ScoreRow[]): void; // null = no countdown running
//   showMatchUI(): void;
//   showDeath(respawnT: number, lastCls: PlaneClassId): void;
//   showEnd(board: ScoreRow[], winner: TeamId | undefined): void;
//   showDisconnected(retrying: boolean): void;
//   hideAll(): void;
// }
//
// Camera convention: C_APP applies the world transform (pan+zoom+DPR) before
// calling render modules — they draw in WORLD units. HUD overlay + grain +
// vignette draw in SCREEN space after the transform is reset.
