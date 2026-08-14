// ============================================================================
// cl-game — OutpostGame: the client integrator. Per CONTRACT.md this is the
// ONLY file allowed broad concrete imports. It builds the ClientCtx handle,
// owns the frame order (input -> predict -> send -> interpolate -> sync
// renderers -> animate -> HUD -> render), routes every OutpostEvent to FX +
// SFX + HUD, drives setSegment() for all 16 fence segments every frame, and
// switches SceneRig.setTimeOfDay off the snapshot mood.
//
// WORLD LIFETIME (a deliberate deviation from STRICKEN's per-room rebuild):
// RIDGELINE is OUTPOST's one and only map, so the renderer/world/models are
// built ONCE in the constructor and live for the page's lifetime — mirrors
// main.ts's own expectation (`new SceneRig(canvas)` is constructed here and
// its throw is meant to propagate to main.ts's `new OutpostGame(...)`
// try/catch; main.ts's rAF loop calls `frame()` unconditionally, with no
// world-exists gate). "disposes the entire world on leave" (this module's
// brief) is therefore read as: leave() clears the DYNAMIC per-run actors
// (zombie/survivor models, particles) back to empty, not that it tears down
// and rebuilds the WebGL context every join — that would mean re-baking
// ~2,700 static meshes on every reconnect for zero benefit on a single-map
// game. A genuine full teardown (renderer included) is reserved for this
// class's own `dispose()`.
//
// GESTURE SEAM: main.ts dispatches ONE `window` Event named 'outpost:gesture'
// on the first real pointerdown/keydown (see main.ts's own comment); this
// class listens for it and resumes the AudioEngine (browsers gate
// AudioContext creation on a user gesture).
//
// PAUSE: driven by pointer-lock transitions, not a held/stopped
// InputController. InputController's own `onPointerLockChange` already clears
// held keys the instant lock is lost, and main.ts's `onResume` callback
// re-requests pointer lock directly on the canvas (it does not call back into
// this class) — so pause here is just "show the pause menu when lock is lost
// while in a room, hide it when lock is regained." The input tick loop keeps
// running (and keeps SENDING inputs) throughout: NETCODE.inputTimeoutMs would
// disconnect a silent client, and a paused menu must not desync you from a
// game your teammates are still fighting.
//
// DEBUG-SURFACE SEAM: CONTRACT.md's frozen game.ts snippet names only five
// debug-backing methods (debugState/telemetry/freeCam/releaseCam/
// setTimeOfDay) because the rest of OutpostDebugApi needs Net/the
// predictor/InputController, which only this file may broadly import. main.ts
// (already written) forwards every other verb — quickJoin/createPrivate/
// joinPrivate/start/hurtSelf/teleport/breachSegment/spawnAt/endRun/
// setInvulnerable/setLook/setMove/press/fireOnce/reload/switchWeapon/
// buyWeapon/buyAmmo — to a same-named method here (mapInfo()/clearOverlays()
// need no forwarding: main.ts answers those itself). This file therefore
// exposes that additive public surface; CONTRACT.md permits filling privates
// and bodies, and adding new public methods beyond the five it names is the
// same C10/C11-seam pattern STRICKEN's clientGame.ts already uses.
//
// CONTRACT GAP (see net.ts's own header note, confirmed on read): Net's
// frozen constructor exposes only onEvent/onJoined — there is no onError/
// onClose channel to report a join-time rejection (room full, bad code) or a
// socket drop back to this integrator. Mitigated with a client-side join
// timeout (JOIN_TIMEOUT_MS): if 'joined' has not fired within that window,
// fall back to the main menu with a readable message instead of hanging on
// "Joining…" forever.
// ============================================================================
import * as THREE from 'three';
import {
  BASE_FOV,
  PLAYER,
  WEAPON_ORDER,
  eyePos,
  makeBody,
} from '@fps/shared';
import type { BodyState, MoveInput, WeaponId } from '@fps/shared';
import {
  ECONOMY,
  HORDE,
  INPUT_ALT,
  INPUT_CROUCH,
  INPUT_FIRE,
  INPUT_INTERACT,
  INPUT_JUMP,
  INPUT_MASK,
  INPUT_WALK,
  SEGMENTS,
  SURVIVOR,
  TICK_DT,
  WEAPONS,
} from '@outpost/shared';
import type {
  ClientCtx,
  DebugButton,
  DebugMsg,
  HudState,
  InteractKind,
  JoinedMsg,
  OutpostDebugState,
  OutpostEvent,
  OutpostTelemetry,
  Phase,
  PlayerId,
  RosterEntry,
  RunStats,
  SegmentId,
  SfxKind,
  SfxOpts,
  SnapshotMsg,
  TimeOfDay,
  Vec3W,
  YouSnap,
  ZombieId,
  ZombieKind,
} from '@outpost/shared';
import { cleanName, loadName, rng } from '@platform/shared';
import type { RoomInfo } from '@platform/shared';

import { Net } from './net.js';
import { InputController } from './input.js';
import { Hud } from './ui/hud.js';
import { Menus } from './ui/menus.js';
import { AudioEngine } from './audio/audio.js';
import { SceneRig } from './render/scene.js';
import { buildWorld, animateWorld } from './render/world.js';
import { buildOutpost } from './render/outpost.js';
import type { OutpostBuild } from './render/outpost.js';
import { ZombieModels } from './render/zombies.js';
import { SurvivorModels, ViewModel } from './render/survivors.js';
import { Effects } from './render/effects.js';

// ---- tuning (local; nothing here is a balance number, only feel/plumbing) --
const MAX_INPUTS_PER_FRAME = 4; // mirrors NETCODE.maxInputPerTick — drop backlog after a hitch
const JOIN_TIMEOUT_MS = 8000; // see header: net.ts has no onError/onClose channel
const LOW_HP_THRESHOLD = 30; // UX_BIBLE: low-hp is signalled by 'heartbeat' too, not colour alone
const HEARTBEAT_INTERVAL = 1.1;
const REPAIR_TICK_INTERVAL = 0.35; // throttled ambience while holding a repair
const REVIVE_TICK_INTERVAL = 0.4; // throttled ambience while reviving someone
const FIRE_SHAKE_ADD = 0.05;
const CROSSHAIR_PX_PER_DEG = 6; // cosmetic px/deg scale, HUD-only, not gameplay-affecting
const TICKER_MAX = 6;
const MOVE_MIN_SPEED = 0.5; // m/s — matches SurvivorSnap.mv's own threshold doc
const STEP_EVERY_M = PLAYER.speedRun * 0.38; // one footstep per ~1.82m at run speed
const STEP_CLAMP_M = 0.5; // a reconcile snap must never read as a footstep burst
const PITCH_MIN = -1.45;
const PITCH_MAX = 1.45;
const TWO_PI = Math.PI * 2;
const ONBOARD_KEY = 'outpost.onboarded';

type TickerKind = 'kill' | 'wave' | 'breach' | 'down' | 'revive';

const SHOT_SFX: Record<WeaponId, SfxKind> = {
  knife: 'shot_knife',
  pistol: 'shot_pistol',
  smg: 'shot_smg',
  shotgun: 'shot_shotgun',
  rifle: 'shot_rifle',
  sniper: 'shot_sniper',
};

/** The weapon rack sells everything with a non-zero price (knife/pistol are issued free). */
const RACK_WEAPONS: readonly WeaponId[] = WEAPON_ORDER.filter((w) => ECONOMY.weaponPrice[w] > 0);

function wrapPi(a: number): number {
  return ((((a + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** The persistent, single-map render/actor bundle. Built once; never rebuilt. */
interface World {
  readonly rig: SceneRig;
  readonly worldRoot: THREE.Group;
  readonly outpost: OutpostBuild;
  readonly zombies: ZombieModels;
  readonly survivors: SurvivorModels;
  readonly viewmodel: ViewModel;
  readonly effects: Effects;
}

export class OutpostGame {
  private readonly canvas: HTMLCanvasElement;
  private readonly hud: Hud;
  private readonly menus: Menus;
  private readonly input: InputController;
  private readonly audio: AudioEngine;
  private readonly net: Net;
  private readonly world: World;

  // fallback scene/camera so ctx() never needs to return null before a room exists
  private readonly fallbackScene = new THREE.Scene();
  private readonly fallbackCamera = new THREE.PerspectiveCamera();
  private readonly camPosVec = new THREE.Vector3();

  private disposed = false;

  // ---- room/session state ----
  private youId: PlayerId | null = null;
  private roomId: string | null = null;
  private code: string | null = null;
  private readonly roster = new Map<PlayerId, RosterEntry>();
  private lastRunStats: RunStats[] | null = null;
  private prevPhase: Phase = 'lobby';
  private joining = false;
  private joinToken = 0;
  private joinTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- input / prediction ----
  private seq = 0;
  private inputAccSec = 0;
  private lastButtons = 0;
  private lastWeapon: WeaponId | null = null;
  private prevHeldWeapon: WeaponId | null = null;
  private bloomDeg = 0;
  private scoped = false;
  private dbgMove: { x: number; z: number } | null = null;
  private dbgButtons = 0;
  private dbgFireOnce = false;

  // ---- camera / mood ----
  private freeCamState: { x: number; y: number; z: number; yaw: number; pitch: number } | null = null;
  private todOverride: TimeOfDay | null = null;
  private lastAppliedTod: TimeOfDay | null = null;
  private clockSec = 0;
  private lastFrameMs = 0;

  // ---- pause (pointer-lock driven — see header) ----
  private wasLocked = false;

  // ---- UI/HUD-adjacent local state ----
  private prevInteract: InteractKind = 'none';
  private scoreboardOpen = false;
  private readonly ticker: { text: string; kind: TickerKind }[] = [];
  private repairHintFired = false;
  private reviveHintFired = false;
  private lullHintFired = false;
  private ammoTickAcc = 0;
  /** INTERACT held this frame — drives the ammo-crate purchase tick. */
  private interactHeld = false;
  private repairTickAcc = 0;
  private reviveTickAcc = 0;
  private heartbeatAcc = 0;
  private footAcc = 0;
  private lastFootX = 0;
  private lastFootZ = 0;
  private readonly beaconPos = new Map<PlayerId, Vec3W>();

  constructor(opts: { canvas: HTMLCanvasElement; hud: Hud; menus: Menus }) {
    this.canvas = opts.canvas;
    this.hud = opts.hud;
    this.menus = opts.menus;
    this.input = new InputController(opts.canvas);
    this.audio = new AudioEngine();
    this.net = new Net(this.onEvent, this.onJoined);

    // SceneRig's constructor throws on a missing/lost WebGL context and
    // paints its own readable overlay before doing so (see scene.ts); the
    // throw is expected to propagate to main.ts's `new OutpostGame(...)`
    // try/catch (RULE: "guard for missing WebGL and degrade").
    const rig = new SceneRig(this.canvas);
    const worldRoot = buildWorld();
    const outpost = buildOutpost();
    rig.scene.add(worldRoot);
    rig.scene.add(outpost.root);
    rig.scene.add(rig.camera); // the viewmodel is camera-parented
    this.world = {
      rig,
      worldRoot,
      outpost,
      zombies: new ZombieModels(rig.scene),
      survivors: new SurvivorModels(rig.scene),
      viewmodel: new ViewModel(rig.camera),
      effects: new Effects(rig.scene),
    };

    window.addEventListener('outpost:gesture', this.onGesture, { once: true });
  }

  // ==========================================================================
  // Frozen public surface (CONTRACT.md)
  // ==========================================================================

  frame(dtIn: number): void {
    if (this.disposed) return;
    const dt = clamp(dtIn, 0, 0.1);
    this.clockSec += dt;
    this.lastFrameMs = dt * 1000;
    this.frameInner(dt);
  }

  ctx(): ClientCtx {
    const self = this;
    return {
      get scene(): THREE.Scene {
        return self.world.rig.scene;
      },
      get camera(): THREE.PerspectiveCamera {
        return self.world.rig.camera;
      },
      now: () => self.clockSec,
      serverNow: () => self.net.serverNow(),
      snap: () => self.net.snap(),
      youId: () => self.youId,
      survivors: () => self.net.survivors(),
      zombies: () => self.net.zombies(),
      rand: (seed: number) => rng(seed)(),
      tod: () => self.todOverride ?? self.net.snap()?.tod ?? 'dusk',
      sfx: (kind: SfxKind, opts?: SfxOpts) => self.audio.sfx(kind, opts),
      shake: (amount: number) => self.world.rig.shake(amount),
    };
  }

  resize(): void {
    this.world.rig.resize();
  }

  leave(): void {
    if (this.disposed) return;
    this.clearJoinTimeout();
    this.net.leave();
    this.input.stop();
    this.audio.stopAmbient();
    this.clearDynamicActors();
    this.resetRoomState();
    this.hud.show(false);
    this.hud.runEnd(null);
    this.menus.showMain();
  }

  dispose(): void {
    if (this.disposed) return;
    this.leave();
    this.disposed = true;
    this.net.dispose();
    this.world.zombies.dispose();
    this.world.survivors.dispose();
    this.world.viewmodel.dispose();
    this.world.effects.dispose();
    this.world.rig.dispose();
    this.audio.dispose();
    window.removeEventListener('outpost:gesture', this.onGesture);
  }

  debugState(): OutpostDebugState {
    const snap = this.net.snap();
    return {
      ready: !this.disposed,
      joined: this.youId !== null,
      roomId: this.roomId,
      code: this.code,
      phase: snap?.phase ?? this.prevPhase,
      wave: snap?.wave ?? 0,
      seated: snap?.seated ?? this.roster.size,
      canStart: snap?.canStart ?? false,
    };
  }

  telemetry(): OutpostTelemetry {
    const snap = this.net.snap();
    const body = this.net.predictor().body();
    const eye = this.freeCamState !== null ? this.freeCamState : eyePos(body);
    const zs = this.net.zombies();
    const segs = snap?.segments ?? [];
    let segIntact = 0;
    let segBreached = 0;
    let zombiesAlive = 0;
    let zombiesNear = 0;
    for (const s of segs) {
      if (s.br) segBreached++;
      else segIntact++;
    }
    for (const z of zs) {
      if (z.st !== 'dying') zombiesAlive++;
      if (Math.hypot(z.x - eye.x, z.z - eye.z) <= HORDE.nearLodDist) zombiesNear++;
    }
    const you = snap?.you ?? null;
    return {
      drawCalls: this.world.rig.renderer.info.render.calls,
      triangles: this.world.rig.renderer.info.render.triangles,
      frameMs: this.lastFrameMs,
      pingMs: this.net.pingMs(),
      hp: you?.hp ?? 0,
      status: you?.status ?? 'alive',
      scrap: you?.scrap ?? 0,
      interactProgress: you?.interactProgress ?? 0,
      phase: snap?.phase ?? this.prevPhase,
      wave: snap?.wave ?? 0,
      zombiesAlive,
      zombiesNear,
      zombiesWithin: (radius: number): number => {
        let n = 0;
        for (const z of zs) if (Math.hypot(z.x - eye.x, z.z - eye.z) <= radius) n++;
        return n;
      },
      pos: [body.x, body.y, body.z],
      yaw: this.freeCamState?.yaw ?? this.input.yaw,
      pitch: this.freeCamState?.pitch ?? this.input.pitch,
      segments: segs.map((s) => ({ hp: s.hp, breached: s.br })),
      segIntact,
      segBreached,
      tod: this.todOverride ?? snap?.tod ?? 'dusk',
      overlays: this.menus.overlayCount(),
      hudVisible: this.hud.visible(),
      hudRect: this.hud.rects(),
      recentSfx: this.audio.recent(),
    };
  }

  freeCam(x: number, y: number, z: number, yaw: number, pitch: number): void {
    this.freeCamState = { x, y, z, yaw, pitch };
  }

  releaseCam(): void {
    this.freeCamState = null;
  }

  setTimeOfDay(tod: TimeOfDay): void {
    this.todOverride = tod;
  }

  // ==========================================================================
  // Additive public surface — see header's "DEBUG-SURFACE SEAM". Every one of
  // these is called by main.ts's own MenuCallbacks wiring and/or
  // window.__outpost, both already written; names/signatures below match
  // exactly what main.ts calls.
  // ==========================================================================

  quickJoin(name: string): void {
    if (this.disposed) return;
    this.startJoinAttempt();
    this.net.connect();
    this.net.quickJoin(cleanName(name || loadName()));
  }

  createPublic(name: string): void {
    if (this.disposed) return;
    this.startJoinAttempt();
    this.net.connect();
    this.net.createPublic(cleanName(name || loadName()));
  }

  createPrivate(name: string): void {
    if (this.disposed) return;
    this.startJoinAttempt();
    this.net.connect();
    this.net.createPrivate(cleanName(name || loadName()));
  }

  joinPrivate(name: string, code: string): void {
    if (this.disposed) return;
    this.startJoinAttempt();
    this.net.connect();
    this.net.joinPrivate(cleanName(name || loadName()), code);
  }

  listRooms(): Promise<RoomInfo[]> {
    if (this.disposed) return Promise.resolve([]);
    this.net.connect();
    return this.net.listRooms();
  }

  start(seed?: number): void {
    if (seed === undefined) this.net.send({ t: 'start' });
    else this.net.send({ t: 'start', seed });
  }

  buyWeapon(w: WeaponId): void {
    this.net.send({ t: 'buy_weapon', weapon: w });
  }

  buyAmmo(): void {
    this.net.send({ t: 'buy_ammo' });
  }

  hurtSelf(dmg: number): void {
    this.sendDebug('hurt', dmg);
  }

  teleport(x: number, y: number, z: number): void {
    this.sendDebug('teleport', x, y, z);
  }

  breachSegment(seg: SegmentId): void {
    this.sendDebug('breach', seg);
  }

  spawnAt(kind: ZombieKind, x: number, z: number): void {
    this.sendDebug('spawn', x, z, undefined, kind);
  }

  endRun(): void {
    this.sendDebug('end');
  }

  setInvulnerable(on: boolean): void {
    this.sendDebug('invuln', on ? 1 : 0);
  }

  setLook(yaw: number, pitch: number): void {
    this.input.yaw = wrapPi(yaw);
    this.input.pitch = clamp(pitch, PITCH_MIN, PITCH_MAX);
  }

  setMove(x: number, z: number): void {
    this.dbgMove = x === 0 && z === 0 ? null : { x: clamp(x, -1, 1), z: clamp(z, -1, 1) };
  }

  press(btn: DebugButton, down: boolean): void {
    const bit =
      btn === 'fire'
        ? INPUT_FIRE
        : btn === 'jump'
          ? INPUT_JUMP
          : btn === 'crouch'
            ? INPUT_CROUCH
            : btn === 'alt'
              ? INPUT_ALT
              : btn === 'walk'
                ? INPUT_WALK
                : INPUT_INTERACT;
    this.dbgButtons = down ? this.dbgButtons | bit : this.dbgButtons & ~bit;
  }

  fireOnce(): void {
    this.dbgFireOnce = true;
  }

  reload(): void {
    this.net.send({ t: 'reload' });
    const you = this.net.snap()?.you;
    if (you !== undefined) {
      this.world.viewmodel.reload(WEAPONS[you.weapon].reload);
      this.audio.sfx('reload');
    }
  }

  switchWeapon(w: WeaponId): void {
    this.net.send({ t: 'switch', weapon: w });
  }

  // ==========================================================================
  // Join-attempt bookkeeping (mitigates net.ts's documented onError/onClose gap)
  // ==========================================================================

  private startJoinAttempt(): void {
    this.joining = true;
    const token = ++this.joinToken;
    this.clearJoinTimeout();
    this.menus.showJoining();
    this.joinTimeoutTimer = setTimeout(() => {
      if (this.joinToken !== token || !this.joining) return;
      this.joining = false;
      this.menus.showMain('Could not join — the room may be full or gone');
    }, JOIN_TIMEOUT_MS);
  }

  private clearJoinTimeout(): void {
    if (this.joinTimeoutTimer !== null) {
      clearTimeout(this.joinTimeoutTimer);
      this.joinTimeoutTimer = null;
    }
  }

  private sendDebug(op: DebugMsg['op'], a?: number, b?: number, c?: number, kind?: ZombieKind): void {
    const msg: DebugMsg = { t: 'debug', op };
    if (a !== undefined) msg.a = a;
    if (b !== undefined) msg.b = b;
    if (c !== undefined) msg.c = c;
    if (kind !== undefined) msg.kind = kind;
    this.net.send(msg);
  }

  // ==========================================================================
  // Net callbacks
  // ==========================================================================

  private readonly onGesture = (): void => {
    this.audio.resume();
  };

  private readonly onJoined = (msg: JoinedMsg): void => {
    try {
      this.joining = false;
      this.clearJoinTimeout();
      this.youId = msg.you;
      this.roomId = msg.roomId;
      this.code = msg.code;
      this.roster.clear();
      for (const r of msg.roster) this.roster.set(r.id, r);
      this.lastRunStats = null;
      this.prevPhase = msg.phase;
      this.prevInteract = 'none';
      this.ticker.length = 0;
      this.seq = 0;
      this.inputAccSec = 0;
      this.lastButtons = 0;
      this.bloomDeg = 0;
      this.lastWeapon = null;
      this.prevHeldWeapon = null;
      this.repairHintFired = false;
      this.reviveHintFired = false;
      this.lullHintFired = false;
      this.todOverride = null;
      this.lastAppliedTod = null;
      this.wasLocked = false;
      this.footAcc = 0;
      const b = this.net.predictor().body();
      this.lastFootX = b.x;
      this.lastFootZ = b.z;
      this.clearDynamicActors();

      // The HUD stays DOWN while the lobby panel is up. Showing both put a live
      // "WAVE 1 / 11 REMAINING" readout behind a modal reading "nobody has
      // started the run", and buried the HUD's own START button underneath the
      // panel's body text — a visible, unclickable second START. One start
      // affordance at a time; the HUD comes up when the run does.
      this.hud.show(msg.phase !== 'lobby');
      this.menus.hideAll();
      this.input.start();
      this.maybeShowOnboarding();
      if (msg.phase === 'lobby') this.menus.showLobby(Array.from(this.roster.values()), false);
      else this.menus.showInRoom(msg.code);
    } catch {
      // never let a malformed/unexpected join payload wedge the client
    }
  };

  private readonly onEvent = (ev: OutpostEvent): void => {
    try {
      this.handleEvent(ev);
    } catch {
      // one bad event must not break the ones after it
    }
  };

  // ==========================================================================
  // Per-frame pipeline
  // ==========================================================================

  private frameInner(dt: number): void {
    const w = this.world;
    const snap = this.net.snap();
    const you = snap?.you ?? null;

    this.handleEdges();
    if (snap !== null) this.handlePhase(snap);
    if (you !== null) this.handleInteract(you, dt);

    // ---- input: sample, predict, send at SIM_HZ ----
    this.inputAccSec += dt;
    let sent = 0;
    while (this.inputAccSec >= TICK_DT && sent < MAX_INPUTS_PER_FRAME) {
      this.inputAccSec -= TICK_DT;
      sent++;
      this.tickInput(you);
    }
    if (sent === MAX_INPUTS_PER_FRAME) this.inputAccSec = 0;

    // cosmetic bloom recovery (server owns real spread)
    if (this.bloomDeg > 0 && you !== null) {
      this.bloomDeg = Math.max(0, this.bloomDeg - WEAPONS[you.weapon].spreadRecover * dt);
    }

    // weapon switch feedback (server changes it silently on death/buy/etc.)
    if (you !== null && you.weapon !== this.lastWeapon) {
      if (this.lastWeapon !== null) this.prevHeldWeapon = this.lastWeapon;
      this.lastWeapon = you.weapon;
      w.viewmodel.setWeapon(you.weapon);
    }

    // low-hp heartbeat — UX_BIBLE's non-colour channel for low health
    if (you !== null && you.status === 'alive' && you.hp > 0 && you.hp < LOW_HP_THRESHOLD) {
      this.heartbeatAcc += dt;
      if (this.heartbeatAcc >= HEARTBEAT_INTERVAL) {
        this.heartbeatAcc = 0;
        this.audio.sfx('heartbeat');
      }
    } else {
      this.heartbeatAcc = 0;
    }

    // ---- camera ----
    const body = this.net.predictor().body();
    const scoped = you !== null && (this.lastButtons & INPUT_ALT) !== 0 && WEAPONS[you.weapon].zoomFov !== null;
    if (scoped !== this.scoped) {
      this.scoped = scoped;
      this.input.setZoomed(scoped);
    }
    let camX: number;
    let camY: number;
    let camZ: number;
    let camYaw: number;
    let camPitch: number;
    if (this.freeCamState !== null) {
      camX = this.freeCamState.x;
      camY = this.freeCamState.y;
      camZ = this.freeCamState.z;
      camYaw = this.freeCamState.yaw;
      camPitch = this.freeCamState.pitch;
    } else {
      const eye = eyePos(body);
      camX = eye.x;
      camY = eye.y;
      camZ = eye.z;
      camYaw = this.input.yaw;
      camPitch = this.input.pitch;
    }
    const fovDeg = scoped && you !== null ? (WEAPONS[you.weapon].zoomFov ?? BASE_FOV) : BASE_FOV;
    w.rig.applyCamera(camX, camY, camZ, camYaw, camPitch, fovDeg);
    this.camPosVec.set(camX, camY, camZ);

    // ---- pause (pointer-lock driven — see header) ----
    if (this.youId !== null) {
      const locked = this.input.locked();
      // ANY loss of pointer lock raises pause, unconditionally. Pause is the
      // only route back to a locked cursor (its RESUME re-requests the lock), so
      // suppressing it strands the player: Esc frees the mouse, the game keeps
      // running, and nothing on screen can give control back. `showPause` is
      // exclusive, so it correctly replaces an open rack rather than stacking.
      if (this.wasLocked && !locked) this.menus.showPause();
      else if (!this.wasLocked && locked) this.menus.hideAll();
      this.wasLocked = locked;
    }

    // ---- mood ----
    const tod = this.todOverride ?? snap?.tod ?? 'dusk';
    if (tod !== this.lastAppliedTod) {
      this.lastAppliedTod = tod;
      w.rig.setTimeOfDay(tod);
      this.audio.ambient(tod);
    }

    // ---- local footsteps ----
    if (you !== null) this.updateFootsteps(body, you);

    // ---- sync renderers off the snapshot ----
    w.zombies.sync(this.net.zombies(), this.camPosVec, dt);
    w.survivors.sync(this.net.survivors(), this.youId, dt);
    if (snap !== null) {
      const segs = snap.segments;
      if (Array.isArray(segs)) {
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i];
          if (s !== undefined) w.outpost.setSegment(i, s.hp, s.br, s.rb);
        }
      }
      if (Array.isArray(snap.spits)) for (const sp of snap.spits) w.effects.spitTrail({ x: sp.x, y: sp.y, z: sp.z });
      this.syncReviveBeacons(snap);
    }
    const moving = Math.hypot(body.vx, body.vz) > MOVE_MIN_SPEED;
    w.viewmodel.update(dt, moving, scoped, you?.interactProgress ?? 0);

    // ---- animate ----
    animateWorld(w.worldRoot, this.clockSec);
    w.outpost.animate(this.clockSec);
    w.effects.update(dt);

    // ---- HUD ----
    if (snap !== null && you !== null) this.hud.update(this.buildHudState(snap, you));

    // ---- render ----
    w.rig.render();
  }

  private tickInput(snapYou: YouSnap | null): void {
    const f = this.input.frame();
    const moveX = this.dbgMove?.x ?? f.moveX;
    const moveZ = this.dbgMove?.z ?? f.moveZ;
    let buttons = (f.buttons | this.dbgButtons) & INPUT_MASK;
    this.interactHeld = (buttons & INPUT_INTERACT) !== 0;
    if (this.dbgFireOnce) {
      buttons |= INPUT_FIRE;
      this.dbgFireOnce = false;
    }
    const prevButtons = this.lastButtons;
    this.lastButtons = buttons;
    this.seq++;
    this.net.send({
      t: 'input',
      seq: this.seq,
      moveX,
      moveZ,
      yaw: this.input.yaw,
      pitch: this.input.pitch,
      buttons,
    });

    const weapon = snapYou?.weapon ?? 'pistol';
    const wd = WEAPONS[weapon];
    // MUST mirror net.ts's own internal reconcile speedMul exactly (alive: 1,
    // downed: SURVIVOR.downedMoveMul, dead: 0) or replay after reconciliation
    // diverges from what the server actually simulated.
    const statusMul =
      snapYou === null ? 1 : snapYou.status === 'alive' ? 1 : snapYou.status === 'downed' ? SURVIVOR.downedMoveMul : 0;
    const speedMul = statusMul * wd.moveMul;
    const moveInput: MoveInput = {
      moveX,
      moveZ,
      yaw: this.input.yaw,
      jump: (buttons & INPUT_JUMP) !== 0,
      crouch: (buttons & INPUT_CROUCH) !== 0,
      walk: (buttons & INPUT_WALK) !== 0,
    };
    this.net.predictor().pushInput(this.seq, moveInput, speedMul);

    // immediate local fire feedback — the server 'shot' echo trails by an RTT+tick
    if (snapYou !== null && snapYou.mag !== 0 && (buttons & INPUT_FIRE) !== 0 && (prevButtons & INPUT_FIRE) === 0) {
      this.world.viewmodel.fire();
      this.world.rig.shake(FIRE_SHAKE_ADD);
      this.audio.sfx(SHOT_SFX[weapon]);
      this.bloomDeg = Math.min(this.bloomDeg + wd.spreadPerShot, Math.max(0, wd.maxSpreadDeg - wd.spreadDeg));
    }
  }

  private handleEdges(): void {
    for (const e of this.input.edges()) {
      switch (e) {
        case 'scoreboard':
          this.scoreboardOpen = !this.scoreboardOpen;
          break;
        case 'reload':
          this.reload();
          break;
        case 'qswitch':
          if (this.prevHeldWeapon !== null) this.switchWeapon(this.prevHeldWeapon);
          break;
        case 'slot1':
        case 'slot2':
        case 'slot3': {
          const idx = e === 'slot1' ? 0 : e === 'slot2' ? 1 : 2;
          const w2 = this.net.snap()?.you.weapons[idx];
          if (w2 !== undefined) this.switchWeapon(w2);
          break;
        }
        case 'menu':
          // pause is pointer-lock-driven (see header); nothing to do here —
          // Escape's own browser-level pointer-unlock is what drives it.
          break;
      }
    }
  }

  private handlePhase(snap: SnapshotMsg): void {
    const prev = this.prevPhase;
    if (snap.phase !== prev) {
      if (prev === 'lobby' && snap.phase !== 'lobby') {
        // Dismiss the lobby panel the moment the run begins. Without this the
        // run starts correctly — HUD ticking, wave counting, fences breaching —
        // behind a modal still reading "NOBODY HAS STARTED THE RUN", so START
        // looks completely dead to the player. `MenusApi` has showIntermission
        // /hideIntermission but only showLobby with no hideLobby (a gap in the
        // frozen contract), so the whole-modal-layer hide is the correct tool:
        // entering a wave is exactly when no modal should be open.
        this.menus.hideAll();
        this.hud.show(true); // ...and the HUD comes up as the lobby goes down
      }
      if (snap.phase === 'wave' && prev === 'lobby') {
        this.hud.banner('HOLD THE LINE', `Wave ${snap.wave} incoming`);
      }
      if (snap.phase === 'intermission') {
        this.hud.banner('WAVE CLEARED', 'Repair — restock — buy');
      }
      if (prev === 'intermission' && snap.phase === 'wave') {
        this.menus.hideIntermission();
      }
      if (snap.phase === 'ended') {
        this.menus.hideAll();
        const info = this.lastRunStats !== null ? { wave: snap.wave, stats: this.lastRunStats } : null;
        this.hud.runEnd(info);
        this.menus.showRunEnd(info);
        this.audio.sfx('run_end');
      }
      if (prev === 'ended' && snap.phase !== 'ended') {
        this.hud.runEnd(null);
        this.menus.hideAll();
      }
      this.prevPhase = snap.phase;
    }

    if (snap.phase === 'lobby') {
      this.menus.showLobby(Array.from(this.roster.values()), snap.canStart);
    } else if (snap.phase === 'intermission') {
      const secLeft = Math.max(0, Math.round((snap.phaseEndsAt - this.net.serverNow()) / 1000));
      this.menus.showIntermission(secLeft, snap.wave);
    } else if (snap.phase === 'wave' && snap.wave === 1 && snap.zombies.length === 0 && !this.lullHintFired) {
      this.lullHintFired = true;
      this.menus.hint('stairs', 'The ammo crate is below. The fence is beyond that.');
    }

    // A one-time cosmetic hint must NEVER be able to kill the frame loop. The
    // server always sends `segments`, but a snapshot that arrives without it
    // (or any future shape drift) was taking the whole render loop down with a
    // "snap.segments is not iterable" banner, from the lobby, before the run
    // even started. Guard the read; the fence ring below surfaces the real data.
    if (!this.repairHintFired && Array.isArray(snap.segments)) {
      for (const s of snap.segments) {
        if (s.hp < 0.6) {
          this.repairHintFired = true;
          this.menus.hint('repair', 'HOLD E at a damaged segment to repair it.');
          break;
        }
      }
    }
  }

  private handleInteract(you: YouSnap, dt: number): void {
    // The AMMO CRATE gets NO modal. It is a single-button action and the HUD
    // already shows "HOLD E — RESUPPLY (60 SCRAP)"; popping a full panel in the
    // player's face just to repeat that blocks the view mid-fight for no gain.
    // The WEAPON RACK keeps its panel because you genuinely have to choose
    // between four guns and read their prices — there is nowhere else to put
    // that. Proximity opens it; walking away closes it.
    if (you.interact !== this.prevInteract) {
      // The rack panel is KEYBOARD-driven (each row carries its own hotkey) and
      // closes by walking away. Pointer lock therefore STAYS — releasing it was
      // a trap: the input controller only reads WASD while locked, so freeing
      // the cursor also froze movement and the player could neither click out
      // nor walk out. A proximity panel must never take the controls away.
      if (you.interact === 'weaponRack' && this.input.locked()) this.menus.showWeaponRack(you.scrap, you.weapons);
      else if (this.prevInteract === 'weaponRack') this.menus.hideAll();
      this.prevInteract = you.interact;
      this.repairTickAcc = 0;
      this.reviveTickAcc = 0;
    } else if (you.interact === 'weaponRack' && this.input.locked()) {
      // Only re-assert the rack while the player is actually IN the game.
      // `showWeaponRack` calls showExclusive, so re-running it every frame after
      // Esc would hide the pause menu the instant it appeared — leaving the
      // mouse free, the rack on screen, and NO route back to a locked cursor.
      this.menus.showWeaponRack(you.scrap, you.weapons);
    }

    // AMMO CRATE: holding INTERACT buys one magazine per tick. The crate's modal
    // used to be the ONLY thing that sent `buy_ammo` — removing it (correctly,
    // it blocked the view for a one-button action) silently removed the ability
    // to buy ammo at all. The hold has to do the work the panel used to.
    if (you.interact === 'ammoCrate' && this.interactHeld) {
      this.ammoTickAcc += dt;
      if (this.ammoTickAcc >= ECONOMY.ammoRefillIntervalSec) {
        this.ammoTickAcc = 0;
        this.buyAmmo();
      }
    } else {
      this.ammoTickAcc = 0;
    }

    if (you.interact === 'repair') {
      this.repairTickAcc += dt;
      if (this.repairTickAcc >= REPAIR_TICK_INTERVAL) {
        this.repairTickAcc = 0;
        this.audio.sfx('repair_tick');
      }
    }
    if (you.interact === 'revive') {
      this.reviveTickAcc += dt;
      if (this.reviveTickAcc >= REVIVE_TICK_INTERVAL) {
        this.reviveTickAcc = 0;
        this.audio.sfx('revive_tick');
      }
    }
  }

  private updateFootsteps(body: BodyState, you: YouSnap): void {
    const dx = body.x - this.lastFootX;
    const dz = body.z - this.lastFootZ;
    this.lastFootX = body.x;
    this.lastFootZ = body.z;
    const d = Math.hypot(dx, dz);
    if (!body.onGround || you.status !== 'alive' || d > STEP_CLAMP_M) {
      this.footAcc = 0;
      return;
    }
    this.footAcc += d;
    if (this.footAcc >= STEP_EVERY_M) {
      this.footAcc = 0;
      this.audio.sfx('footstep');
      this.world.effects.footDust({ x: body.x, y: 0, z: body.z });
    }
  }

  private syncReviveBeacons(snap: SnapshotMsg): void {
    const seen = new Set<PlayerId>();
    for (const p of snap.players) {
      if (p.st !== 'downed') continue;
      seen.add(p.id);
      this.world.effects.reviveBeacon(p.id, { x: p.x, y: p.y, z: p.z }, true);
    }
    for (const [id, pos] of this.beaconPos) {
      if (!seen.has(id)) this.world.effects.reviveBeacon(id, pos, false);
    }
    this.beaconPos.clear();
    for (const p of snap.players) {
      if (p.st === 'downed') this.beaconPos.set(p.id, { x: p.x, y: p.y, z: p.z });
    }
  }

  private buildHudState(snap: SnapshotMsg, you: YouSnap): HudState {
    const body = this.net.predictor().body();
    const downed: { id: PlayerId; name: string; dist: number; bleedout: number; beingRevived: boolean }[] = [];
    let ownRevive: SnapshotMsg['players'][number] | undefined;
    for (const p of snap.players) {
      if (p.id === this.youId) {
        ownRevive = p;
        continue;
      }
      if (p.st !== 'downed') continue;
      downed.push({
        id: p.id,
        name: p.n,
        dist: Math.hypot(p.x - body.x, p.y - body.y, p.z - body.z),
        bleedout: p.bl,
        beingRevived: p.revBy !== null,
      });
    }
    const wd = WEAPONS[you.weapon];
    return {
      hp: you.hp,
      status: you.status,
      bleedout: you.bleedout,
      scrap: you.scrap,
      weapon: you.weapon,
      weaponName: wd.name,
      mag: you.mag,
      reserve: you.reserve,
      phase: snap.phase,
      wave: snap.wave,
      waveRemaining: snap.waveRemaining,
      phaseEndsInMs: snap.phaseEndsAt > 0 ? Math.max(0, snap.phaseEndsAt - this.net.serverNow()) : 0,
      segments: snap.segments,
      yaw: this.input.yaw,
      interact: you.interact,
      interactProgress: you.interactProgress,
      interactCost: you.interactCost,
      interactOptions:
        you.interact === 'weaponRack'
          ? RACK_WEAPONS.map((w2) => ({
              weapon: w2,
              price: ECONOMY.weaponPrice[w2],
              affordable: you.scrap >= ECONOMY.weaponPrice[w2],
            }))
          : [],
      downed,
      ownReviveProgress: ownRevive?.rev ?? 0,
      ownReviveBy: ownRevive?.revBy !== undefined && ownRevive.revBy !== null ? this.nameOf(ownRevive.revBy) : null,
      ticker: this.ticker,
      squad: this.scoreboardOpen
        ? snap.players.map((p) => ({ id: p.id, name: p.n, status: p.st, kills: p.k, revives: p.rv }))
        : [],
      seated: snap.seated,
      minPlayers: snap.minPlayers,
      canStart: snap.canStart,
      you: this.youId,
      spectating: you.status === 'dead' ? this.youId : null,
      returnAtWave: you.returnAtWave,
      crosshairSpreadPx: (wd.spreadDeg + this.bloomDeg) * CROSSHAIR_PX_PER_DEG,
      scoped: this.scoped,
    };
  }

  // ==========================================================================
  // OutpostEvent -> FX + SFX + HUD (UX_BIBLE: every action, feedback <100ms)
  // ==========================================================================

  private handleEvent(ev: OutpostEvent): void {
    const w = this.world;
    switch (ev.t) {
      case 'shot': {
        w.effects.tracer(ev.from, ev.to);
        const dx = ev.to.x - ev.from.x;
        const dy = ev.to.y - ev.from.y;
        const dz = ev.to.z - ev.from.z;
        const len = Math.hypot(dx, dy, dz);
        const dir = len > 1e-6 ? { x: dx / len, y: dy / len, z: dz / len } : { x: 0, y: 0, z: -1 };
        w.effects.muzzleSmoke(ev.from, dir);
        if (ev.shooterId === this.youId) break; // local fire feedback already fired on the input edge
        this.audio.sfx(SHOT_SFX[ev.weapon], this.spatialOpts(ev.from));
        w.survivors.muzzle(ev.shooterId);
        break;
      }
      case 'hit': {
        const pos = this.zombiePos(ev.zombieId);
        if (pos !== null) w.effects.bloodHit(pos, ev.headshot);
        if (ev.shooterId !== this.youId) break;
        this.hud.hitmarker(ev.headshot, ev.killed);
        this.audio.sfx(ev.headshot ? 'headshot' : 'hit_flesh');
        break;
      }
      case 'zombie_died': {
        const pos: Vec3W = { x: ev.x, y: ev.y, z: ev.z };
        w.effects.zombieDeath(pos, ev.kind);
        if (ev.byId === this.youId) w.effects.scrapPop(pos, ev.scrap);
        this.audio.sfx('zombie_die', this.spatialOpts(pos));
        if (ev.byId !== null) this.pushTicker(`${this.nameOf(ev.byId)} downed a ${ev.kind}`, 'kill');
        break;
      }
      case 'dmg_taken': {
        if (ev.victimId !== this.youId) break;
        this.hud.damageFrom(wrapPi(ev.yaw - this.input.yaw), ev.dmg);
        w.rig.shake(clamp(0.15 + ev.dmg / 100, 0.15, 1));
        break;
      }
      case 'downed': {
        const name = this.nameOf(ev.id);
        if (ev.id === this.youId) {
          this.hud.banner('YOU ARE DOWN', 'A teammate can revive you');
        } else {
          this.hud.teammateDown(ev.id, name, true);
          this.hud.banner(`${name.toUpperCase()} IS DOWN`, 'Revive them before they bleed out');
        }
        this.audio.sfx('downed', this.spatialOpts({ x: ev.x, y: ev.y, z: ev.z }));
        this.pushTicker(`${name} went down`, 'down');
        if (!this.reviveHintFired) {
          this.reviveHintFired = true;
          this.menus.hint('revive', 'HOLD E next to a downed teammate to revive them.');
        }
        break;
      }
      case 'revived': {
        const name = this.nameOf(ev.id);
        this.hud.teammateDown(ev.id, name, false);
        this.audio.sfx('revive_done');
        if (ev.id === this.youId) this.hud.banner('BACK UP', `Revived by ${this.nameOf(ev.byId)}`);
        this.pushTicker(`${this.nameOf(ev.byId)} revived ${name}`, 'revive');
        break;
      }
      case 'died': {
        const name = this.nameOf(ev.id);
        this.hud.teammateDown(ev.id, name, false);
        if (ev.id === this.youId) this.hud.banner('YOU DIED', 'Watch the fight — you return next wave');
        break;
      }
      case 'returned': {
        if (ev.id === this.youId) this.hud.banner('BACK IN THE FIGHT', `Wave ${this.net.snap()?.wave ?? 0}`);
        break;
      }
      case 'seg_hit': {
        const seg = SEGMENTS[ev.seg];
        if (seg !== undefined) {
          const pos: Vec3W = { x: seg.cx, y: 1, z: seg.cz };
          w.effects.fenceHit(pos);
          this.audio.sfx('fence_hit', this.spatialOpts(pos));
        }
        break;
      }
      case 'seg_breached': {
        const seg = SEGMENTS[ev.seg];
        if (seg !== undefined) {
          const pos: Vec3W = { x: seg.cx, y: 0.5, z: seg.cz };
          w.effects.fenceBreak(pos);
          const body = this.net.predictor().body();
          const d = Math.hypot(seg.cx - body.x, seg.cz - body.z);
          w.rig.shake(clamp(1 - d / 30, 0.15, 0.7));
          this.pushTicker(`${seg.side.toUpperCase()} FENCE BREACHED`, 'breach');
          this.hud.banner('FENCE BREACHED', `${seg.side} side — the horde is inside`);
        } else {
          this.hud.banner('FENCE BREACHED', '');
        }
        this.audio.sfx('fence_break');
        break;
      }
      case 'seg_repaired': {
        if (ev.full) this.audio.sfx('repair_done');
        break;
      }
      case 'wave_start': {
        this.hud.banner(`WAVE ${ev.wave}`, `${ev.count} incoming`);
        this.audio.sfx('wave_start');
        this.pushTicker(`Wave ${ev.wave} incoming`, 'wave');
        break;
      }
      case 'wave_clear': {
        this.audio.sfx('wave_clear');
        this.pushTicker(`Wave ${ev.wave} cleared`, 'wave');
        break;
      }
      case 'buy_result': {
        this.audio.sfx(ev.ok ? 'buy' : 'deny');
        // SAY WHY. A silent refusal is indistinguishable from a broken button:
        // holding E on a full reserve spends nothing and changes nothing, so the
        // resupply reads as dead when it is in fact working correctly. The
        // server already sends its reason — surface it.
        if (ev.ok) {
          if (ev.weapon !== null) this.hud.banner('RESUPPLIED', `${WEAPONS[ev.weapon].name} +1 mag`);
        } else if (ev.reason !== null) {
          this.hud.banner('CAN\u2019T BUY', ev.reason.toUpperCase());
        }
        break;
      }
      case 'spit_land': {
        const pos: Vec3W = { x: ev.x, y: ev.y, z: ev.z };
        w.effects.spitLand(pos);
        this.audio.sfx('spit_land', this.spatialOpts(pos));
        break;
      }
      case 'run_end': {
        this.lastRunStats = ev.stats;
        break;
      }
      case 'player_joined': {
        this.roster.set(ev.entry.id, ev.entry);
        break;
      }
      case 'player_left': {
        this.roster.delete(ev.id);
        break;
      }
    }
  }

  // ==========================================================================
  // Small helpers
  // ==========================================================================

  private nameOf(id: PlayerId): string {
    const snap = this.net.snap();
    if (snap !== null) {
      for (const p of snap.players) if (p.id === id) return p.n;
    }
    return this.roster.get(id)?.name ?? id;
  }

  private zombiePos(id: ZombieId): Vec3W | null {
    for (const z of this.net.zombies()) {
      if (z.id === id) return { x: z.x, y: z.y, z: z.z };
    }
    return null;
  }

  /** dist/bearing for AudioApi's stereo pan, relative to the local camera. */
  private spatialOpts(pos: Vec3W): SfxOpts {
    const body = this.net.predictor().body();
    const dx = pos.x - body.x;
    const dz = pos.z - body.z;
    const dist = Math.hypot(dx, dz);
    const angleTo = Math.atan2(-dx, -dz); // matches sim's yaw convention (yaw 0 = -Z)
    return { dist, bearing: wrapPi(angleTo - this.input.yaw) };
  }

  private pushTicker(text: string, kind: TickerKind): void {
    this.ticker.push({ text, kind });
    if (this.ticker.length > TICKER_MAX) this.ticker.shift();
  }

  private maybeShowOnboarding(): void {
    let seen = false;
    try {
      seen = localStorage.getItem(ONBOARD_KEY) === '1';
    } catch {
      seen = false;
    }
    if (seen) return;
    this.menus.showOnboarding();
    try {
      localStorage.setItem(ONBOARD_KEY, '1');
    } catch {
      // best-effort — a blocked/private-mode store just re-shows it next boot
    }
  }

  /** Clear per-run actors back to empty. The renderer/world itself persists — see header. */
  private clearDynamicActors(): void {
    this.world.zombies.clear();
    this.world.survivors.clear();
    this.world.effects.clear();
    this.beaconPos.clear();
  }

  private resetRoomState(): void {
    this.youId = null;
    this.roomId = null;
    this.code = null;
    this.roster.clear();
    this.lastRunStats = null;
    this.prevPhase = 'lobby';
    this.prevInteract = 'none';
    this.ticker.length = 0;
    this.scoreboardOpen = false;
    this.freeCamState = null;
    this.todOverride = null;
    this.lastAppliedTod = null;
    this.wasLocked = false;
    this.dbgMove = null;
    this.dbgButtons = 0;
    this.dbgFireOnce = false;
    this.lastWeapon = null;
    this.prevHeldWeapon = null;
    this.bloomDeg = 0;
    this.scoped = false;
    this.repairHintFired = false;
    this.reviveHintFired = false;
    this.lullHintFired = false;
    this.heartbeatAcc = 0;
    this.repairTickAcc = 0;
    this.reviveTickAcc = 0;
    this.footAcc = 0;
    const b = makeBody(0, 0, 0);
    this.lastFootX = b.x;
    this.lastFootZ = b.z;
  }
}
