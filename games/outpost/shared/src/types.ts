// ============================================================================
// FROZEN CONTRACT — OUTPOST types.
//
// Types only. No logic, no values (except the INPUT_* bit constants, which are
// wire vocabulary). This file must typecheck standing alone.
//
// WHY THE SERVER ENTITY STRUCTS LIVE HERE (and not in server/src/):
// The previous OUTPOST froze file OWNERSHIP but not the simulation's TYPES.
// Five server implementers each invented a different shape for the same
// entities and deadlocked. Every struct that more than one server module
// touches — Survivor, Zombie, FenceSegment, Spit, SimContext — is therefore a
// cross-module boundary and is frozen HERE. An implementer never designs a
// shape a sibling also has to know.
//
// COORDINATES (inherited from STRICKEN, unchanged):
//   x east, z south, y up. Ground plane at y = 0. Positions are FEET
//   positions; eye = feet + height - PLAYER.eyeOffset.
//   yaw 0 = -Z (north), increases CCW seen from above; forward = (-sin, -cos).
// ============================================================================

import type { AABB, BodyState, WeaponId } from '@fps/shared';
import type { PlayerId } from '@platform/shared';

export type { PlayerId };

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Dense pooled index into SimContext.zombies. Stable while the zombie lives. */
export type ZombieId = number;
/** Index into SimContext.segments — 0..FENCE.segments-1, clockwise from NW. */
export type SegmentId = number;
/** Dense pooled index into SimContext.spits. */
export type SpitId = number;

export type ZombieKind = 'shambler' | 'runner' | 'brute' | 'spitter';

/**
 * Zombie behaviour state. A zombie ALWAYS exits every state on death or when
 * its target stops existing — a dangling target reference was the #1 crash
 * class in the previous build.
 */
export type ZombieState =
  | 'approach' // walking from the spawn ring toward its chosen segment
  | 'attackFence' // in reach of an intact segment, chewing it
  | 'pursue' // inside the compound (or through a breach), chasing a survivor
  | 'attackPlayer' // in melee reach of a survivor
  | 'dying'; // death animation is playing; no longer collides or damages

export type Phase =
  | 'lobby' // seated, nobody has pressed START; the room never auto-starts
  | 'wave' // zombies are spawning / alive
  | 'intermission' // wave cleared; repair, shop, dead survivors return
  | 'ended'; // every survivor is dead — the run is over

/**
 * `alive` — fighting. `downed` — bleeding out, immobile, revivable by a
 * teammate. `dead` — bled out; returns at the next wave start unless the run
 * ended first.
 */
export type SurvivorStatus = 'alive' | 'downed' | 'dead';

/** Which interactable a survivor is standing in range of (nearest wins). */
export type InteractKind =
  | 'none'
  | 'repair' // a damaged or breached fence segment
  | 'revive' // a downed teammate
  | 'weaponRack' // tower deck 1
  | 'ammoCrate'; // tower ground floor

/** Time-of-day mood. The run starts at dusk and darkens as waves advance. */
export type TimeOfDay = 'dusk' | 'night';

// ---------------------------------------------------------------------------
// Server-authoritative entity structs (cross-module — frozen)
// ---------------------------------------------------------------------------

/** Per-weapon ammunition. mag/reserve are -1 for melee (knife). */
export interface Ammo {
  mag: number;
  reserve: number;
}

/**
 * One seated player. Humans only — OUTPOST has no bot survivors; wave size
 * scales to the headcount instead (see `waveSize`).
 */
export interface Survivor {
  readonly id: PlayerId;
  name: string;
  /** false = socket dropped but the seat is held for rejoin (a "ghost"). */
  connected: boolean;
  /** Durable browser identity for rejoin; null for a fresh seat. */
  sig: string | null;

  // --- movement (advanced by STRICKEN's shared stepBody) ---
  body: BodyState;
  yaw: number;
  pitch: number;

  // --- co-op state ---
  hp: number; // 0..SURVIVOR.maxHp
  status: SurvivorStatus;
  /** serverTime ms of the last damage taken; gates SURVIVOR.regenDelaySec. */
  lastDamageAt: number;
  /** Seconds of bleedout remaining while `downed`; 0 otherwise. */
  bleedout: number;
  /** 0..1 revive progress being applied BY someone else this tick. */
  reviveProgress: number;
  /** Who is currently reviving this survivor, or null. */
  reviveBy: PlayerId | null;
  /** Wave this survivor may re-enter at (set on death). */
  returnAtWave: number;

  // --- economy ---
  scrap: number;

  // --- weapons (STRICKEN's WEAPONS table, unchanged) ---
  /** Owned, current first. Knife + pistol are issued; max SURVIVOR.firearmSlots firearms. */
  weapons: WeaponId[];
  weapon: WeaponId;
  ammo: Map<WeaponId, Ammo>;
  reloadUntil: number; // serverTime ms, 0 = not reloading
  nextShotAt: number; // serverTime ms
  bloom: number; // accumulated spread, degrees
  shotSeq: number; // monotonic; feeds shotSeed for deterministic spread

  // --- interaction ---
  interacting: boolean; // INPUT_INTERACT held this tick
  interactKind: InteractKind;
  interactTarget: number; // SegmentId, or -1; for 'revive' the target is reviveTargetId
  reviveTargetId: PlayerId | null;

  // --- run stats (the end screen reads these) ---
  kills: number;
  headshots: number;
  damageDealt: number;
  repairHp: number; // total fence HP restored
  revivesGiven: number;
  timesDowned: number;

  // --- netcode plumbing (mirrors STRICKEN's proven shape) ---
  inputQueue: InputMsg[];
  lastProcessedSeq: number;
  lastInputAt: number;
  prevButtons: number;
  inputWindow: number;
  inputWindowCount: number;
}

export interface Zombie {
  readonly id: ZombieId;
  kind: ZombieKind;
  alive: boolean; // false = free pool slot
  hp: number;
  maxHp: number;
  /**
   * Feet position + velocity + onGround, advanced by the SAME `stepBody` the
   * survivors use. This is a persistent BodyState, not a per-tick scratch
   * object, for two reasons: `stepBody`'s step-up assist is gated on
   * `b.onGround`, so rebuilding the body each tick silently breaks rubble and
   * stair traversal; and 48 zombies x 30 Hz of allocation violates the
   * no-hot-path-allocation rule. The first draft had loose x/y/z/vx/vz with no
   * vy and no onGround, which made the contract's own mandate unimplementable.
   */
  body: BodyState;
  yaw: number;
  /**
   * PRESENTATION + MELEE REACH ONLY — NOT collision.
   *
   * `stepBody` force-resets `b.height` to PLAYER.heightStand on every call and
   * tests overlap at the module constant PLAYER.radius, neither of which is
   * parameterised. So every actor in this game, survivor or brute, COLLIDES as
   * a 0.6 m-wide, 1.8 m-tall box. These fields drive the model, the melee reach
   * check, and `HitscanTarget.height` (which IS honoured, so a brute really is
   * a taller target to shoot — just not a wider one).
   * Documented rather than silently divergent: `@fps/shared` is read-only.
   */
  height: number;
  radius: number;
  speed: number; // m/s, from zombieStats
  state: ZombieState;
  /** Segment being attacked, or -1. MUST be reset to -1 when the segment breaches. */
  targetSeg: SegmentId;
  /** Survivor being pursued, or null. MUST be nulled when they die/disconnect. */
  targetPlayer: PlayerId | null;
  /** serverTime ms of the next allowed retarget; throttled by HORDE.retargetSec. */
  retargetAt: number;
  attackCooldown: number; // seconds until the next swing lands
  spitCooldown: number; // seconds until the next spit (spitter only)
  dyingFor: number; // seconds spent in 'dying'; freed at HORDE.corpseSec
  /** Animation phase 0..1, advanced by speed; the client uses it for gait. */
  gait: number;
}

export interface FenceSegment {
  readonly id: SegmentId;
  hp: number; // 0 = breached
  readonly maxHp: number;
  breached: boolean;
  /** Rebuild progress 0..1 while a breached segment is being repaired. */
  rebuild: number;
  /** Seconds since a zombie last struck it — drives the client's shake/dust. */
  sinceHit: number;
}

/** Spitter projectile: a gravity-arced acid glob. The only non-hitscan damage. */
export interface Spit {
  readonly id: SpitId;
  alive: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  ttl: number; // seconds before it fizzles
  ownerId: ZombieId;
}

// ---------------------------------------------------------------------------
// The star-shaped context handle — every server system takes exactly this
// ---------------------------------------------------------------------------

/**
 * Everything a simulation system may touch, in one handle. Systems are PURE
 * with respect to I/O: no Date.now, no timers, no sockets. The room owns the
 * clock and passes `tick`/`dt`; randomness arrives through `rand` so every
 * test is deterministic.
 */
export interface SimContext {
  tick: number;
  dt: number; // seconds; always TICK_DT
  serverTime: number; // ms, the room's Date.now() sampled once per tick
  phase: Phase;
  wave: number;

  survivors: Map<PlayerId, Survivor>;
  /** Pooled; iterate and skip `!alive`. Never resized during a tick. */
  zombies: Zombie[];
  segments: FenceSegment[];
  /** Pooled; iterate and skip `!alive`. */
  spits: Spit[];

  /** Static world geometry — tower, terrain blockers. NEVER mutated. */
  staticSolids: readonly AABB[];
  /**
   * staticSolids + the AABBs of every INTACT fence segment. Rebuilt by the
   * room (via `rebuildSolids`) whenever a segment breaches or is rebuilt, and
   * never in between. This is what stepBody and hitscan are given.
   */
  solids: AABB[];

  rand(): number;
  emit(ev: OutpostEvent): void;
  /** Ask the room to recompute `solids` after a breach/rebuild. */
  rebuildSolids(): void;
}

// ---------------------------------------------------------------------------
// Pure system signatures (frozen — implementers fill bodies only)
// ---------------------------------------------------------------------------

/** Per-kind tuning resolved for a given wave. */
export interface ZombieStats {
  hp: number;
  speed: number; // m/s
  height: number;
  radius: number;
  meleeDmg: number;
  meleeReach: number; // metres, centre-to-centre
  meleeInterval: number; // seconds between swings
  fenceDps: number;
  scrap: number; // reward for a kill
}

// --- waves.ts (pure) -------------------------------------------------------

/** Total zombies in wave `wave` for `players` seated survivors. */
export type WaveSizeFn = (wave: number, players: number) => number;

/** The kind roster for one wave, length `count`, respecting unlock waves. */
export type WaveCompositionFn = (wave: number, count: number, rand: () => number) => ZombieKind[];

/** Per-kind stats scaled for `wave`. HP scales with wave only, never headcount. */
export type ZombieStatsFn = (kind: ZombieKind, wave: number) => ZombieStats;

// --- horde.ts (pure) -------------------------------------------------------

/**
 * Advance every living zombie one tick: steering toward its target, fence
 * chewing, breach traversal, melee, spitter fire, corpse retirement.
 * Mutates ctx.zombies / ctx.segments / survivors in place and emits events.
 */
export type StepHordeFn = (ctx: SimContext) => void;

/**
 * Place one zombie of `kind` on the spawn ring and claim a free pool slot.
 * Returns the id, or -1 when the pool is at HORDE.maxAlive.
 */
export type SpawnZombieFn = (ctx: SimContext, kind: ZombieKind, wave: number) => ZombieId;

/** Advance spitter projectiles: gravity, ground/solid impact, splash damage. */
export type StepSpitsFn = (ctx: SimContext) => void;

// --- fence.ts (pure) -------------------------------------------------------

/**
 * Apply `dmg` to a segment. Breaches it at <= 0 hp (sets breached, clears any
 * zombie's targetSeg pointing at it, emits 'breach', calls rebuildSolids).
 */
export type DamageSegmentFn = (ctx: SimContext, seg: SegmentId, dmg: number) => void;

/**
 * One tick of a survivor repairing a segment. Consumes scrap, restores hp,
 * un-breaches at full rebuild. Returns hp actually restored (0 if unaffordable).
 */
export type RepairSegmentFn = (ctx: SimContext, s: Survivor, seg: SegmentId) => number;

/** The AABBs of every intact segment, in segment order. */
export type FenceSolidsFn = (segments: readonly FenceSegment[]) => AABB[];

/** Nearest segment to a world point, and its centre distance. */
export type NearestSegmentFn = (x: number, z: number) => { seg: SegmentId; dist: number };

// --- survivors.ts (pure) ---------------------------------------------------

/**
 * Damage a survivor. At <= 0 hp an `alive` survivor goes `downed` with a full
 * bleedout timer (emitting 'downed'); a `downed` survivor dies (emitting
 * 'died'). Returns credited damage.
 */
export type DamageSurvivorFn = (
  ctx: SimContext,
  victim: Survivor,
  dmg: number,
  fromZombie: ZombieId | null,
) => number;

/** Tick bleedout on every downed survivor; kill those who reach 0. */
export type StepDownedFn = (ctx: SimContext) => void;

/**
 * Resolve revive intent for every survivor holding INTERACT near a downed
 * teammate: accumulate progress, complete at DOWNED.holdSec, reset when the
 * reviver stops/moves out of range.
 */
export type StepRevivesFn = (ctx: SimContext) => void;

/** Nearest interactable for a survivor this tick; writes s.interact* fields. */
export type ResolveInteractFn = (ctx: SimContext, s: Survivor) => void;

/** True when every seated survivor is downed or dead — the run-over test. */
export type IsSquadWipedFn = (survivors: ReadonlyMap<PlayerId, Survivor>) => boolean;

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

/** Input bitfield. Bits 0-4 are STRICKEN's, unchanged. Bit 5 is OUTPOST's. */
export const INPUT_FIRE = 1 << 0;
export const INPUT_JUMP = 1 << 1;
export const INPUT_CROUCH = 1 << 2;
export const INPUT_ALT = 1 << 3; // right mouse / scope
export const INPUT_WALK = 1 << 4;
export const INPUT_INTERACT = 1 << 5; // hold E — repair / revive / buy
export const INPUT_MASK = 0x3f;

export interface InputMsg {
  t: 'input';
  seq: number; // monotonic per client, starts at 1
  moveX: number; // -1..1 strafe right positive
  moveZ: number; // -1..1 forward positive
  yaw: number; // radians
  pitch: number; // radians, clamped +/-1.45
  buttons: number; // INPUT_* bitfield
}

export type C2S =
  | InputMsg
  | { t: 'reload' }
  | { t: 'switch'; weapon: WeaponId }
  | { t: 'buy_weapon'; weapon: WeaponId }
  | { t: 'buy_ammo' }
  /**
   * `seed` makes a run reproducible. Without it, wave composition, spawn
   * angles and therefore which segment breaches are all server-random, so a
   * capture round cannot be compared before/after an art fix and a failed
   * horde gate cannot be reproduced to debug. The mature reference harness
   * (scripts/e2e-splat.mjs) seeds its runs for exactly this reason.
   */
  | { t: 'start'; seed?: number }
  | { t: 'ping'; ts: number }
  | DebugMsg;

/**
 * THE DEBUG WIRE. Every staging verb on `OutpostDebugApi` mutates
 * SERVER-AUTHORITATIVE state — hp, body position, segment hp, the horde, the
 * phase, damage immunity — so none of them can be faked client-side: the next
 * snapshot would overwrite it, which is exactly the "a screenshot is a lie"
 * failure the debug surface exists to prevent.
 *
 * The first draft froze the six methods and no message that could carry them,
 * making the ENTIRE verification layer unimplementable while everything still
 * compiled. The horde gate needs `spawn` to place 6 zombies inside 12 m; the
 * perf gate needs it to reach HORDE.maxAlive; the two-client revive e2e needs
 * `hurt`; the breach shot needs `breach`; `invuln` exists because the previous
 * harness's player was eaten by wave 1 before a single photograph was taken.
 *
 * OWNER: `server/src/room.ts` handles this message and is the ONLY module that
 * may. It calls into fence/horde/survivors through their normal public
 * functions — it never reaches past them. Named here because an op that
 * crosses four modules with no named owner is how the previous build ended up
 * with an event that three files documented and nobody emitted.
 */
export interface DebugMsg {
  t: 'debug';
  op: 'hurt' | 'teleport' | 'breach' | 'spawn' | 'end' | 'invuln';
  /** hurt: damage · teleport: x · breach: SegmentId · spawn: x · invuln: 0|1 */
  a?: number;
  /** teleport: y · spawn: z */
  b?: number;
  /** teleport: z */
  c?: number;
  /** spawn: which kind */
  kind?: ZombieKind;
}

/**
 * Wire view of a survivor. Compact field names: 48 zombies + 16 survivors at
 * the snapshot rate (NETCODE.snapshotEveryTicks) is the bandwidth budget, and this is the hot path.
 */
export interface SurvivorSnap {
  id: PlayerId;
  /**
   * Display name. On the wire per-snapshot because nameplates, the
   * through-geometry downed markers and the live scoreboard all need it and
   * `ClientCtx` has no roster accessor — the first draft mandated all three
   * features from data that existed nowhere on the wire.
   */
  n: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  hp: number;
  st: SurvivorStatus;
  cr: boolean; // crouching
  mv: boolean; // horizontal speed > 0.5 m/s (walk anim + footsteps)
  w: WeaponId;
  /** 0..1 revive progress being applied to this survivor right now. */
  rev: number;
  /**
   * WHO is reviving them, or null. Needed while the revive is IN PROGRESS —
   * the `revived` event only fires on completion, which is too late to answer
   * the UX bible's "Downed: … and whether anyone is coming". Without it the
   * client can only guess by nearest-alive-teammate, which names the wrong
   * person whenever two survivors converge on the same casualty.
   */
  revBy: PlayerId | null;
  /** Seconds of bleedout remaining, 0 when not downed. Drives the teammate marker. */
  bl: number;
  /** Live kill count — the TAB scoreboard is fed from the snapshot, not from
   *  join-time roster values frozen for the whole run. */
  k: number;
  /** Live revives-given count. Social contribution is scored as visibly as kills. */
  rv: number;
}

export interface ZombieSnap {
  id: ZombieId;
  k: ZombieKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** hp as 0..1 of max — the client never needs absolute zombie HP. */
  hp: number;
  st: ZombieState;
  /** gait phase 0..1 for walk animation */
  g: number;
}

export interface SegmentSnap {
  /** hp as 0..1 of max. */
  hp: number;
  /**
   * Breached. EXPLICIT rather than inferred from `hp === 0`: a segment being
   * rebuilt has hp climbing from 0 while still breached, so the inference is
   * wrong exactly when the player most needs the fence ring to be right.
   */
  br: boolean;
  /** rebuild progress 0..1 while breached */
  rb: number;
}

export interface SpitSnap {
  id: SpitId;
  x: number;
  y: number;
  z: number;
}

/** Private per-recipient state, sent every snapshot. */
export interface YouSnap {
  hp: number;
  status: SurvivorStatus;
  bleedout: number; // seconds remaining, 0 when not downed
  scrap: number;
  weapons: WeaponId[];
  weapon: WeaponId;
  mag: number; // -1 for melee
  reserve: number; // -1 for melee
  /** authoritative vertical velocity — client prediction replays gravity from it */
  vy: number;
  interact: InteractKind;
  /** 0..1 progress of the hold-action the player is performing right now */
  interactProgress: number;
  /** cost in scrap of the action currently offered, or 0 */
  interactCost: number;
  /** wave this survivor returns at, when dead */
  returnAtWave: number;
}

export interface SnapshotMsg {
  t: 'snapshot';
  tick: number;
  serverTime: number;
  ack: number; // last processed input seq for this recipient
  phase: Phase;
  wave: number;
  /** ms timestamp the current phase ends (intermission), else 0 */
  phaseEndsAt: number;
  /** zombies still to spawn + alive, this wave */
  waveRemaining: number;
  tod: TimeOfDay;
  players: SurvivorSnap[];
  zombies: ZombieSnap[];
  /** length is always FENCE.segments, index = SegmentId */
  segments: SegmentSnap[];
  spits: SpitSnap[];
  you: YouSnap;
  seated: number;
  minPlayers: number;
  canStart: boolean;
}

export interface RosterEntry {
  id: PlayerId;
  name: string;
  status: SurvivorStatus;
  kills: number;
  revivesGiven: number;
  connected: boolean;
}

export interface RunStats {
  id: PlayerId;
  name: string;
  kills: number;
  headshots: number;
  damage: number;
  repairHp: number;
  revivesGiven: number;
  timesDowned: number;
}

export type OutpostEvent =
  | { t: 'shot'; shooterId: PlayerId; weapon: WeaponId; from: Vec3W; to: Vec3W }
  // `shooterId` is required: every client receives every `hit`, so without it
  // the HUD fires a hitmarker on all 15 teammates' hits — constantly, in a
  // 16-player game. Clients must filter to their own id.
  | { t: 'hit'; shooterId: PlayerId; zombieId: ZombieId; dmg: number; headshot: boolean; killed: boolean }
  | { t: 'zombie_died'; zombieId: ZombieId; kind: ZombieKind; x: number; y: number; z: number; byId: PlayerId | null; scrap: number }
  | { t: 'dmg_taken'; victimId: PlayerId; dmg: number; yaw: number }
  | { t: 'downed'; id: PlayerId; x: number; y: number; z: number }
  | { t: 'revived'; id: PlayerId; byId: PlayerId }
  | { t: 'died'; id: PlayerId }
  | { t: 'returned'; id: PlayerId }
  | { t: 'seg_hit'; seg: SegmentId; hp: number }
  | { t: 'seg_breached'; seg: SegmentId }
  | { t: 'seg_repaired'; seg: SegmentId; byId: PlayerId; full: boolean }
  | { t: 'wave_start'; wave: number; count: number; tod: TimeOfDay }
  | { t: 'wave_clear'; wave: number; intermissionEndsAt: number }
  | { t: 'buy_result'; ok: boolean; weapon: WeaponId | null; reason: string | null }
  | { t: 'spit_land'; x: number; y: number; z: number }
  | { t: 'run_end'; wave: number; stats: RunStats[] }
  | { t: 'player_joined'; entry: RosterEntry }
  | { t: 'player_left'; id: PlayerId };

/** Local 3-vector on the wire (structurally identical to STRICKEN's Vec3). */
export interface Vec3W {
  x: number;
  y: number;
  z: number;
}

export interface JoinedMsg {
  t: 'joined';
  roomId: string;
  code: string | null;
  you: PlayerId;
  tick: number;
  serverTime: number;
  phase: Phase;
  wave: number;
  roster: RosterEntry[];
}

export type S2C =
  | JoinedMsg
  | SnapshotMsg
  | { t: 'event'; ev: OutpostEvent }
  | { t: 'pong'; ts: number; serverTime: number }
  | { t: 'error'; code: string; message: string };

/** Parse + sanitise a raw decoded value into a C2S, or null. MUST NEVER THROW. */
export type ParseC2SFn = (raw: unknown) => C2S | null;

// ---------------------------------------------------------------------------
// Client context handle — the integrator builds it, every client module takes it
// ---------------------------------------------------------------------------

/**
 * Everything a client module may reach. If a HUD/renderer needs a value that
 * is not here, that is a CONTRACT GAP to report — not a reason to edit the
 * contract or to reach into a sibling module.
 */
export interface ClientCtx {
  readonly scene: import('three').Scene;
  readonly camera: import('three').PerspectiveCamera;
  /** Seconds since the client booted; monotonic, used for all animation phase. */
  now(): number;
  /** Server clock estimate in ms. */
  serverNow(): number;
  /** Latest snapshot, or null before the first one arrives. */
  snap(): SnapshotMsg | null;
  /** This client's own player id, or null before `joined`. */
  youId(): PlayerId | null;
  /** Interpolated survivor views for this render frame (reused array — do not retain). */
  survivors(): readonly SurvivorSnap[];
  /** Interpolated zombie views for this render frame (reused array — do not retain). */
  zombies(): readonly ZombieSnap[];
  /** Deterministic RNG for cosmetic variation. Math.random is a violation. */
  rand(seed: number): number;
  /** Current mood; renderers read this rather than deriving it. */
  tod(): TimeOfDay;
  /** Play a synthesized sound effect. */
  sfx(kind: SfxKind, opts?: SfxOpts): void;
  /** Add camera trauma 0..1 (screen shake). */
  shake(amount: number): void;
}

// ---------------------------------------------------------------------------
// CLIENT SEAM TYPES — frozen for exactly the reason the server structs are.
//
// The first draft wrote these as `export interface HudState { … }` and
// `constructor(root, cb: MenuCallbacks); …` in prose, and defined them nowhere.
// That is the deadlock this file's header describes, moved to the client: the
// integrator (`cl-game`) must construct a HudState that `ui-hud` is inventing
// in parallel, a MenuCallbacks that `ui-menus` is inventing in parallel, and
// consume a Predictor that `cl-net` is inventing in parallel — with the rules
// forbidding all four from reading each other's files. `{ … }` is not a
// contract.
// ---------------------------------------------------------------------------

/** One frame's worth of everything the HUD displays. See UX_BIBLE tiers 1+2. */
export interface HudState {
  // --- tier 1: always visible ---
  hp: number;
  status: SurvivorStatus;
  /** Seconds of your own bleedout remaining; 0 when not downed. */
  bleedout: number;
  scrap: number;
  weapon: WeaponId;
  weaponName: string;
  mag: number; // -1 for melee
  reserve: number; // -1 for melee
  phase: Phase;
  wave: number;
  /** zombies still to spawn + alive this wave */
  waveRemaining: number;
  /** ms until the current phase ends (intermission countdown); 0 otherwise */
  phaseEndsInMs: number;
  /** The fence ring: index === SegmentId, length always FENCE.segments. */
  segments: readonly SegmentSnap[];
  /** Player yaw, so the ring can be oriented to their facing. */
  yaw: number;

  // --- tier 2: contextual ---
  interact: InteractKind;
  interactProgress: number; // 0..1
  interactCost: number; // scrap; 0 when free or not applicable
  /** Non-empty only for `weaponRack`, whose prompt lists several priced items. */
  interactOptions: readonly { weapon: WeaponId; price: number; affordable: boolean }[];
  /** Downed teammates, for the through-geometry markers. */
  downed: readonly { id: PlayerId; name: string; dist: number; bleedout: number; beingRevived: boolean }[];
  /**
   * 0..1 revive progress being applied TO YOU while you are downed, and who by.
   * `interactProgress` above is the hold-action YOU are performing, which a
   * downed survivor by definition isn't — so without this the UX bible's
   * "Downed: … and whether anyone is coming" had no data channel at all.
   */
  ownReviveProgress: number;
  ownReviveBy: string | null;
  /**
   * The event ticker, newest last, already trimmed to what should be on screen.
   * The UX bible mandates a killfeed where wave and breach events outrank
   * kills; `banner()` is a one-shot title and cannot express a rolling list.
   */
  ticker: readonly { text: string; kind: 'kill' | 'wave' | 'breach' | 'down' | 'revive' }[];
  /** Squad state for the scoreboard overlay. */
  squad: readonly { id: PlayerId; name: string; status: SurvivorStatus; kills: number; revives: number }[];

  // --- run/session ---
  seated: number;
  minPlayers: number;
  canStart: boolean;
  you: PlayerId | null;
  spectating: PlayerId | null;
  returnAtWave: number;
  crosshairSpreadPx: number;
  scoped: boolean;
}

/**
 * The HUD surface the integrator drives.
 *
 * `rects()` and `visible()` are NOT optional extras: every visual gate
 * (`minMedianLuma`, `maxShadowShare`, `maxBlowoutShare`, `minSurfaceStddev`,
 * `minHordePixelShare`) is measured over "the 3D region" = canvas minus the HUD
 * rects, and `telemetry().hudRect` is what feeds it. Without a producer on the
 * frozen HUD surface, `cl-game` and `ui-hud` — written in parallel, forbidden
 * from reading each other — would have had to invent the one field the entire
 * aesthetic gate depends on.
 */
export interface HudApi {
  onStart: (() => void) | null;
  update(s: HudState): void;
  hitmarker(headshot: boolean, killed: boolean): void;
  damageFrom(yawRelative: number, dmg: number): void;
  banner(title: string, sub: string): void;
  teammateDown(id: PlayerId, name: string, on: boolean): void;
  runEnd(info: { wave: number; stats: readonly RunStats[] } | null): void;
  show(on: boolean): void;
  /** Device-pixel rects of every visible HUD element. Feeds telemetry().hudRect. */
  rects(): readonly { x: number; y: number; w: number; h: number }[];
  /** Whether the HUD is currently shown. Feeds telemetry().hudVisible. */
  visible(): boolean;
}

export interface MenuCallbacks {
  onQuickJoin(name: string): void;
  onCreatePublic(name: string): void;
  onCreatePrivate(name: string): void;
  onJoinPrivate(name: string, code: string): void;
  onListRooms(): Promise<import('@platform/shared').RoomInfo[]>;
  onStart(): void;
  onBuyWeapon(weapon: WeaponId): void;
  onBuyAmmo(): void;
  onResume(): void;
  onLeave(): void;
}

/** The menu layer surface `cl-game` and `cl-main` drive. */
export interface MenusApi {
  showMain(errorText?: string): void;
  showInRoom(code: string | null): void;
  showJoining(subtitle?: string): void;
  showLobby(seated: readonly RosterEntry[], canStart: boolean): void;
  showIntermission(secondsLeft: number, wave: number): void;
  hideIntermission(): void;
  showWeaponRack(scrap: number, owned: readonly WeaponId[]): void;
  showAmmoCrate(scrap: number, cost: number): void;
  showPause(): void;
  showSpectating(returnAtWave: number): void;
  showRunEnd(info: { wave: number; stats: readonly RunStats[] } | null): void;
  showOnboarding(): void;
  /** One-time contextual teach; fires once ever per key (localStorage). */
  hint(key: 'stairs' | 'repair' | 'revive', text: string): void;
  modalOpen(): boolean;
  /** Count of open MODAL layers — telemetry().overlays is read from this. */
  overlayCount(): number;
  hideAll(): void;
}

/** Client-side prediction over @fps/shared stepBody. Mirrors STRICKEN's. */
export interface PredictorApi {
  reset(x: number, y: number, z: number): void;
  pushInput(seq: number, input: import('@fps/shared').MoveInput, speedMul: number): void;
  reconcile(
    x: number, y: number, z: number,
    height: number, vy: number, ackSeq: number, speedMul: number,
  ): void;
  body(): BodyState;
}

/** Synthesized audio. Safe no-op until `resume()` on the first user gesture. */
export interface AudioApi {
  resume(): void;
  sfx(kind: SfxKind, opts?: SfxOpts): void;
  ambient(tod: TimeOfDay | false): void;
  stopAmbient(): void;
  /** Rolling log feeding telemetry().recentSfx. */
  recent(): readonly SfxKind[];
  dispose(): void;
}

export type SfxKind =
  | 'shot_knife'
  | 'shot_pistol'
  | 'shot_smg'
  | 'shot_shotgun'
  | 'shot_rifle'
  | 'shot_sniper'
  | 'reload'
  | 'hit_flesh'
  | 'headshot'
  | 'zombie_die'
  | 'zombie_groan'
  | 'zombie_scream'
  | 'brute_roar'
  | 'spit_launch'
  | 'spit_land'
  | 'fence_hit'
  | 'fence_break'
  | 'repair_tick'
  | 'repair_done'
  | 'downed'
  | 'revive_tick'
  | 'revive_done'
  | 'wave_start'
  | 'wave_clear'
  | 'buy'
  | 'deny'
  | 'footstep'
  | 'run_end'
  | 'click'
  /** Low-health pulse. UX_BIBLE requires health to be signalled by a second,
   *  non-colour channel; this is it. */
  | 'heartbeat';

export interface SfxOpts {
  dist?: number; // metres from the listener
  vol?: number; // 0..1 multiplier
  bearing?: number; // radians, relative to camera forward, for stereo pan
}

// ---------------------------------------------------------------------------
// Debug surface — the e2e and capture harnesses depend on EXACTLY this
// ---------------------------------------------------------------------------

export interface OutpostTelemetry {
  drawCalls: number;
  triangles: number;
  frameMs: number;
  pingMs: number;
  hp: number;
  status: SurvivorStatus;
  scrap: number;
  /** 0..1 progress of the hold-action in flight; lets e2e assert repair/revive. */
  interactProgress: number;
  phase: Phase;
  wave: number;
  zombiesAlive: number;
  /** zombies within HORDE.nearLodDist — the near-LOD population */
  zombiesNear: number;
  /**
   * Zombies within an ARBITRARY radius of the camera. The horde visual gate is
   * specified at 25 m, and the fixed near-LOD counter (20 m) could not express
   * it — so the gate's own precondition was unmeasurable.
   */
  zombiesWithin(radius: number): number;
  pos: [number, number, number];
  yaw: number;
  pitch: number;
  /**
   * PER-SEGMENT state, index === SegmentId. Counts alone were not enough: a
   * damaged-but-intact segment was invisible to the harness (so "a segment
   * takes damage and can be repaired" was unassertable), and `segBreached`
   * says how many breached but never WHICH — so the capture harness could not
   * aim at the breach it is required to photograph.
   */
  segments: readonly { hp: number; breached: boolean }[];
  segIntact: number;
  segBreached: number;
  tod: TimeOfDay;
  /**
   * MODAL overlays covering the 3D view — layers under `#menu` only. The
   * always-on HUD is NOT an overlay. MUST be 0 in any frame the capture
   * harness keeps: the previous build shipped 8 unjudgeable screenshots of
   * three stacked 78%-opaque modals over a black rectangle.
   */
  overlays: number;
  /** Whether the HUD is currently shown (the `hud-play` shot needs it on). */
  hudVisible: boolean;
  /**
   * Device-pixel rects of every HUD element, so the capture harness can define
   * "the 3D region" as canvas-minus-HUD. Both post-mortems masked the HUD
   * before computing their histograms; the first draft of the gates shipped no
   * mask, leaving a dark scene able to pass on bright HUD chrome alone.
   */
  hudRect: readonly { x: number; y: number; w: number; h: number }[];
  /** Rolling log of the last SfxKinds played — lets the run phase assert that a
   *  core action actually produced audible feedback. Feel cannot be screenshotted. */
  recentSfx: readonly SfxKind[];
}

export interface OutpostDebugState {
  ready: boolean;
  joined: boolean;
  roomId: string | null;
  code: string | null;
  phase: Phase;
  wave: number;
  seated: number;
  canStart: boolean;
}

export type DebugButton = 'fire' | 'jump' | 'crouch' | 'alt' | 'walk' | 'interact';

/**
 * FROZEN. Both harnesses assert this surface exists in full before running.
 * Every capability the previous build's harnesses had to fake or hard-code is
 * a first-class method here.
 */
export interface OutpostDebugApi {
  state(): OutpostDebugState;
  telemetry(): OutpostTelemetry;

  // lobby
  join(name?: string): void;
  createPrivate(name?: string): void;
  joinPrivate(name: string, code: string): void;
  /** `seed` makes the whole run reproducible — see C2S 'start'. */
  start(seed?: number): void;

  // ---------------------------------------------------------------------
  // SCENARIO STAGING.
  //
  // Without these, NOT ONE of the scenarios the contract demands of its own
  // harnesses can be staged. The two-client revive — the single verb that
  // justifies having no bot survivors — would have required walking a player
  // down two flights, out to a segment, and waiting >60s for an emergent,
  // server-random sequence of shambler swings to put them down. That
  // assertion would have been written flaky and then deleted.
  //
  // These are debug-only affordances on a debug-only surface. They exist so a
  // test asserts a real behaviour instead of hoping for one.
  // ---------------------------------------------------------------------
  /** Apply damage to the local survivor — drives downed/dead states on demand. */
  hurtSelf(dmg: number): void;
  /** Move the local survivor's BODY (not just the camera). */
  teleport(x: number, y: number, z: number): void;
  /** Force a segment to breach, so a breach can be photographed and pathed through. */
  breachSegment(seg: SegmentId): void;
  /** Spawn one zombie at a world position — the horde gate needs 6 within VISUAL_GATES.hordeGateRadius. */
  spawnAt(kind: ZombieKind, x: number, z: number): void;
  /** End the run immediately, so the run-end screen is reachable in one step. */
  endRun(): void;
  /**
   * Make the local survivor untouchable. The capture harness parks a player
   * for many seconds while it frames shots across two moods; the previous
   * harness's player was eaten by wave 1 before a single photograph was taken.
   */
  setInvulnerable(on: boolean): void;

  // control
  setLook(yaw: number, pitch: number): void;
  setMove(x: number, z: number): void;
  press(btn: DebugButton, down: boolean): void;
  fireOnce(): void;
  reload(): void;
  switchWeapon(w: WeaponId): void;
  buyWeapon(w: WeaponId): void;
  buyAmmo(): void;

  // capture-harness affordances — these exist so a screenshot is never a lie
  /**
   * The frozen map's feature points and segment geometry, read straight from
   * `@outpost/shared/map`. Harnesses frame every shot from THIS — never from a
   * coordinate literal, which is how the previous capture script ended up
   * aiming at bare ground after a layout change.
   */
  mapInfo(): import('./map.js').OutpostMapInfo;
  /** Place the camera anywhere for a framed shot (client-side view only). */
  freeCam(x: number, y: number, z: number, yaw: number, pitch: number): void;
  /** Release freeCam and return the view to the player. */
  releaseCam(): void;
  /** Force the mood so both lighting moods are capturable deterministically. */
  setTimeOfDay(tod: TimeOfDay): void;
  /** Dismiss every overlay/modal. telemetry().overlays must read 0 afterwards. */
  clearOverlays(): void;
}
