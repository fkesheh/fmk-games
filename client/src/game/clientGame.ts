// ============================================================================
// C10 — ClientGame: wires net + input + render + ui + audio into one game.
// One Connection per session (lobby -> room, reused across listRooms/join);
// one World (SceneRig + map + predictor + interp + models + viewmodel +
// effects) per joined room, built on 'joined' and fully disposed on leave —
// renderer included, so a later join starts from a clean GPU state.
// Prediction gate mirrors the frozen server invariant: inputs are SENT in
// every phase, but the local body only advances in warmup/live while alive —
// zero rubber-banding at round start. Every handler is wrapped: one bad
// message or frame must never kill the rAF loop.
//
// C10/C11 SEAM (specs/C11.md — additive public methods main.ts calls; the
// frozen table above them is unchanged, do not rename without syncing both):
//   resize(): void                       — forwards to SceneRig.resize()
//   buy(w): void / reload(): void        — send the C2S (menu onBuy + e2e debug)
//   debugSetLook(yaw, pitch): void       — writes InputController yaw/pitch
//   debugSetMove(x, z): void             — overrides move axes (0,0 releases)
//   debugSetButton(btn, down): void      — sets/clears an INPUT_* held bit
//   debugInfo(): { pos; players; pingMs } — e2e state probe (pos = predicted feet)
// Reverse direction: main.ts dispatches ONE 'fps:gesture' window Event on the
// first pointerdown/keydown; we listen for it and resume the AudioEngine here
// (browsers gate AudioContext creation on a user gesture).
// ============================================================================
import {
  BASE_FOV,
  INPUT_ALT,
  INPUT_CROUCH,
  INPUT_FIRE,
  INPUT_JUMP,
  MAPS,
  NET,
  PLAYER,
  TICK_RATE,
  WEAPONS,
  WEAPON_ORDER,
} from '@fps/shared';
import type {
  GameEvent,
  MapId,
  PlayerId,
  PlayerSnap,
  RoomInfo,
  RosterEntry,
  RoundEndReason,
  S2C,
  Team,
  Vec3,
  WeaponId,
  YouSnap,
} from '@fps/shared';
import { Connection } from '../net/connection.js';
import { InterpBuffer } from '../net/interpolation.js';
import { Predictor } from '../net/prediction.js';
import { InputController } from '../input/input.js';
import { SceneRig } from '../render/scene.js';
import { buildMap } from '../render/mapRenderer.js';
import { PlayerModels } from '../render/playerModels.js';
import { ViewModel } from '../render/viewModel.js';
import { Effects } from '../render/effects.js';
import { AudioEngine } from '../audio/audio.js';
import type { SfxKind } from '../audio/audio.js';
import type { Hud, HudState } from '../ui/hud.js';
import type { Menus } from '../ui/menus.js';
import { ClientState } from './state.js';

// ---- tuning (frozen by CONTRACT.md / UX_BIBLE.md) ---------------------------
const TICK_MS = 1000 / TICK_RATE;
const MAX_INPUTS_PER_FRAME = 4; // mirrors NET.maxInputPerTick — drop backlog after a hitch
const STEP_EVERY_M = PLAYER.speedRun * 0.38; // one footstep per 1.824m ≈ 0.38s at run speed
const STEP_CLAMP_M = 0.5; // teleport/reconcile snaps never trigger footsteps
const MOVE_MIN_SPEED = 0.5; // m/s — matches PlayerSnap.moving / walk-bob threshold
const LIST_ROOMS_TIMEOUT_MS = 4000;
const DEG2RAD = Math.PI / 180;
const TWO_PI = Math.PI * 2;

const SHOT_SFX: Record<WeaponId, SfxKind> = {
  knife: 'shot_knife',
  pistol: 'shot_pistol',
  smg: 'shot_smg',
  shotgun: 'shot_shotgun',
  rifle: 'shot_rifle',
  sniper: 'shot_sniper',
};

const ROUND_REASON: Record<RoundEndReason, string> = {
  elimination: 'Elimination',
  time: 'Time expired',
  forfeit: 'Forfeit',
};

// indoor maps (ceilinged) get the low hum; everything else gets wind
const INDOOR_MAPS: ReadonlySet<MapId> = new Set(['office', 'bunker']);

const PRIMARIES: readonly WeaponId[] = ['smg', 'shotgun', 'rifle', 'sniper'];

function wrapPi(a: number): number {
  return ((((a + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Per-room render/sim bundle. Built on 'joined', disposed wholesale on leave. */
interface World {
  rig: SceneRig;
  predictor: Predictor;
  interp: InterpBuffer;
  models: PlayerModels;
  viewmodel: ViewModel;
  effects: Effects;
  mapName: string;
}

/** Remote-player footstep tracker: last interpolated pos + distance accumulator. */
interface OtherTrack {
  x: number;
  y: number;
  z: number;
  acc: number;
}

type SyncEntry = PlayerSnap & { team: Team; name: string };

export class ClientGame {
  private readonly canvas: HTMLCanvasElement;
  private readonly hud: Hud;
  private readonly menus: Menus;
  private readonly state: ClientState;
  private readonly input: InputController;
  private readonly audio: AudioEngine;

  private conn: Connection | null = null;
  private world: World | null = null;
  private joining = false; // 'Joining…' overlay visible; error/close -> showMain
  private joinToken = 0; // stale-connect guard (double-clicked join buttons)
  private disposed = false;

  private seq = 0; // input sequence, monotonic from 1 per room
  private inputAccMs = 0; // TICK_RATE send accumulator
  private lastFrameMs = -1;
  private lastButtons = 0; // buttons of the most recent sampled input
  private hadSelfSnap = false; // first self snapshot hard-resets the predictor
  private scoped = false;
  private bloomDeg = 0; // cosmetic crosshair bloom, mirrors server spread+bloom
  private buyOpen = false;
  private buySig = ''; // money|weapons|canBuy signature of the open buy menu
  private stepAccM = 0; // own footstep distance accumulator
  private lastBodyX = 0;
  private lastBodyZ = 0;
  private respawnSec = -1; // cached countdown second for the warmup-death label
  private respawnLabel = '';
  // e2e debug overrides (window.__fps.debug via C11); win over held keys when set
  private dbgMove: { x: number; z: number } | null = null;
  private dbgButtons = 0;

  private roomListResolve: ((rooms: RoomInfo[]) => void) | null = null;
  private roomListTimer: ReturnType<typeof setTimeout> | null = null;

  // reused per-frame scratch — zero allocation in the rAF hot path
  private readonly camPos: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly fxPoint: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly hudState: HudState = {
    hp: 100, alive: true, money: 0, canBuy: false,
    weapon: 'pistol', weaponName: '', mag: -1, reserve: -1,
    phase: 'warmup', phaseEndsInSec: 0, round: 0, scoreT: 0, scoreCT: 0,
    spreadPx: 0, scoped: false, spectating: null,
  };
  private readonly syncOut: SyncEntry[] = []; // roster-merged remotes, reused array
  private readonly syncPool = new Map<PlayerId, SyncEntry>(); // per-id reused entries
  private readonly others = new Map<PlayerId, OtherTrack>(); // footstep tracking

  constructor(opts: { canvas: HTMLCanvasElement; hud: Hud; menus: Menus; state: ClientState }) {
    this.canvas = opts.canvas;
    this.hud = opts.hud;
    this.menus = opts.menus;
    this.state = opts.state;
    this.input = new InputController(opts.canvas);
    this.audio = new AudioEngine();
    this.input.onLockChange = (locked) => this.onLockChange(locked);
    // C10/C11 seam: main.ts dispatches ONE 'fps:gesture' on the first real
    // pointerdown/keydown; resume() is idempotent (C7)
    window.addEventListener('fps:gesture', this.onFirstGesture);
    // B/Esc close an open buy menu while the pointer is unlocked (InputController
    // only sees keys while locked, so it never delivers these)
    window.addEventListener('keydown', this.onKeyDown);
  }

  // ---- public API (frozen; called by C11 main.ts) -----------------------------

  joinQuick(name: string): void {
    this.startJoin((c) => c.send({ t: 'quick_join', name }));
  }

  createPrivate(name: string, mapId: MapId): void {
    this.startJoin((c) => c.send({ t: 'create_private', name, mapId }));
  }

  joinPrivate(name: string, code: string): void {
    this.startJoin((c) => c.send({ t: 'join_private', name, code }));
  }

  listRooms(): Promise<RoomInfo[]> {
    if (this.disposed || this.world !== null) return Promise.resolve([]); // main-menu only
    return this.ensureConn()
      .then(
        (conn) =>
          new Promise<RoomInfo[]>((resolve) => {
            this.failRoomList(); // a newer request supersedes a stale in-flight one
            this.roomListResolve = resolve;
            this.roomListTimer = setTimeout(() => {
              if (this.roomListResolve === resolve) {
                this.roomListResolve = null;
                this.roomListTimer = null;
                resolve([]); // server gone silent — show an empty list, not a hang
              }
            }, LIST_ROOMS_TIMEOUT_MS);
            conn.send({ t: 'list_rooms' });
          }),
      )
      .catch(() => []); // unreachable server -> empty list
  }

  leave(): void {
    if (this.disposed) return;
    const conn = this.conn;
    if (conn !== null) {
      conn.send({ t: 'leave' });
      conn.close(); // explicit close: onClose does not fire
      this.conn = null;
    }
    this.joining = false;
    this.teardownWorld();
    this.resetState();
    this.hud.show(false);
    this.menus.showMain();
  }

  frame(nowMs: number): void {
    if (this.disposed) return;
    const w = this.world;
    if (w === null) {
      this.lastFrameMs = nowMs; // keep dt continuous across room joins
      return;
    }
    this.guard(() => this.frameInner(nowMs, w));
  }

  dispose(): void {
    if (this.disposed) return;
    this.leave(); // close conn, teardown world, back to main
    this.disposed = true;
    this.failRoomList();
    window.removeEventListener('fps:gesture', this.onFirstGesture);
    window.removeEventListener('keydown', this.onKeyDown);
  }

  // ---- C10/C11 seam (additive public methods — see header) ---------------------

  /** Window resize forwarded to the live SceneRig (no-op out of room). */
  resize(): void {
    this.world?.rig.resize();
  }

  /** Menu onBuy + e2e debug: send the buy request; server validates. */
  buy(weapon: WeaponId): void {
    this.conn?.send({ t: 'buy', weapon });
  }

  /** E2E debug: same path as the R edge. */
  reload(): void {
    this.doReload();
  }

  /** E2E debug: write look angles directly (pitch clamped like the mouse path). */
  debugSetLook(yaw: number, pitch: number): void {
    this.input.yaw = wrapPi(yaw);
    this.input.pitch = clamp(pitch, -1.45, 1.45);
  }

  /** E2E debug: override move axes; (0,0) releases back to the keyboard. */
  debugSetMove(x: number, z: number): void {
    this.dbgMove = x === 0 && z === 0 ? null : { x: clamp(x, -1, 1), z: clamp(z, -1, 1) };
  }

  /** E2E debug: hold/release an INPUT_* button bit. */
  debugSetButton(btn: 'fire' | 'jump' | 'crouch' | 'alt', down: boolean): void {
    const bit =
      btn === 'fire'
        ? INPUT_FIRE
        : btn === 'jump'
          ? INPUT_JUMP
          : btn === 'crouch'
            ? INPUT_CROUCH
          : INPUT_ALT;
    this.dbgButtons = down ? this.dbgButtons | bit : this.dbgButtons & ~bit;
  }

  /** E2E/debug overlay probe: predicted feet pos, live snap count, smoothed RTT. */
  debugInfo(): { pos: [number, number, number]; players: number; pingMs: number } {
    const w = this.world;
    if (w === null) return { pos: [0, 0, 0], players: 0, pingMs: this.conn?.pingMs() ?? 0 };
    const b = w.predictor.body();
    return { pos: [b.x, b.y, b.z], players: this.syncOut.length, pingMs: this.conn?.pingMs() ?? 0 };
  }

  // ---- join / connection plumbing ----------------------------------------------

  private startJoin(sendJoin: (conn: Connection) => void): void {
    if (this.disposed) return;
    // re-joining from inside a room: drop the old world + socket first
    if (this.world !== null) {
      this.conn?.close();
      this.conn = null;
      this.teardownWorld();
      this.resetState();
      this.hud.show(false);
    }
    this.joining = true;
    const token = ++this.joinToken;
    this.menus.showJoining();
    this.ensureConn()
      .then((conn) => sendJoin(conn))
      .catch(() => {
        if (this.joinToken !== token) return; // superseded by a newer join
        this.joining = false;
        this.menus.showMain('Could not reach the server');
      });
  }

  /** Reuse the live lobby connection, or open a fresh one. */
  private ensureConn(): Promise<Connection> {
    const existing = this.conn;
    if (existing !== null) return Promise.resolve(existing);
    const conn = new Connection();
    this.conn = conn;
    conn.onMessage = (msg) => this.guard(() => this.handleMessage(msg));
    conn.onClose = () => this.guard(() => this.handleClose(conn));
    return conn.connect().then(
      () => conn,
      (err: unknown) => {
        if (this.conn === conn) this.conn = null;
        throw err instanceof Error ? err : new Error(String(err));
      },
    );
  }

  private handleClose(conn: Connection): void {
    if (this.conn !== conn) return; // stale socket from a previous session
    this.conn = null;
    this.failRoomList();
    if (this.world !== null) {
      this.teardownWorld();
      this.resetState();
      this.hud.show(false);
      this.menus.showMain('Connection lost');
    } else if (this.joining) {
      this.joining = false;
      this.menus.showMain('Connection lost');
    }
  }

  private resolveRoomList(rooms: RoomInfo[]): void {
    const r = this.roomListResolve;
    if (r === null) return;
    this.roomListResolve = null;
    if (this.roomListTimer !== null) {
      clearTimeout(this.roomListTimer);
      this.roomListTimer = null;
    }
    r(rooms);
  }

  private failRoomList(): void {
    this.resolveRoomList([]);
  }

  // ---- world lifecycle ------------------------------------------------------------

  private buildWorld(mapId: MapId): void {
    this.teardownWorld(); // defensive: never two rigs on one canvas
    const map = MAPS[mapId];
    const rig = new SceneRig(this.canvas);
    rig.setTheme(map.theme);
    const built = buildMap(map);
    rig.scene.add(built.root);
    rig.scene.add(rig.camera); // viewmodel parents to the camera — it must be in the graph
    this.world = {
      rig,
      predictor: new Predictor(built.solids),
      interp: new InterpBuffer(),
      models: new PlayerModels(rig.scene),
      viewmodel: new ViewModel(rig.camera),
      effects: new Effects(rig.scene),
      mapName: map.name,
    };
    this.input.start();
  }

  private teardownWorld(): void {
    const w = this.world;
    if (w === null) return;
    this.world = null; // null first: input.stop()'s lock-loss must not pop the pause menu
    this.input.stop();
    w.rig.dispose(); // scene geometries + renderer; the next join rebuilds from scratch
    this.scoped = false;
    this.buyOpen = false;
    this.buySig = '';
    this.syncOut.length = 0;
    this.syncPool.clear();
    this.others.clear();
  }

  private resetState(): void {
    const s = this.state;
    s.youId = null;
    s.team = null;
    s.roomId = null;
    s.code = null;
    s.mapId = null;
    s.phase = 'warmup';
    s.phaseEndsAt = 0;
    s.round = 0;
    s.scoreT = 0;
    s.scoreCT = 0;
    s.roster.clear();
    s.latestYou = null;
    this.hadSelfSnap = false;
    this.bloomDeg = 0;
    this.seq = 0;
    this.inputAccMs = 0;
    this.lastButtons = 0;
    this.stepAccM = 0;
    this.respawnSec = -1;
    this.dbgMove = null;
    this.dbgButtons = 0;
  }

  // ---- S2C dispatch (every handler wrapped by guard at the call site) --------------

  private handleMessage(msg: S2C): void {
    switch (msg.t) {
      case 'welcome':
        this.state.youId = msg.playerId;
        break;
      case 'room_list':
        this.resolveRoomList(msg.rooms);
        break;
      case 'joined':
        this.onJoined(msg);
        break;
      case 'snapshot':
        this.onSnapshot(msg);
        break;
      case 'event':
        this.onEvent(msg.ev);
        break;
      case 'error':
        // join-time rejections (no_room / room_full / rooms_full) land here
        if (this.joining) {
          this.joining = false;
          this.menus.showMain(msg.message);
        }
        break;
      case 'pong':
        break; // consumed inside Connection — never forwarded in practice
    }
  }

  private onJoined(msg: Extract<S2C, { t: 'joined' }>): void {
    this.joining = false;
    const s = this.state;
    s.youId = msg.you;
    s.team = msg.team;
    s.roomId = msg.roomId;
    s.code = msg.code;
    s.mapId = msg.mapId;
    s.round = msg.round;
    s.scoreT = msg.scoreT;
    s.scoreCT = msg.scoreCT;
    s.phase = 'warmup'; // the real phase arrives with the first snapshot
    s.phaseEndsAt = 0;
    s.roster.clear();
    for (const r of msg.roster) s.roster.set(r.id, r);
    s.latestYou = null;
    this.hadSelfSnap = false;
    this.bloomDeg = 0;
    this.seq = 0;
    this.inputAccMs = 0;
    this.lastButtons = 0;
    this.stepAccM = 0;
    this.respawnSec = -1;
    // clock: trust the min-RTT pong sample once it exists, else seed from joined
    const conn = this.conn;
    s.serverOffset =
      conn !== null && conn.pingMs() > 0
        ? conn.serverOffsetMs()
        : msg.serverTime - performance.now();

    try {
      this.buildWorld(msg.mapId);
    } catch {
      // WebGL unavailable — SceneRig already posted its readable error div
      this.conn?.send({ t: 'leave' });
      this.conn?.close();
      this.conn = null;
      this.resetState();
      this.menus.showMain('WebGL is not available in this browser');
      return;
    }
    this.hud.show(true);
    this.menus.hideAll();
    this.menus.showInRoom(MAPS[msg.mapId].name, msg.code);
    this.audio.ambient(!INDOOR_MAPS.has(msg.mapId));
  }

  private onSnapshot(msg: Extract<S2C, { t: 'snapshot' }>): void {
    const w = this.world;
    if (w === null) return; // snapshot for a room we already left
    const s = this.state;
    const conn = this.conn;
    if (conn !== null && conn.pingMs() > 0) s.serverOffset = conn.serverOffsetMs();

    w.interp.push(msg.serverTime, msg.players);

    // own authoritative correction (vy included so gravity replays mid-jump)
    const you = msg.you;
    if (s.youId !== null) {
      for (const p of msg.players) {
        if (p.id !== s.youId) continue;
        if (!this.hadSelfSnap) {
          this.hadSelfSnap = true;
          w.predictor.reset(p.x, p.y, p.z);
        } else {
          w.predictor.reconcile(
            p.x,
            p.y,
            p.z,
            p.crouch ? PLAYER.heightCrouch : PLAYER.heightStand,
            you.vy,
            msg.ack,
            WEAPONS[you.weapon].moveMul,
          );
        }
        break;
      }
    }

    const prevPhase = s.phase;
    s.phase = msg.phase;
    s.phaseEndsAt = msg.phaseEndsAt;
    s.latestYou = you;

    // match end screen is dismissed by the return to warmup
    if (prevPhase === 'matchEnd' && msg.phase === 'warmup') {
      this.menus.hideAll();
      this.menus.showInRoom(w.mapName, s.code);
    }
    // freeze start (round_start or joining mid-freeze) auto-opens the buy menu,
    // now that the snapshot carries fresh money/owned/canBuy
    if (prevPhase !== 'freeze' && msg.phase === 'freeze' && !this.buyOpen) this.openBuy(you);
    // buy window ended under an open menu -> close it; otherwise live-refresh
    if (this.buyOpen) {
      if (!you.canBuy) this.closeBuy();
      else this.refreshBuy(you);
    }
  }

  // ---- GameEvents -----------------------------------------------------------------

  private onEvent(ev: GameEvent): void {
    const s = this.state;
    switch (ev.t) {
      case 'shot': {
        const w = this.world;
        if (w === null) break;
        w.effects.tracer(ev.from, ev.to);
        w.effects.impact(ev.to);
        this.audio.sfx(SHOT_SFX[ev.weapon], { dist: this.distFromCamera(ev.from) });
        if (ev.shooterId === s.youId) {
          w.viewmodel.fire();
          w.rig.shake(0.1);
          const def = WEAPONS[ev.weapon];
          this.bloomDeg = Math.min(
            this.bloomDeg + def.spreadPerShot,
            Math.max(0, def.maxSpreadDeg - def.spreadDeg),
          );
        } else {
          w.models.muzzle(ev.shooterId);
        }
        break;
      }
      case 'kill': {
        const killer = ev.killerId !== null ? s.roster.get(ev.killerId) : undefined;
        const victim = s.roster.get(ev.victimId);
        // server only re-sends the roster on joins/halftime — K/D tracked locally
        if (killer !== undefined) killer.kills += 1;
        if (victim !== undefined) victim.deaths += 1;
        this.hud.killfeed(killer?.name ?? null, victim?.name ?? ev.victimId, ev.weapon, ev.headshot);
        const pos = this.victimPoint(ev.victimId);
        const w = this.world;
        if (pos !== null && w !== null) {
          w.effects.death(pos, victim?.team ?? 'T');
          w.effects.blood(pos);
          this.audio.sfx('death', { dist: this.distFromCamera(pos) });
        } else {
          this.audio.sfx('death');
        }
        break;
      }
      case 'hit': {
        // our shot connected: hitmarker + sound + blood + a tracer to the victim
        this.hud.hitmarker(ev.headshot, ev.killed);
        this.audio.sfx(ev.headshot ? 'headshot' : 'hit');
        const w = this.world;
        if (w === null) break;
        const pos = this.victimPoint(ev.victimId);
        if (pos !== null) {
          w.effects.blood(pos);
          w.effects.tracer(this.camPos, pos);
        }
        break;
      }
      case 'dmg_taken': {
        // first person: no own blood — directional red edge flash + shake
        this.hud.damageFrom(wrapPi(ev.yaw - this.input.yaw));
        this.world?.rig.shake(0.3);
        break;
      }
      case 'round_start': {
        s.round = ev.round;
        s.scoreT = ev.scoreT;
        s.scoreCT = ev.scoreCT;
        this.hud.banner(`ROUND ${ev.round}`, 'BUY (B)');
        this.audio.sfx('round_start');
        // buy menu auto-opens on the freeze snapshot carrying fresh canBuy state
        break;
      }
      case 'round_end': {
        s.scoreT = ev.scoreT;
        s.scoreCT = ev.scoreCT;
        const title =
          ev.winner === null ? 'ROUND DRAW' : ev.winner === s.team ? 'ROUND WON' : 'ROUND LOST';
        this.hud.banner(title, ROUND_REASON[ev.reason]);
        this.audio.sfx('round_end');
        this.closeBuy();
        break;
      }
      case 'match_end': {
        s.scoreT = ev.scoreT;
        s.scoreCT = ev.scoreCT;
        if (this.buyOpen) {
          this.buyOpen = false;
          this.buySig = '';
          this.menus.hideBuy();
        }
        this.menus.showMatchEnd(ev.winner, ev.scoreT, ev.scoreCT, s.team, this.rosterArray());
        this.audio.sfx(ev.winner === s.team ? 'win' : 'lose');
        break;
      }
      case 'halftime': {
        // sides swapped: REPLACE the roster (and with it our own team)
        s.roster.clear();
        for (const r of ev.roster) s.roster.set(r.id, r);
        const me = s.youId !== null ? s.roster.get(s.youId) : undefined;
        if (me !== undefined) s.team = me.team;
        this.hud.banner('HALFTIME', 'SIDES SWAPPED');
        break;
      }
      case 'player_joined':
        s.roster.set(ev.entry.id, ev.entry);
        break;
      case 'player_left':
        s.roster.delete(ev.id);
        this.syncPool.delete(ev.id);
        this.others.delete(ev.id);
        break;
      case 'buy_result': {
        if (ev.ok) {
          this.audio.sfx('buy');
          const you = s.latestYou;
          if (ev.weapon !== null && you !== null) {
            // optimistic mirror of tryBuy (primary replaced); next snapshot confirms
            you.money = Math.max(0, you.money - WEAPONS[ev.weapon].price);
            you.weapons = you.weapons.filter((id) => !PRIMARIES.includes(id));
            you.weapons.push(ev.weapon);
          }
          if (this.buyOpen && you !== null) this.refreshBuy(you);
        } else {
          this.audio.sfx('deny');
        }
        break;
      }
    }
  }

  // ---- per-frame loop ----------------------------------------------------------------

  private frameInner(nowMs: number, w: World): void {
    const dtMs = this.lastFrameMs < 0 ? 0 : Math.min(nowMs - this.lastFrameMs, 100);
    this.lastFrameMs = nowMs;
    const dt = dtMs / 1000;
    const s = this.state;
    const you = s.latestYou;
    const alive = you !== null && you.alive;
    // frozen invariant: bodies move only in warmup/live — prediction follows it
    const predict = alive && (s.phase === 'warmup' || s.phase === 'live');

    this.handleEdges();

    // ---- input sampling: send at TICK_RATE, predict locally on the same inputs ----
    this.inputAccMs += dtMs;
    let sent = 0;
    while (this.inputAccMs >= TICK_MS && sent < MAX_INPUTS_PER_FRAME) {
      this.inputAccMs -= TICK_MS;
      sent++;
      const f = this.input.frame();
      const moveX = this.dbgMove?.x ?? f.moveX; // e2e override wins over held keys
      const moveZ = this.dbgMove?.z ?? f.moveZ;
      const buttons = f.buttons | this.dbgButtons;
      this.lastButtons = buttons;
      this.seq++;
      this.conn?.send({
        t: 'input',
        seq: this.seq,
        moveX,
        moveZ,
        yaw: this.input.yaw,
        pitch: this.input.pitch,
        buttons,
      });
      if (predict && you !== null) {
        this.pushPrediction(w, moveX, moveZ, WEAPONS[you.weapon].moveMul);
      }
    }
    if (sent === MAX_INPUTS_PER_FRAME) this.inputAccMs = 0; // hitch: drop backlog, stay realtime

    // cosmetic crosshair bloom recovery (server owns the real spread)
    if (this.bloomDeg > 0 && you !== null) {
      this.bloomDeg = Math.max(0, this.bloomDeg - WEAPONS[you.weapon].spreadRecover * dt);
    }

    // ---- remotes: interpolated sample merged with roster team/name ----
    this.fillSyncOut(w);

    // ---- camera: predicted eye, or spectate target, or corpse ----
    const body = w.predictor.body();
    const scopedNow =
      alive && (this.lastButtons & INPUT_ALT) !== 0 && you !== null
        ? WEAPONS[you.weapon].zoomFov !== null
        : false;
    if (scopedNow !== this.scoped) {
      this.scoped = scopedNow;
      this.input.setZoomed(scopedNow);
    }
    const def = you !== null ? WEAPONS[you.weapon] : WEAPONS.pistol;
    const fov = scopedNow && def.zoomFov !== null ? def.zoomFov : BASE_FOV;
    const c = this.camPos;
    let spectName: string | null = null;
    let spectated = false;
    if (!alive && you !== null && you.spectateTarget !== null) {
      for (const p of this.syncOut) {
        if (p.id !== you.spectateTarget) continue;
        c.x = p.x;
        c.y = p.y + (p.crouch ? PLAYER.heightCrouch : PLAYER.heightStand) - PLAYER.eyeOffset;
        c.z = p.z;
        w.rig.applyCamera(c, p.yaw, p.pitch, BASE_FOV);
        spectName = s.roster.get(p.id)?.name ?? p.id;
        spectated = true;
        break;
      }
    }
    if (!spectated) {
      c.x = body.x; // eye = feet + height - eyeOffset (inlined: no per-frame Vec3)
      c.y = body.y + body.height - PLAYER.eyeOffset;
      c.z = body.z;
      w.rig.applyCamera(c, this.input.yaw, this.input.pitch, fov);
      if (!alive && you !== null && you.respawnAt !== null && s.phase === 'warmup') {
        // warmup death: nothing special, just a small respawn countdown
        const sec = Math.max(0, Math.ceil((you.respawnAt - s.serverNow()) / 1000));
        if (sec !== this.respawnSec) {
          this.respawnSec = sec;
          this.respawnLabel = `respawn in ${sec}`;
        }
        spectName = this.respawnLabel;
      }
    }

    // ---- footsteps: distance-driven (0.38s per step at run speed) ----
    const hSpeed = Math.hypot(body.vx, body.vz);
    if (alive && body.onGround && hSpeed > MOVE_MIN_SPEED) {
      this.stepAccM += Math.min(Math.hypot(body.x - this.lastBodyX, body.z - this.lastBodyZ), STEP_CLAMP_M);
      if (this.stepAccM >= STEP_EVERY_M) {
        this.stepAccM %= STEP_EVERY_M;
        this.audio.sfx('footstep');
      }
    }
    this.lastBodyX = body.x;
    this.lastBodyZ = body.z;
    for (const p of this.syncOut) {
      if (p.id === s.youId) continue;
      let t = this.others.get(p.id);
      if (t === undefined) {
        t = { x: p.x, y: p.y, z: p.z, acc: 0 };
        this.others.set(p.id, t);
      }
      if (p.moving && p.alive) {
        t.acc += Math.min(Math.hypot(p.x - t.x, p.z - t.z), STEP_CLAMP_M);
        if (t.acc >= STEP_EVERY_M) {
          t.acc %= STEP_EVERY_M;
          this.audio.sfx('footstep', { dist: this.distFromCamera(p) });
        }
      }
      t.x = p.x;
      t.y = p.y;
      t.z = p.z;
    }

    // ---- models / viewmodel / effects / hud ----
    w.models.sync(this.syncOut, s.youId ?? '', dt);
    w.viewmodel.update(dt, alive && hSpeed > MOVE_MIN_SPEED, scopedNow);
    w.effects.update(dt);

    const h = this.hudState;
    h.hp = you?.hp ?? 100;
    h.alive = alive;
    h.money = you?.money ?? 0;
    h.canBuy = you?.canBuy ?? false;
    h.weapon = def.id;
    h.weaponName = def.name;
    h.mag = you?.mag ?? -1;
    h.reserve = you?.reserve ?? -1;
    h.phase = s.phase;
    h.phaseEndsInSec = s.phaseEndsAt > 0 ? Math.max(0, (s.phaseEndsAt - s.serverNow()) / 1000) : 0;
    h.round = s.round;
    h.scoreT = s.scoreT;
    h.scoreCT = s.scoreCT;
    const effDeg = Math.min(def.spreadDeg + this.bloomDeg, def.maxSpreadDeg);
    h.spreadPx =
      (Math.tan(effDeg * DEG2RAD) / Math.tan((BASE_FOV * DEG2RAD) / 2)) *
      (this.canvas.clientHeight / 2);
    h.scoped = scopedNow;
    h.spectating = spectName;
    this.hud.update(h);

    w.rig.render();
  }

  /** Local prediction for one sampled input (gated by caller on phase/alive). */
  private pushPrediction(w: World, moveX: number, moveZ: number, speedMul: number): void {
    w.predictor.pushInput(
      {
        seq: this.seq,
        input: {
          moveX,
          moveZ,
          yaw: this.input.yaw,
          jump: (this.lastButtons & INPUT_JUMP) !== 0,
          crouch: (this.lastButtons & INPUT_CROUCH) !== 0,
        },
      },
      speedMul,
    );
  }

  /** Interpolated remotes merged with roster team/name, into reused wrappers. */
  private fillSyncOut(w: World): void {
    const s = this.state;
    const sampled = w.interp.sample(s.serverNow() - NET.interpDelayMs);
    const out = this.syncOut;
    out.length = 0;
    for (const p of sampled) {
      let m = this.syncPool.get(p.id);
      if (m === undefined) {
        m = {
          id: p.id, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 0,
          alive: false, crouch: false, moving: false, weapon: 'knife',
          team: 'T', name: '',
        };
        this.syncPool.set(p.id, m);
      }
      m.x = p.x;
      m.y = p.y;
      m.z = p.z;
      m.yaw = p.yaw;
      m.pitch = p.pitch;
      m.hp = p.hp;
      m.alive = p.alive;
      m.crouch = p.crouch;
      m.moving = p.moving;
      m.weapon = p.weapon;
      const r = s.roster.get(p.id);
      m.team = r?.team ?? 'T';
      m.name = r?.name ?? p.id;
      out.push(m);
    }
  }

  /** Last interpolated position of a player, lifted to chest height. Null if gone. */
  private victimPoint(id: PlayerId): Vec3 | null {
    for (const p of this.syncOut) {
      if (p.id !== id) continue;
      const f = this.fxPoint;
      f.x = p.x;
      f.y = p.y + (p.crouch ? 0.9 : 1.2);
      f.z = p.z;
      return f;
    }
    return null;
  }

  private distFromCamera(p: Vec3): number {
    const c = this.camPos;
    return Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z);
  }

  // ---- input edges ---------------------------------------------------------------------

  private handleEdges(): void {
    const w = this.world;
    for (const e of this.input.edges()) {
      switch (e.kind) {
        case 'reload': {
          this.doReload();
          break;
        }
        case 'slot': {
          const you = this.state.latestYou;
          const id = WEAPON_ORDER[e.n - 1];
          if (
            w !== null &&
            you !== null &&
            id !== undefined &&
            id !== you.weapon &&
            you.weapons.includes(id)
          ) {
            this.conn?.send({ t: 'switch', weapon: id });
            // optimistic; snapshot confirms. Switch cancels reload + bloom client-side.
            w.viewmodel.setWeapon(id);
            this.bloomDeg = 0;
          }
          break;
        }
        case 'buy': {
          if (this.buyOpen) this.closeBuy();
          else {
            const you = this.state.latestYou;
            if (you !== null && you.canBuy) this.openBuy(you);
          }
          break;
        }
        case 'scoreboard': {
          if (e.down) {
            const s = this.state;
            this.menus.showScoreboard(this.rosterArray(), s.youId ?? '', s.scoreT, s.scoreCT);
          } else {
            this.menus.hideScoreboard();
          }
          break;
        }
        case 'menu': {
          if (this.world !== null) {
            this.menus.showPause();
            if (document.pointerLockElement !== null) document.exitPointerLock();
          } else {
            this.menus.showMain();
          }
          break;
        }
      }
    }
  }

  /** Send reload + play the dip animation (shared by the R edge and e2e debug). */
  private doReload(): void {
    const you = this.state.latestYou;
    this.conn?.send({ t: 'reload' });
    const w = this.world;
    if (w !== null && you !== null) {
      const dur = WEAPONS[you.weapon].reload;
      if (dur > 0) w.viewmodel.reload(dur); // knife has no reload animation
    }
  }

  // ---- buy menu (pointer unlocks while open so the cards are clickable) -----------------

  private openBuy(you: YouSnap): void {
    if (!you.canBuy) return;
    this.buyOpen = true;
    this.buySig = `${you.money}|${you.weapons.join(',')}|${you.canBuy}`;
    this.menus.showBuy(you.money, you.weapons, you.canBuy);
    if (document.pointerLockElement !== null) document.exitPointerLock();
  }

  private closeBuy(): void {
    if (!this.buyOpen) return;
    this.buyOpen = false;
    this.buySig = '';
    this.menus.hideBuy();
    this.relock();
  }

  /** Re-show the open buy menu only when money/owned/canBuy actually changed. */
  private refreshBuy(you: YouSnap): void {
    const sig = `${you.money}|${you.weapons.join(',')}|${you.canBuy}`;
    if (sig === this.buySig) return;
    this.buySig = sig;
    this.menus.showBuy(you.money, you.weapons, you.canBuy);
  }

  /** Re-request pointer lock (buy close / pause resume); rejection = browser cooldown. */
  private relock(): void {
    if (this.world === null) return;
    try {
      const r: unknown = this.canvas.requestPointerLock();
      if (r instanceof Promise) r.catch(() => {});
    } catch {
      // cooldown after Esc — the next canvas click retries (InputController)
    }
  }

  // ---- misc ------------------------------------------------------------------------------

  private rosterArray(): RosterEntry[] {
    return [...this.state.roster.values()];
  }

  private onLockChange(locked: boolean): void {
    if (locked) return;
    // browsers swallow the Esc keydown on pointer-lock exit — this is the pause signal;
    // an intentional unlock for the buy menu must NOT pause
    if (this.world !== null && !this.buyOpen) this.menus.showPause();
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.buyOpen) return;
    if (e.code === 'KeyB' || e.code === 'Escape') {
      e.preventDefault();
      this.closeBuy();
    }
  };

  private readonly onFirstGesture = (): void => {
    this.audio.resume(); // idempotent — creates/unlocks the AudioContext (C7)
  };

  private guard(fn: () => void): void {
    try {
      fn();
    } catch {
      // robustness rule: one bad message/frame must never kill the rAF loop
    }
  }
}
