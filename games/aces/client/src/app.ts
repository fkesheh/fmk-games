// ============================================================================
// ACES — C_APP composition root (app.ts). The FINAL module: every sibling has
// landed green; this file wires them into one running game and owns nothing
// that a sibling could own (CONTRACT §2 import law: app composes, render
// never imports ui, ui never imports render internals).
//
// 3D EDITION (GRAPHICS_3D.md §5): the render pipeline is the render3d layer.
// OWNERS HERE: the GL canvas + hud canvas + vignette overlay stacking, the
// rAF loop with its 1/60 accumulator, THE plane-model pool (per SnapPlane.id),
// the camera feed into scene.rig (follow / orbitDeath / shake / zoom pin),
// input mapping from INPUT_KEYS to seq-stamped InputFrames sent at TICK_RATE,
// HudModel/OverlayModel assembly (cam.project backed by rig.project), the
// killfeed/banner caches, screen-state flow, the reconnect policy over
// NET.BACKOFF_MS, window.__ACES, and teardown.
//
// SCENE MOUNT LAW: AcesScene does not expose a scene getter, and none was
// added — W1's own world.ts header documents the sanctioned mount:
// `rig.getCam().parent` IS AcesSceneImpl's internal THREE.Scene (scene.ts
// adds the camera to it in its constructor). world.group is added there and
// effects3d.attach() receives that same scene; scene.render() therefore draws
// everything with zero sealed-file edits. The one-sanctioned-getter exception
// went UNUSED.
//
// FLOW (BUILD LAW): boot → showMenu(localStorage 'aces.name') → onPlay →
// audio.unlock + showConnecting → net.connect → onWelcome (buildMap + 3D world
// LAZILY here, predictor.setClass('fighter')) → snapshots drive lobby/live/
// end screens · auto first spawn 'fighter' when live · local RESPAWN_SECONDS
// countdown while dead → picker via screens' own digit keys → PhaseMsg end →
// showEnd → auto-restart resets round-local caches.
//
// LOOP (§5 order): rAF accumulates real dt into fixed 1/60 steps for sim-side
// logic; rendering happens once per frame in: interp.sampleRemotes → rig
// (follow while alive+spawned · orbitDeath from own death until respawn ·
// consumeShake → rig.shake · zoomTo pin) → pooled plane models (position X=x /
// Y=alt+bob per §8 / Z=y, yaw −h, bank/climb-pitch eased, damage/blink) → trails →
// snapshot tracers → world.update → effects3d.update → scene.render → HUD
// model (projections via rig.project). Every subsystem stays wrapped in
// guarded(): one throw logs ONCE and skips that subsystem from then on.
//
// ATTITUDE LAW (§1 + §8): group.rotation.order = 'YXZ' so yaw→pitch→bank
// compose in body frame: rotation.y = −h (yawOf), rotation.z = pitch —
// §8's climb pitch (climbPitch, 0.35 rad max, nose UP positive), superseding
// §1's throttle pitch — rotation.x = bank roll = −turnEcho·0.45rad eased —
// the §1 formula applied to the axis that rolls around the fuselage (the
// model's nose lies on local +X; see the header deviation note). SnapPlane
// carries no turn echo, so the turn echo is DERIVED: heading delta between
// frames (shortest arc) over dt, normalized by CLASSES.scout.turnRate (the
// fleet ceiling — config-derived, nothing invented), clamped to ±1. Bank
// sign follows §1 literally.
//
// SHAKE SPLIT (unchanged from the 2D ruling): C_FX emits impulses internally
// where it draws the cause (hitSpark → SMALL; explosion → MEDIUM/LARGE by
// size); C_APP adds exactly ONE impulse of its own — SHAKE.SMALL when YOU are
// hit — and picks explosion size by proximity (victim===me or blast within
// DIST_REF_U ⇒ 'large'). consumeShake() feeds rig.shake each frame; the rig's
// own SHAKE_GAIN rescales map-frame u into chase-frame jitter (documented by
// W1).
//
// DOCUMENTED CHOICES / DEVIATIONS (task report mirrors these):
//  · Film grain is OMITTED from the GL path (sanctioned v1 per task brief);
//    the unified-print feel keeps its vignette as a CSS radial-gradient
//    overlay div (.aces-vignette, ink-alpha mirror of APAL.ink per the
//    style.css palette-mirror precedent), pointer-events none, stacked
//    between the GL canvas and the HUD canvas.
//  · OverlayModel still carries no own-plane position, so the HUD anchors
//    gun-line/pip projections at CameraView.x/y — now the true chase-camera
//    position rather than the old pan center. Documented in ui/hud.ts.
//  · Respawn framing eases: the frozen AcesRig exposes no snap call, so
//    snapCamera() only recenters the bookkeeping values (event-distance math)
//    and the rig itself glides from the death orbit to the spawn strip.
//  · Dead REMOTE rows emit trail(id, null) explicitly so no smoke emitter
//    lingers over a wreck (the 2D loop merely skipped them).
//  · Remote gun VOLLEY sounds are skipped entirely — the contract requires
//    only explosions/hits; own guns are predicted locally (RULES 10).
//  · Crate landing puffs are derived client-side from the snapshot diff
//    fall→active via CrateLandTracker (the wire has no distinct event).
//  · After NET.BACKOFF_MS retries are exhausted the frozen Screens surface
//    has no menu-return control, so the app holds the manual-note screen;
//    re-enlisting means reload.
//  · Respawn countdown is local because SnapPlane `you` is omitted while
//    dead (server truth, room.ts sendSnapshots).
//  · Quality degrade is ONE-WAY: rolling frame average >20 ms after warmup
//    drops DPR→1 + shadows off via scene.setQuality('low'); it never
//    oscillates back within a session.
//
// §8 ALTITUDE NOTES (this task's amendments):
//  · Model pitch AXIS: §8's prose says "rotation.x = pitch under 'YXZ'", but
//    the models are authored with the NOSE on local +X, and rotation about
//    the local X axis leaves that nose vector INVARIANT (verified against
//    three.js under YXZ/YZX/XYZ — it is the roll axis). The §8 INTENT — yaw
//    −h, then pitch the nose UP with climb (0.35 rad max), bank unchanged —
//    is implemented as rotation.z = climbPitch (the lateral axis), bank
//    unchanged on rotation.x, group order switched 'YZX' → 'YXZ' per §8
//    (numerically identical nose behavior; same bank sign). No negation was
//    needed: rotation.z positive = nose UP.
//  · §1's cosmetic throttle-pitch (pitchAttitude) is superseded at the drive
//    site by §8's climb pitch; the helper stays exported (pinned pure gate).
//  · INTEGRATOR HANDOFFS (not this file's property): (a) prediction.ts (C_NET)
//    must init alt/climb in its constructor state AND copy them in
//    reconcile/copyMovement — until then own-plane altitude renders at the
//    predictor's init value; (b) net.ts (C_NET) parseSnapPlane/slot/copyInto
//    must carry alt/climb and sendInput must serialize `pit` — the wire's
//    parseC2S REQUIRES pit, so inputs are dropped until patched; (c) server
//    rowFor must already include alt/climb (§8 state rides the snapshot);
//    (d) screens.ts controls card may list CLIMB/DIVE (its pinned row count
//    is the C_UI owner's call). Remote rows are guarded here against a
//    non-finite alt/climb (cruise/level fallback) so a copyInto gap cannot
//    NaN the scene.
// ============================================================================

import type * as THREE from 'three';
import {
  ALT,
  CLASSES,
  FIRE_BELOW,
  INPUT_KEYS,
  NET,
  PLANE_Y,
  RESPAWN_SECONDS,
  SHAKE,
  SNAP_RATE,
  SMOKE_BELOW,
  STREAK_ACE,
  STREAK_LEGEND,
  TICK_RATE,
  TICKETS_TO_WIN,
  WORLD,
} from '@aces/shared/config.js';
import type { PlaneClassId, RoomSettings, TeamId } from '@aces/shared/config.js';
import { buildMap, isOpenWater } from '@aces/shared/maps.js';
import type { AcesMap } from '@aces/shared/maps.js';
import { angleDelta } from '@aces/shared/physics.js';
import type { CratePhase, GameEvent, InputFrame, MatchPhase, ScoreRow } from '@aces/shared/types.js';
import type { SnapPlane } from '@aces/shared/protocol.js';
import type {
  Banner,
  CameraView,
  HudModel,
  JoinKind,
  KillFeedEntry,
  NetHandlers,
  OverlayModel,
  SnapshotView,
} from './contract/seams.js';
import { fitCanvas, hashStr } from './contract/visual.js';
import { createNet, RemoteInterp } from './net.js';
import { OwnPredictor } from './prediction.js';
import { createEffects3D } from './render3d/effects3d.js';
import type { EffectsApi3D } from './render3d/effects3d.js';
import { buildPlane } from './render3d/planeModels.js';
import type { PlaneModel } from './render3d/planeModels.js';
import { createScene, easeFactor, yawOf } from './render3d/scene.js';
import type { AcesScene } from './render3d/scene.js';
import { createWorld } from './render3d/world.js';
import type { AcesWorld } from './render3d/world.js';
import { createHud } from './ui/hud.js';
import type { Hud } from './ui/hud.js';
import { createScreens } from './ui/screens.js';
import type { Screens } from './ui/screens.js';
import { DIST_REF_U, createAudio, loadMuted, saveMuted } from './audio/audio.js';

/** What startAces hands back to the boot shell (seams.ts creator note). */
export interface AcesDebug {
  /** Lobby envelopes through NetClient — quick public seat or private room. */
  join(kind?: { kind?: 'quick' } | { kind: 'private'; settings?: RoomSettings }): Promise<void>;
  spawn(cls: PlaneClassId): void;
  state(): {
    phase: MatchPhase;
    timeLeftS: number;
    tickets: { royal: number; iron: number };
    you: boolean;
    board: ScoreRow[];
  };
  god(): void;
  warpTo(x: number, y: number): void;
  giveCrate(x?: number, y?: number): void;
  fastForward(ticks: number): void;
  /**
   * Pin camera zoom for hero captures. GRAPHICS_3D §2 semantics: a
   * CAM-DISTANCE multiplier pin (0.5–6, null = speed-auto) routed to
   * rig.setZoomMult.
   */
  zoomTo(z: number | null): void;
  muted(): boolean;
  /** e2e probing handles — read-only refs, nothing mutates game truth. */
  _internals: {
    net: ReturnType<typeof createNet>;
    predictor: OwnPredictor;
    interp: RemoteInterp;
    latestSnap(): SnapshotView | undefined;
  };
}

declare global {
  interface Window {
    __ACES?: AcesDebug;
  }
}

export interface AcesApp {
  destroy(): void;
}

// ============================================================================
// Pure pipeline helpers — exported for the headless gate (app.render.test.ts)
// and shared by every drive site below. No DOM, no GL, deterministic.
// ============================================================================

/** Sim/render substep — CONTRACT §5 pins render-side logic at 60 Hz. */
const STEP_S = 1 / 60;
/** Spiral-of-death clamp: drop backlog past this instead of freezing. */
const MAX_FRAME_S = 0.25;
const MAX_STEPS_PER_FRAME = 5;

const TAU = Math.PI * 2;

/** §1 bob: planes cruise at PLANE_Y ±0.6u on sin(t·0.9 + phase). §8: the bob
 *  rides ON TOP of the plane's real altitude (Y = alt + planeBobOffset). */
const BOB_FREQ = 0.9;
const BOB_AMP = 0.6;

/** §1 attitude targets: roll = −turnInput·0.45rad. The §1 throttle-pitch
 *  (+0.06·throttle, boost −0.04) is SUPERSEDED at the drive site by §8's
 *  climb pitch (climbPitch below) — pitchAttitude stays exported for the
 *  pinned pure-helper gate. All five numbers are frozen-law citations. */
const BANK_RAD = 0.45;
const PITCH_PER_THROTTLE = 0.06;
const PITCH_BOOST = -0.04;

/** §8 pitch: rotation.z = clamp(climb / ALT.CLIMB_MAX, −1, 1) × 0.35 rad —
 *  nose UP positive for climb (verified against three.js: a +X-facing model
 *  pitches via the LATERAL axis; see the header deviation note). */
const PITCH_PER_CLIMB = 0.35;

/** §8 input feel: Q/E pit deflection eases at ~5/s (analog stick, no snap). */
const PIT_EASE_RATE = 5;

/** Bank/pitch approach rate, 1/s — mirrors scene.ts ROLL_RATE easing idiom. */
const ATTITUDE_EASE_RATE = 6;

/** Frames a pooled model may stay unseen before disposal (~10 s at 60 Hz):
 *  roster churn from reconnects must not leak airframes forever. */
const POOL_TTL_FRAMES = 600;

/** Rolling-average frame time above which quality degrades once (§5). */
const PERF_BUDGET_MS = 20;
const PERF_EMA_ALPHA = 0.05;
const PERF_WARMUP_FRAMES = 120;

/** Nose offset ahead of center, u — mirrors fireVolley's muzzle placement in
 *  shared/physics.ts (single source: the volley itself). */
const NOSE_U = 18;

/** Killfeed/banner TTLs in SNAPSHOT ticks. 4 s mirrors hud.ts's internal
 *  FEED_TTL_TICKS (SNAP_RATE*4) so entries expire as their slips fade out. */
const FEED_TTL_TICKS = SNAP_RATE * 4;
const FEED_MAX = 8;
const BANNER_TTL_TICKS = SNAP_RATE * 4;
const BANNER_MAX = 4;

/** Auto-spawn resend cadence while the server has not yet confirmed a seat. */
const AUTO_SPAWN_RETRY_MS = 1000;

/** localStorage keys. Name per task law; mute persistence lives in C_AUDIO. */
const NAME_KEY = 'aces.name';
const NAME_FALLBACK = 'PLAYER';

function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return ''; // privacy mode / storage disabled — menu just starts empty
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // best-effort persistence only
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Shortest-arc heading delta prevH → h into (−π, π]. Shared-physics
 * angleDelta already wraps; re-wrapped here so the helper stands alone.
 */
export function headingDeltaShortest(prevH: number, h: number): number {
  return angleDelta(prevH, h);
}

/**
 * Turn echo WITHOUT a wire echo: heading delta over dt normalized by the
 * fleet's tightest turner (CLASSES.scout.turnRate — config-derived ceiling),
 * clamped to ±1. dt ≤ 0 (first sighting / paused frame) echoes neutral 0.
 */
export function turnInputFromHeadingDelta(dh: number, dt: number): number {
  if (!(dt > 0)) return 0;
  const norm = dh / dt / CLASSES.scout.turnRate;
  return norm < -1 ? -1 : norm > 1 ? 1 : norm;
}

/** §1 bank roll target: rotation.x = −turnInput·0.45rad (YZX order). */
export function bankFromTurnInput(turnIn: number): number {
  const t = turnIn < -1 ? -1 : turnIn > 1 ? 1 : turnIn;
  return -BANK_RAD * t + 0; // `+ 0` normalises −0 → +0 (scene.ts yawOf idiom)
}

/** One-call form of the two helpers above (the per-frame path). */
export function bankFromHeadingDelta(prevH: number, h: number, dt: number): number {
  return bankFromTurnInput(turnInputFromHeadingDelta(headingDeltaShortest(prevH, h), dt));
}

/** §1 pitch target: +0.06rad·throttle, boost −0.04 (boost dive feel).
 *  Superseded at the drive site by §8's climbPitch — kept for the gate. */
export function pitchAttitude(throttle: number, boosting: boolean): number {
  return PITCH_PER_THROTTLE * throttle + (boosting ? PITCH_BOOST : 0);
}

/** §8 pitch target from vertical speed: clamp(climb / ALT.CLIMB_MAX, −1, 1)
 *  × 0.35 rad, nose UP positive. The clamp matters on dives — DIVE_MAX (34)
 *  exceeds CLIMB_MAX (30), so a full-deflection dive would overshoot ±1. */
export function climbPitch(climb: number): number {
  const n = climb / ALT.CLIMB_MAX;
  const c = n < -1 ? -1 : n > 1 ? 1 : n;
  return PITCH_PER_CLIMB * c;
}

/** §1 bob offset (the sin component alone) — rides on top of the plane's
 *  real altitude per §8. planeBobY keeps its cruise-altitude meaning. */
export function planeBobOffset(tS: number, phase: number): number {
  return Math.sin(tS * BOB_FREQ + phase) * BOB_AMP;
}

/** §1 cruise-altitude bob: PLANE_Y + sin(t·0.9 + phase)·0.6. */
export function planeBobY(tS: number, phase: number): number {
  return PLANE_Y + planeBobOffset(tS, phase);
}

/** Deterministic per-id bob phase in [0, 2π) — seeded hash, never random. */
export function bobPhaseFor(id: string): number {
  return ((hashStr(id) % 1000) / 1000) * TAU;
}

export type DeathCamMode = 'follow' | 'orbit';

/**
 * Death-cam state machine (§2): any frame without a living own row latches
 * ORBIT (rig.orbitDeath holds the last focus and slow-orbits the wreck);
 * a living row again — respawn — returns FOLLOW. Memoryless by design: the
 * caller's `flying` flag already encodes both edges (see updateCamera).
 */
export function deathCamNext(current: DeathCamMode, flying: boolean): DeathCamMode {
  void current; // latch is memoryless — kept in the signature for call-site clarity
  return flying ? 'follow' : 'orbit';
}

/**
 * Trail level from the frozen damage thresholds (config SMOKE_BELOW /
 * FIRE_BELOW): hp frac < FIRE_BELOW burns, else < SMOKE_BELOW smokes, else
 * clean. maxHp ≤ 0 (wire noise) is clean, never a divide-by-zero.
 */
export function trailLevel(hp: number, maxHp: number): 'smoke' | 'fire' | null {
  if (maxHp <= 0) return null;
  const frac = hp / maxHp;
  if (frac < FIRE_BELOW) return 'fire';
  if (frac < SMOKE_BELOW) return 'smoke';
  return null;
}

/** One pooled trail call — id/keying is the SERVER plane id, never an index. */
export interface TrailCall {
  id: string;
  x: number;
  y: number;
  level: 'smoke' | 'fire' | null;
}

/** Minimal trail-source pose (SnapPlane rows satisfy this structurally). */
interface TrailRow {
  id: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  dead: boolean;
}

/**
 * Plan the per-frame trail hook calls: every non-own row keyed by its SERVER
 * id (dead rows plan an explicit null so their emitter clears), then the own
 * row from the merged predictor view (`own === null` while spectating plans
 * nothing). Writes into pooled `out` records — zero steady-state allocation.
 * RETURNS the live call count WITHOUT truncating `out`: the surplus records
 * stay pooled in the array for future frames (the caller iterates i < count).
 */
export function planTrailCalls(
  rows: ReadonlyArray<TrailRow>,
  myId: string,
  own: TrailRow | null,
  out: TrailCall[],
): number {
  let n = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r === undefined || r.id === myId) continue;
    let rec = out[n];
    if (rec === undefined) {
      rec = { id: '', x: 0, y: 0, level: null };
      out.push(rec);
    }
    rec.id = r.id;
    rec.x = r.x;
    rec.y = r.y;
    rec.level = r.dead ? null : trailLevel(r.hp, r.maxHp);
    n++;
  }
  if (own !== null) {
    let rec = out[n];
    if (rec === undefined) {
      rec = { id: '', x: 0, y: 0, level: null };
      out.push(rec);
    }
    rec.id = own.id;
    rec.x = own.x;
    rec.y = own.y;
    rec.level = own.dead ? null : trailLevel(own.hp, own.maxHp);
    n++;
  }
  return n;
}

/**
 * Crate fall→active edge detector (the wire has no "landed" event): ids are
 * armed while falling and CONSUMED exactly once when seen active afterwards.
 */
export class CrateLandTracker {
  private readonly falling = new Set<number>();

  /** Arms `id` while falling; consumes the arm on active. True exactly once. */
  observe(id: number, phase: CratePhase): boolean {
    if (phase === 'fall') {
      this.falling.add(id);
      return false;
    }
    return this.falling.delete(id);
  }

  /** Round reset / fresh seat — armed-but-unlanded crates are forgotten. */
  clear(): void {
    this.falling.clear();
  }
}

// ============================================================================
// The composition root
// ============================================================================

export function startAces(container: HTMLElement): AcesApp {
  // ---- canvas stack (GRAPHICS_3D §5): webgl z1 · vignette z2 · hud z3 ------
  // Screens DOM (z20/z30, owned by C_UI) always sits above; all three layers
  // take pointer-events:none so menu buttons receive input.
  const glCanvas = document.createElement('canvas');
  glCanvas.className = 'aces-cv aces-cv-world';
  const vignetteEl = document.createElement('div');
  vignetteEl.className = 'aces-vignette';
  vignetteEl.setAttribute('aria-hidden', 'true');
  const hudCanvas = document.createElement('canvas');
  hudCanvas.className = 'aces-cv aces-cv-hud';
  container.appendChild(glCanvas);
  container.appendChild(vignetteEl);
  container.appendChild(hudCanvas);

  // ---- the 3D shell (created ONCE; world mounts lazily on welcome) ----------
  const scene: AcesScene = createScene(glCanvas);
  // Scene mount law (header): W1 adds its camera to the internal THREE.Scene,
  // making getCam().parent the documented mount point for world + effects.
  const camParent = scene.rig.getCam().parent;
  if (camParent === null) throw new Error('aces/app: rig camera has no scene parent to mount into');
  const threeScene = camParent as THREE.Scene;

  // ---- siblings -------------------------------------------------------------
  const audio = createAudio();
  let muted = loadMuted(); // persisted mute restored before any sound plays
  audio.setMuted(muted);

  const effects: EffectsApi3D = createEffects3D(hashStr('fx'));
  effects.attach(threeScene); // idempotent; builds puff buckets on first call

  const net = createNet();
  const predictor = new OwnPredictor('fighter'); // class re-set at welcome
  const interp = new RemoteInterp();

  const hud = createHud(hudCanvas); // after hudCanvas exists (its ctx capture)

  // ---- connection / match state ---------------------------------------------
  let destroyed = false;
  let welcomed = false;
  let myId = '';
  let playerName = '';
  let joinKind: JoinKind = { kind: 'quick' };
  let attempts = 0; // consumed BACKOFF_MS entries
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  let haveSnap = false;
  let lastSnap: SnapshotView | undefined;
  let snapTick = 0;
  let phase: MatchPhase = 'lobby';
  let timeLeftS = 0;
  const tickets = { royal: 0, iron: 0 };
  let winnerVar: TeamId | undefined;
  let boardCache: ScoreRow[] = [];
  let boardVer = 0;
  let shownLobbySec = -2;
  let shownBoardVer = -1;
  let matchUIShown = false;
  let endShown = false;
  let sdShown = false; // sudden-death banner/stamp fires ONCE per round

  // Own-plane bookkeeping. seenYouRow gates everything HUD-side ("null while
  // spectating pre-first-spawn"); respawnT is LOCAL because the wire omits
  // `you` while dead.
  let seenYouRow = false;
  let everSpawned = false;
  let deadRemainS = 0;
  let maxHpCache = CLASSES.fighter.hp;
  let lastSpawnTryMs = -Infinity;

  // Round caches rebuilt on welcome / round restart.
  const feed: KillFeedEntry[] = [];
  let feedSeq = 0;
  const banners: Banner[] = [];
  let hitConfirmTick = 0;
  let hurtTick = 0;
  const crateTracker = new CrateLandTracker();

  // ---- 3D world (LAZY: buildMap(seed) needs the welcome's seed) --------------
  let map: AcesMap | undefined;
  let world: AcesWorld | undefined;
  let builtSeed = -1;

  // ---- plane-model pool (Map keyed by SnapPlane.id) --------------------------
  interface PoolEntry {
    model: PlaneModel;
    cls: PlaneClassId;
    team: TeamId;
    phase: number;
    lastH: number;
    hasH: boolean;
    bank: number;
    pitch: number;
    seenFrame: number;
  }
  const planePool = new Map<string, PoolEntry>();
  let frameIdx = 0;

  function entryFor(id: string, cls: PlaneClassId, team: TeamId): PoolEntry {
    const cur = planePool.get(id);
    if (cur !== undefined && cur.cls === cls && cur.team === team) return cur;
    if (cur !== undefined) {
      threeScene.remove(cur.model.group);
      cur.model.dispose(); // detaches; geometry kits are process-wide caches
    }
    const model = buildPlane(cls, team);
    model.group.rotation.order = 'YXZ'; // §8: yaw→pitch→bank compose in body frame (header)
    threeScene.add(model.group);
    const entry: PoolEntry = {
      model,
      cls,
      team,
      phase: bobPhaseFor(id),
      lastH: 0,
      hasH: false,
      bank: 0,
      pitch: 0,
      seenFrame: frameIdx,
    };
    planePool.set(id, entry);
    return entry;
  }

  function clearPlanes(): void {
    for (const entry of planePool.values()) {
      threeScene.remove(entry.model.group);
      entry.model.dispose();
    }
    planePool.clear();
  }

  /**
   * Drive one pooled airframe from a server/predictor pose (§1 attitude law
   * + §8 altitude law + §4 seam division: the APP owns transforms, the MODEL
   * owns prop/surfaces/damage/blink). Position Y = alt + bob (§8); pitch =
   * climbPitch(climb) eased; bank unchanged. Zero allocation — scalars and
   * cached transforms only.
   */
  function drivePlane(
    entry: PoolEntry,
    x: number,
    y: number,
    alt: number,
    climb: number,
    h: number,
    hp: number,
    maxHp: number,
    invulnT: number,
    dt: number,
    tS: number,
  ): void {
    const dh = entry.hasH ? headingDeltaShortest(entry.lastH, h) : 0;
    entry.lastH = h;
    entry.hasH = true;
    entry.seenFrame = frameIdx;
    const turnIn = turnInputFromHeadingDelta(dh, dt);
    const k = easeFactor(dt, ATTITUDE_EASE_RATE);
    entry.bank += (bankFromTurnInput(turnIn) - entry.bank) * k;
    entry.pitch += (climbPitch(climb) - entry.pitch) * k;

    const g = entry.model.group;
    g.position.set(x, alt + planeBobOffset(tS, entry.phase), y); // §8: Y = alt + bob
    g.rotation.y = yawOf(h);
    g.rotation.x = entry.bank;
    g.rotation.z = entry.pitch; // §8 pitch rides the lateral axis (header)

    // Elevator tracks the climb axis (§8 pitch application), rudder/aileron
    // wash keeps the derived turn echo.
    entry.model.setControls(turnIn, climb / ALT.CLIMB_MAX);
    entry.model.setDamage(maxHp > 0 ? clamp01(1 - hp / maxHp) : 0);
    entry.model.setBlink(invulnT > 0);
    entry.model.setVisible(true);
    entry.model.update(dt, tS);
  }

  function updatePlanes(dt: number, tS: number): void {
    // Remotes (interp rows already exclude nobody — filter self/dead here).
    // Row alt/climb guards: a C_NET parse/copy gap must not NaN the scene —
    // fall back to cruise altitude / level flight (cited §8 defaults).
    for (let i = 0; i < remoteOut.length; i++) {
      const row = remoteOut[i];
      if (row === undefined || row.id === myId || row.dead) continue;
      const alt = Number.isFinite(row.alt) ? row.alt : PLANE_Y;
      const climb = Number.isFinite(row.climb) ? row.climb : 0;
      const entry = entryFor(row.id, row.cls, row.team);
      drivePlane(entry, row.x, row.y, alt, climb, row.h, row.hp, row.maxHp, row.invulnT, dt, tS);
    }
    // OWN plane drawn the same way from the merged predictor view (predicted
    // alt/climb — smooth by construction).
    if (seenYouRow && !predictor.state.dead && myId !== '') {
      fillScratchOwn();
      const s = scratchOwn;
      const entry = entryFor(myId, s.cls, s.team);
      drivePlane(entry, s.x, s.y, s.alt, s.climb, s.h, s.hp, s.maxHp, s.invulnT, dt, tS);
    }
    // Hide stale entries; reap long-gone ids (reconnect churn).
    planePool.forEach((entry, id) => {
      if (entry.seenFrame !== frameIdx && entry.model.group.visible) entry.model.setVisible(false);
      if (frameIdx - entry.seenFrame > POOL_TTL_FRAMES) {
        threeScene.remove(entry.model.group);
        entry.model.dispose();
        planePool.delete(id);
      }
    });
  }

  // ---- camera feed ------------------------------------------------------------
  let deathCam: DeathCamMode = 'follow';
  /** Judge/capture distance-multiplier pin (§2 hero shots); null = default. */
  let zoomOverride: number | null = null;
  /** Reused velocity record for the rig — zero per-frame allocation. */
  const velFeed: { x: number; y: number } = { x: 0, y: 0 };

  function updateCamera(dt: number, tS: number): void {
    const st = predictor.state;
    const flying = seenYouRow && !st.dead && myId !== '';
    deathCam = deathCamNext(deathCam, flying);

    // ALL accumulated impulses (C_FX internal + the one app-side hurt kick)
    // flow into the rig, whose SHAKE_GAIN rescales them for the chase frame.
    const m = effects.consumeShake();
    if (m > 0) scene.rig.shake(m);
    scene.rig.setZoomMult(zoomOverride ?? 1);

    if (flying) {
      // st is the pos view (x/y); VELOCITY rides vx/vy — the rig's lookahead
      // law needs true speed, not position. Identity §1 mapping (vx→VX, vy→VZ).
      // §8: the chase rides the plane's REAL altitude and the look point
      // leans into the predicted climb.
      velFeed.x = st.vx;
      velFeed.y = st.vy;
      const entry = planePool.get(myId);
      scene.rig.follow(st, velFeed, st.h, entry ? entry.bank : 0, entry ? entry.pitch : 0, dt, st.alt, st.climb);
    } else if (deathCam === 'orbit' && everSpawned) {
      // Orbit only AFTER a first life: §2 scopes the wreck orbit to own
      // death, so pre-first-spawn spectating keeps the rig's initial
      // map-center hold (the old 2D idle framing).
      scene.rig.orbitDeath(tS);
    }
  }

  function snapCamera(): void {
    // Bookkeeping-only since the frozen AcesRig exposes no snap: recenters
    // the values event-distance math reads between frames. The rig itself
    // eases from wherever it is (deviation documented in the header).
    camView.x = predictor.state.x;
    camView.y = predictor.state.y;
    camView.zoom = 1;
  }

  // ---- input ------------------------------------------------------------------
  // Held-code set → sampled InputSource. Digit1/2/3, Tab, M, Escape are NEVER
  // touched here: screens owns them (picker hotkeys / scoreboard swallow /
  // mute hook / controls card) — double-handling would double-fire spawns.
  const held = new Set<string>();
  const PREVENT_CODES = new Set<string>([
    ...INPUT_KEYS.scoreboard,
    ...INPUT_KEYS.fire,
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
  ]);

  function anyHeld(codes: readonly string[]): boolean {
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c !== undefined && held.has(c)) return true;
    }
    return false;
  }

  function clearHeld(): void {
    held.clear();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (destroyed) return;
    if (e.repeat) return;
    // Typing the callsign must not feed the flight controls.
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    if (welcomed && phase === 'live' && PREVENT_CODES.has(e.code)) e.preventDefault();
    held.add(e.code);
  }

  function onKeyUp(e: KeyboardEvent): void {
    held.delete(e.code);
  }

  function onBlur(): void {
    clearHeld(); // RULES 6: blur clears inputs
  }

  function onVisibility(): void {
    if (document.hidden) clearHeld();
  }

  // ---- scratch (RULES 4: zero per-frame allocation in steady state) ----------
  const remoteOut: SnapPlane[] = []; // filled by sampleRemotes (pooled rows)
  const scratchOwn: SnapPlane = {
    id: '', name: '', team: 'royal', cls: 'fighter', bot: false,
    x: 0, y: 0, h: 0, sp: 0, vx: 0, vy: 0,
    alt: 0, climb: 0,
    hp: 0, maxHp: 1, heat: 0, jammed: false,
    boost: 0, boosting: false, throttle: 0,
    invulnT: 0, dead: false, streak: 0, seq: 0,
  };
  type TargetRow = { x: number; y: number; alt: number; team: TeamId; cls: PlaneClassId; hpFrac: number };
  const targetsPool: TargetRow[] = [];
  const trailOut: TrailCall[] = [];
  const ownTrailScratch: TrailRow = { id: '', x: 0, y: 0, hp: 0, maxHp: 1, dead: false };

  const hmYou: NonNullable<HudModel['you']> = {
    cls: 'fighter', team: 'royal', hp: 0, maxHp: 1, alt: 0, heat: 0, jammed: false,
    boost: 0, throttle: 0, alive: false, respawnT: 0, streak: 0,
  };
  const hm: HudModel = {
    tick: 0, phase: 'lobby', timeLeftS: 0, suddenDeath: false,
    tickets: { royal: 0, iron: 0 },
    you: null, board: [], feed: [], banners: [], muted,
  };

  /**
   * The frozen §2 CameraView seam, backed live by the rig: x/y track the true
   * chase-camera position (written post-render), zoom mirrors the distance
   * multiplier pin, project() delegates to rig.project (SHARED SCRATCH —
   * consumers copy fields immediately, never stash the record).
   */
  const camView: CameraView = {
    x: WORLD.W / 2,
    y: WORLD.H / 2,
    zoom: 1,
    project(wx, wy, wz) {
      return scene.rig.project(wx, wy, wz);
    },
  };

  const om: OverlayModel = {
    alive: false, heading: 0, speedFrac: 0, heat: 0, jammed: false,
    targets: targetsPool, cam: camView, hitConfirmTick: 0, hurtTick: 0,
  };

  // ---- per-subsystem exception guard (RULES 5) --------------------------------
  const failed = new Set<string>();
  function guarded(key: string, fn: () => void): void {
    if (failed.has(key)) return;
    try {
      fn();
    } catch (err) {
      failed.add(key);
      console.error(`[aces] ${key} disabled after throw:`, err);
    }
  }

  // ---- net handlers --------------------------------------------------------------
  function applySnapshot(snap: SnapshotView): void {
      if (destroyed || !welcomed) return;
      lastSnap = snap;
      haveSnap = true;
      snapTick = snap.tick;
      tickets.royal = snap.tickets.royal;
      tickets.iron = snap.tickets.iron;
      applyPhase(snap.phase);
      timeLeftS = snap.timeLeftS;
      interp.push(snap);
      checkSuddenDeath();

      // Crate parity: pooled 3D models sync straight off the snapshot, and
      // the fall→active edge fires the landing puff exactly once per crate.
      effects.syncCrates(snap.crates);
      for (let i = 0; i < snap.crates.length; i++) {
        const c = snap.crates[i];
        if (c === undefined) continue;
        if (crateTracker.observe(c.id, c.phase)) {
          effects.crateFx('land', { x: c.x, y: c.y });
        }
      }

      // Own-row edges. reconcile() copies server-authoritative fields
      // verbatim (hp/heat/jammed/dead/name/team/cls/streak…) and integrates
      // movement snap-or-blend+replay — the merge the BUILD LAW asks for is
      // exactly this predictor contract.
      const hadRow = seenYouRow;
      const wasDead = predictor.state.dead;
      predictor.reconcile(snap.you);
      if (snap.you !== undefined) {
        maxHpCache = snap.you.maxHp > 0 ? snap.you.maxHp : CLASSES[snap.you.cls].hp;
        if (!hadRow) {
          seenYouRow = true;
          everSpawned = true;
          snapCamera(); // first-ever row: recenter bookkeeping at the spawn strip
        } else if (wasDead && !predictor.state.dead) {
          everSpawned = true;
          snapCamera(); // rebirth
        }
      }
      if (hadRow && !wasDead && predictor.state.dead) {
        deadRemainS = RESPAWN_SECONDS; // death edge — local timer (see header)
      }

      // Auto first spawn: live + never spawned → ask for a fighter. Sent at
      // ≤1 Hz until the server confirms a you-row (lost-msg self-healing).
      if (!everSpawned && snap.phase === 'live') {
        const nowMs = performance.now();
        if (nowMs - lastSpawnTryMs >= AUTO_SPAWN_RETRY_MS) {
          lastSpawnTryMs = nowMs;
          net.sendSpawn('fighter');
        }
      }
  }

  const handlers: NetHandlers = {
    onWelcome(w) {
      if (destroyed) return;
      attempts = 0; // healthy session resets the backoff ladder
      myId = w.id;
      welcomed = true;
      boardCache = w.roster;
      boardVer++;

      // LAZY world build: identical seed → identical terrain (maps.ts law).
      // A reconnect to a same-seed room reuses the baked 3D world.
      if (builtSeed !== w.seed || world === undefined) {
        builtSeed = w.seed;
        map = buildMap(w.seed);
        if (world !== undefined) {
          threeScene.remove(world.group);
          world.dispose();
        }
        world = createWorld(map);
        threeScene.add(world.group);
      }

      predictor.setClass('fighter');

      // Fresh seat (reconnect mints one — CONTRACT §5): wipe round-local
      // state so stale feed/banners/airframes can't leak across sessions.
      clearPlanes();
      crateTracker.clear();
      deathCam = 'follow';
      seenYouRow = false;
      everSpawned = false;
      deadRemainS = 0;
      lastSpawnTryMs = -Infinity;
      feed.length = 0;
      banners.length = 0;
      sdShown = false;
      endShown = false;
      matchUIShown = false;
      shownLobbySec = -2;
      hitConfirmTick = 0;
      hurtTick = 0;
      snapCamera();
    },

    onSnapshot(fn) {
      if (destroyed) return;
      // FROZEN-SEAM REGISTRATION (seams.ts): the hook hands us the producer's
      // registrar; we hand back our consumer IMMEDIATELY — a synchronous
      // round-trip, so even the very first parsed view is delivered. The one
      // narrow assertion below exists because the seam types the parameter as
      // the consumer itself while its real contract is registrar-shaped (see
      // header + report); the runtime callee simply captures what it receives,
      // so the disguise is exact. Reconnects re-register because net resets
      // its pump slot per connect().
      (fn as unknown as (consumer: (snap: SnapshotView) => void) => void)(applySnapshot);
    },

    onEvent(e) {
      if (destroyed || !welcomed) return;
      handleEvent(e);
    },

    onPhase(p, endsAtS, winner) {
      if (destroyed || !welcomed) return;
      applyPhase(p);
      timeLeftS = endsAtS; // same match-relative clock as snapshot timeLeftS
      if (winner !== undefined) winnerVar = winner;
    },

    onScore(board) {
      if (destroyed) return;
      boardCache = board;
      boardVer++;
    },

    onClose() {
      if (destroyed) return;
      scheduleReconnect();
    },
  };

  // ---- flow: join / reconnect ---------------------------------------------------
  function beginJoin(name: string, join: JoinKind): Promise<void> {
    playerName = name;
    joinKind = join;
    saveName(name);
    attempts = 0;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    // AudioContext creation is gesture-gated; PLAY clicks are gestures.
    void audio.unlock().catch(() => undefined);
    // Register the pilot name even for __ACES/debug joins that skip the menu
    // path — screens captures prefName for roster/board "(YOU)" highlighting.
    // Same-task swap into connecting, so only the connecting layer paints.
    screens.showMenu(playerName);
    screens.showConnecting();
    return attemptConnect();
  }

  function attemptConnect(): Promise<void> {
    return net.connect(playerName, joinKind, handlers).then(
      () => undefined, // socket open — the room welcome drives everything next
      () => {
        scheduleReconnect(); // never opened: backoff path, same as a drop
      },
    );
  }

  function scheduleReconnect(): void {
    if (destroyed) return;
    welcomed = false;
    haveSnap = false;
    const delay = attempts < NET.BACKOFF_MS.length ? NET.BACKOFF_MS[attempts] : undefined;
    attempts++;
    if (delay === undefined) {
      // Backoff exhausted: manual-note screen (deviation documented in header
      // — the frozen Screens layer offers no menu-return control).
      screens.showDisconnected(false);
      return;
    }
    screens.showDisconnected(true);
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void attemptConnect();
    }, delay);
  }

  // ---- phase / screens ------------------------------------------------------------
  function applyPhase(next: MatchPhase): void {
    if (next === phase) return;
    const prev = phase;
    phase = next;
    matchUIShown = false;
    if (next === 'end') {
      endShown = false;
    } else if (next === 'live' && prev === 'end') {
      // Auto-restart into a fresh live round: reset round-local caches.
      feed.length = 0;
      banners.length = 0;
      sdShown = false;
      deadRemainS = 0;
      crateTracker.clear();
      endShown = false;
    }
  }

  function checkSuddenDeath(): void {
    if (sdShown || phase !== 'live') return;
    const tie = tickets.royal === tickets.iron;
    const bothCapped = tickets.royal >= TICKETS_TO_WIN && tickets.iron >= TICKETS_TO_WIN;
    // Server rule: higher tickets wins at time expiry; tie → sudden death,
    // next credited kill ends it. Also covers a simultaneous 25-25 tick.
    if (tie && (timeLeftS <= 0 || bothCapped)) {
      sdShown = true;
      banners.push({ kind: 'suddendeath', text: 'SUDDEN DEATH', bornTick: snapTick });
      trimBanners();
    }
  }

  function updateScreens(): void {
    if (!welcomed) return;
    switch (phase) {
      case 'lobby': {
        const sec = Math.max(0, Math.ceil(timeLeftS));
        if (sec !== shownLobbySec || boardVer !== shownBoardVer) {
          shownLobbySec = sec;
          shownBoardVer = boardVer;
          screens.showLobby(sec, boardCache); // diffs internally
        }
        break;
      }
      case 'live': {
        if (seenYouRow && predictor.state.dead) {
          matchUIShown = false;
          screens.showDeath(Math.max(0, deadRemainS), predictor.state.cls);
        } else if (!matchUIShown) {
          matchUIShown = true;
          screens.showMatchUI();
        }
        break;
      }
      case 'end': {
        if (!endShown) {
          endShown = true;
          const wnr =
            winnerVar ??
            (tickets.royal > tickets.iron
              ? 'royal'
              : tickets.iron > tickets.royal
                ? 'iron'
                : undefined);
          screens.showEnd(boardCache, wnr);
          if (seenYouRow) audio.ui(predictor.state.team === wnr ? 'win' : 'lose');
        }
        break;
      }
    }
  }

  // ---- events → models/fx/audio ------------------------------------------------------
  function trimFeed(): void {
    for (let i = feed.length - 1; i >= 0; i--) {
      const f = feed[i];
      if (f !== undefined && snapTick - f.bornTick >= FEED_TTL_TICKS) feed.splice(i, 1);
    }
    while (feed.length > FEED_MAX) feed.shift();
  }

  function trimBanners(): void {
    for (let i = banners.length - 1; i >= 0; i--) {
      const b = banners[i];
      if (b !== undefined && snapTick - b.bornTick >= BANNER_TTL_TICKS) banners.splice(i, 1);
    }
    while (banners.length > BANNER_MAX) banners.shift();
  }

  function handleEvent(e: GameEvent): void {
    switch (e.kind) {
      case 'kill': {
        // Crash variant renders from VICTIM fields per types.ts wire-shape law
        // (killer fields carry the victim's identity when crash=true).
        feed.push({
          id: ++feedSeq,
          killerName: e.killerName,
          victimName: e.victimName,
          killerTeam: e.killerTeam,
          crash: e.crash,
          killerCls: e.killerCls,
          bornTick: snapTick,
        });
        trimFeed();

        const mp = map;
        const overWater = mp !== undefined ? isOpenWater(mp, e.x, e.y) : false;
        const dist = Math.hypot(e.x - camView.x, e.y - camView.y);
        // Size law (header "SHAKE SPLIT"): near blast / own death = large,
        // distant = small — C_FX maps these onto MEDIUM/LARGE impulses.
        const size = e.victim === myId || dist <= DIST_REF_U ? ('large' as const) : ('small' as const);
        effects.explosion({ x: e.x, y: e.y }, size, overWater);
        audio.explosion(dist);

        if (myId !== '' && e.killer === myId) {
          audio.killConfirm();
          audio.streak(e.streak); // two-note stinger at ACE/LEGEND thresholds
          if (e.streak >= STREAK_LEGEND) banners.push({ kind: 'legend', text: 'LEGEND', bornTick: snapTick });
          else if (e.streak >= STREAK_ACE) banners.push({ kind: 'ace', text: 'ACE', bornTick: snapTick });
          trimBanners();
        }
        break;
      }
      case 'hit': {
        if (myId !== '' && e.by === myId) {
          hitConfirmTick = snapTick;
          // Spark backsplash cone points away from MY gunline (C_FX 3D owns
          // the cone orientation internally — its API takes just the point).
          effects.hitSpark({ x: e.x, y: e.y });
          audio.hitConfirm();
        } else if (e.target === myId) {
          hurtTick = snapTick;
          audio.hurt();
          effects.shake(SHAKE.SMALL); // the ONE app-side impulse (see header)
        }
        // Remote volleys produce no sounds by documented choice.
        break;
      }
      case 'crate': {
        if (myId !== '' && e.what === 'pickup' && e.by === myId) {
          effects.crateFx('pickup', { x: e.x, y: e.y });
          audio.pickup();
        }
        break;
      }
    }
  }

  // ---- fixed-step logic (60 Hz) ---------------------------------------------------
  let sendAccS = 0;
  let prevFireHeld = false;
  let prevJammed = false;
  let seqCounter = 1;
  const SEND_EVERY_S = 1 / TICK_RATE;
  /** §8 pit deflection, eased toward the Q/E-held target at PIT_EASE_RATE —
   *  an analog stick read, not a snap (own + wire frames share ONE value). */
  let pitEased = 0;

  function stepFixed(dt: number): void {
    const th = anyHeld(INPUT_KEYS.throttleUp) ? 1 : anyHeld(INPUT_KEYS.throttleDown) ? -0.3 : 0;
    const tr = (anyHeld(INPUT_KEYS.turnRight) ? 1 : 0) - (anyHeld(INPUT_KEYS.turnLeft) ? 1 : 0);
    const pitTarget = anyHeld(INPUT_KEYS.climb) ? 1 : anyHeld(INPUT_KEYS.dive) ? -1 : 0;
    pitEased += (pitTarget - pitEased) * easeFactor(dt, PIT_EASE_RATE);
    const fire = anyHeld(INPUT_KEYS.fire);
    const boost = anyHeld(INPUT_KEYS.boost);

    sendAccS += dt;
    const due = sendAccS >= SEND_EVERY_S;
    if (due) sendAccS -= SEND_EVERY_S;

    if (!welcomed) {
      prevFireHeld = fire; // keep edges honest across connect boundaries
      return;
    }

    const st = predictor.state;
    if (!st.dead) predictor.advance(dt); // death freeze is the predictor's law

    if (deadRemainS > 0) deadRemainS = Math.max(0, deadRemainS - dt);

    // Jam edge → clunk+rattle (D2: the cost of holding trigger).
    if (!prevJammed && st.jammed && !st.dead) audio.overheatJam();
    prevJammed = st.jammed;

    // Trigger rising edge → SAME-FRAME cosmetics (RULES 10, ≤100 ms budget):
    // flash + tracer stub + shot, gated like the server's fireVolley
    // (dead/jammed/spawn-protected guns stay silent). Event-edge object
    // literals are allocation-exempt (RULES 4 wire/event shape).
    if (fire && !prevFireHeld && !st.dead && !st.jammed && st.invulnT <= 0) {
      const nx = st.x + Math.cos(st.h) * NOSE_U;
      const ny = st.y + Math.sin(st.h) * NOSE_U;
      const nose: { x: number; y: number } = { x: nx, y: ny };
      effects.muzzleFlash(nose, st.h);
      effects.tracerStub(nose, st.h);
      audio.shot(true, 0);
    }
    prevFireHeld = fire;

    if (due) {
      // Wire-crossing object — allocation-exempt (RULES 4). Shared BY
      // REFERENCE with the predictor's pending queue (InputFrame readonly).
      // §8: pit rides every frame; the wire's parseC2S rejects frames
      // without it.
      const frame: InputFrame = { seq: seqCounter++, th, tr, pit: pitEased, fire, boost };
      net.sendInput(frame);
      predictor.onLocalInput(frame);
    }
  }

  // ---- trails (server-id keyed; pooled plan, zero steady-state alloc) -----
  function emitTrails(): void {
    const st = predictor.state;
    let n: number;
    if (seenYouRow && myId !== '') {
      ownTrailScratch.id = myId;
      ownTrailScratch.x = st.x;
      ownTrailScratch.y = st.y;
      ownTrailScratch.hp = st.hp;
      ownTrailScratch.maxHp = maxHpCache;
      ownTrailScratch.dead = st.dead;
      n = planTrailCalls(remoteOut, myId, ownTrailScratch, trailOut);
    } else {
      n = planTrailCalls(remoteOut, myId, null, trailOut);
    }
    for (let i = 0; i < n; i++) {
      const tc = trailOut[i]!;
      effects.trail(tc.id, tc, tc.level);
    }
  }

  // ---- models -------------------------------------------------------------------------
  function fillScratchOwn(): void {
    const st = predictor.state;
    // Movement + all combat fields come from the predictor's state — its
    // reconcile already merges server-authoritative mirrors over prediction.
    scratchOwn.id = st.id;
    scratchOwn.name = st.name;
    scratchOwn.team = st.team;
    scratchOwn.cls = st.cls;
    scratchOwn.bot = false;
    scratchOwn.x = st.x;
    scratchOwn.y = st.y;
    scratchOwn.h = st.h;
    scratchOwn.sp = Math.hypot(st.vx, st.vy);
    scratchOwn.vx = st.vx;
    scratchOwn.vy = st.vy;
    scratchOwn.alt = st.alt;
    scratchOwn.climb = st.climb;
    scratchOwn.hp = st.hp;
    scratchOwn.maxHp = maxHpCache;
    scratchOwn.heat = st.heat;
    scratchOwn.jammed = st.jammed;
    scratchOwn.boost = st.boost;
    scratchOwn.boosting = st.boosting;
    scratchOwn.throttle = st.throttle;
    scratchOwn.invulnT = st.invulnT;
    scratchOwn.dead = st.dead;
    scratchOwn.streak = st.streak;
    scratchOwn.seq = 0;
  }

  function assembleModels(): void {
    hm.tick = snapTick;
    hm.phase = phase;
    hm.timeLeftS = timeLeftS;
    hm.suddenDeath = sdShown && phase === 'live';
    hm.tickets.royal = tickets.royal;
    hm.tickets.iron = tickets.iron;
    hm.board = boardCache;
    hm.feed = feed;
    hm.banners = banners;
    hm.muted = muted;

    const st = predictor.state;
    if (!seenYouRow) {
      hm.you = null; // spectating pre-first-spawn
    } else {
      hmYou.cls = st.cls;
      hmYou.team = st.team;
      hmYou.hp = st.hp;
      hmYou.maxHp = maxHpCache;
      hmYou.alt = st.alt;
      hmYou.heat = st.heat;
      hmYou.jammed = st.jammed;
      hmYou.boost = st.boost;
      hmYou.throttle = st.throttle;
      hmYou.alive = !st.dead;
      hmYou.respawnT = deadRemainS;
      hmYou.streak = st.streak;
      hm.you = hmYou;
    }

    om.alive = seenYouRow && !st.dead;
    om.heading = st.h;
    om.speedFrac = speedFracCache;
    om.heat = st.heat;
    om.jammed = st.jammed;
    om.hitConfirmTick = hitConfirmTick;
    om.hurtTick = hurtTick;

    // Enemies in snapshot order; pooled rows keep the loop alloc-free.
    let ti = 0;
    for (let i = 0; i < remoteOut.length; i++) {
      const row = remoteOut[i];
      if (row === undefined || row.dead || row.id === myId) continue;
      if (seenYouRow && row.team === st.team) continue;
      let slot = targetsPool[ti];
      if (slot === undefined) {
        slot = { x: 0, y: 0, alt: 0, team: row.team, cls: row.cls, hpFrac: 0 };
        targetsPool.push(slot);
      }
      slot.x = row.x;
      slot.y = row.y;
      // §8: HUD projections ride each target's REAL altitude (cruise fallback
      // while a C_NET parse/copy gap leaves the field non-finite).
      slot.alt = Number.isFinite(row.alt) ? row.alt : PLANE_Y;
      slot.team = row.team;
      slot.cls = row.cls;
      slot.hpFrac = row.maxHp > 0 ? clamp01(row.hp / row.maxHp) : 0;
      ti++;
    }
    targetsPool.length = ti;
  }

  // ---- render pass (§5 loop order) ------------------------------------------------------
  let lastMs = -1;
  let accS = 0;
  let vpW = -1;
  let vpH = -1;
  let speedFracCache = 0;
  let perfEmaMs = 16;
  let qualityLow = false;

  function render(nowMs: number, dtS: number): void {
    frameIdx++;

    // Viewport handoff: CSS box × capped DPR is owned jointly by fitCanvas
    // (backing store) and setViewport (renderer sizing + aspect).
    const fitted = fitCanvas(glCanvas);
    if (fitted.w !== vpW || fitted.h !== vpH) {
      vpW = fitted.w;
      vpH = fitted.h;
      scene.setViewport(vpW, vpH);
    }

    const tS = nowMs / 1000;

    // Interpolated remotes FIRST — planes, trails and targets all read them.
    interp.sampleRemotes(nowMs, remoteOut);
    const st = predictor.state;
    speedFracCache = clamp01(Math.hypot(st.vx, st.vy) / CLASSES[st.cls].speedMax);
    const ownVisible = seenYouRow && !st.dead;

    guarded('camera', () => updateCamera(dtS, tS));
    guarded('planes', () => updatePlanes(dtS, tS));
    guarded('fx.trails', emitTrails);

    // Snapshot tracers BEFORE render (stateless instanced rebuild, §4).
    const snap = lastSnap;
    if (haveSnap && snap !== undefined) {
      guarded('fx.bullets', () => effects.drawProjectiles(snap.bullets));
    }

    guarded('world.anim', () => world?.update(tS, camView));
    guarded('fx.update', () => effects.update(dtS, camView));
    guarded('scene.render', () => scene.render(dtS, tS));

    // Post-render: the HUD's CameraView now reflects the TRUE chase-camera
    // pose (server coords: X↔x, Z↔y) and the current zoom-pin multiplier.
    const cpos = scene.rig.getCam().position;
    camView.x = cpos.x;
    camView.y = cpos.z;
    camView.zoom = zoomOverride ?? 1;

    // --- screen space: HUD model (projections ride rig.project) ---
    assembleModels();
    if (welcomed) guarded('hud', () => hud.update(hm, om));

    // Engine + wind follow the merged own view; idle-fade while dead/off-line.
    guarded('audio.frame', () => {
      if (ownVisible) {
        audio.ownEngine(predictor.state.throttle, speedFracCache, predictor.state.boosting);
        audio.wind(speedFracCache);
      } else {
        audio.ownEngine(0, 0, false);
        audio.wind(0);
      }
    });
  }

  // ---- rAF loop --------------------------------------------------------------------------
  let raf = 0;

  function frame(nowMs: number): void {
    if (destroyed) return;
    raf = window.requestAnimationFrame(frame);

    let dtS = lastMs < 0 ? 0 : (nowMs - lastMs) / 1000;
    lastMs = nowMs;
    if (!(dtS > 0)) dtS = 0;
    const rawMs = dtS * 1000;
    if (dtS > MAX_FRAME_S) dtS = MAX_FRAME_S;

    accS += dtS;
    let steps = 0;
    while (accS >= STEP_S && steps < MAX_STEPS_PER_FRAME) {
      stepFixed(STEP_S);
      accS -= STEP_S;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) accS = 0; // dump pathological backlog

    try {
      render(nowMs, dtS);
      updateScreens();
    } catch (err) {
      // Belt-and-braces around the composition itself; subsystems are already
      // individually guarded — this catches camera/model math regressions.
      guarded('frame', () => {
        throw err;
      });
    }

    // §5 graceful degrade: sustained slow frames drop DPR→1 + shadows off,
    // exactly once (no oscillation within a session).
    if (!qualityLow && welcomed && frameIdx > PERF_WARMUP_FRAMES) {
      perfEmaMs += (rawMs - perfEmaMs) * PERF_EMA_ALPHA;
      if (perfEmaMs > PERF_BUDGET_MS) {
        qualityLow = true;
        guarded('perf', () => scene.setQuality('low'));
      }
    }
  }

  // ---- hooks + debug surface ------------------------------------------------------------
  function toggleMute(): void {
    muted = !muted;
    saveMuted(muted);
    audio.setMuted(muted);
  }

  const screens = createScreens({
    onPlay(name, join) {
      void beginJoin(name, join);
    },
    onSpawn(cls) {
      // Local airframe swap keeps prediction honest until the next snapshot
      // re-authors resources; the server remains sole authority.
      predictor.setClass(cls);
      net.sendSpawn(cls);
      audio.ui('spawn');
    },
    onMuteToggle() {
      toggleMute();
    },
    onHelp() {
      // Informational card — screens owns visibility; nothing to mirror.
    },
  });

  window.__ACES = {
    join(kind) {
      let jk: JoinKind = { kind: 'quick' };
      if (kind !== undefined && kind.kind === 'private') {
        jk = { kind: 'private', settings: kind.settings ?? {} };
      }
      return beginJoin(loadName() || NAME_FALLBACK, jk);
    },
    spawn(cls) {
      predictor.setClass(cls);
      net.sendSpawn(cls);
    },
    state() {
      return {
        phase,
        timeLeftS,
        tickets: { royal: tickets.royal, iron: tickets.iron },
        you: seenYouRow && !predictor.state.dead,
        board: boardCache,
      };
    },
    god() {
      net.sendDebug('god');
    },
    warpTo(x, y) {
      net.sendDebug('warp', x, y);
    },
    giveCrate(x, y) {
      net.sendDebug('crate', x, y);
    },
    fastForward(ticks) {
      net.sendDebug('tick', ticks);
    },
    /**
     * Judge/capture hook (STYLE_BIBLE §4 + GRAPHICS_3D §2): pin the chase
     * distance multiplier (0.5–6; null restores the default 1). Routed to
     * rig.setZoomMult every frame; the rig re-clamps authoritatively.
     */
    zoomTo(z: number | null) {
      zoomOverride = z === null ? null : Math.max(0.5, Math.min(6, z));
    },
    muted() {
      toggleMute();
      return muted;
    },
    _internals: {
      net,
      predictor,
      interp,
      latestSnap: () => lastSnap,
    },
  };

  // ---- wiring + boot ----------------------------------------------------------------------
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);
  raf = window.requestAnimationFrame(frame);

  screens.showMenu(loadName());

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      if (retryTimer !== null) clearTimeout(retryTimer);
      net.close(); // closedByUser path — suppresses onClose reconnect UX
      hud.destroy();
      screens.hideAll(); // frozen Screens exposes no destroy — hide is best-effort
      delete window.__ACES;
      // 3D teardown: pooled airframes, world subtree, FX pools, GL shell.
      clearPlanes();
      if (world !== undefined) {
        threeScene.remove(world.group);
        world.dispose();
        world = undefined;
      }
      effects.dispose();
      scene.dispose();
      vignetteEl.remove();
      glCanvas.remove();
      hudCanvas.remove();
      // audio/Screens own no teardown in the frozen seams; dropping refs lets
      // the GC reclaim them once their internal timers drain.
    },
  };
}
