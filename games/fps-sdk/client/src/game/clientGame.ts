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
//   buyGear(item): void                  — send buy_gear (menu onBuyGear + console)
//   addBot(): void / removeBot(): void   — send the C2S (menu onAddBot/onRemoveBot)
//   removeAllBots(): number              — kick every bot (menu onRemoveAllBots + console)
//   switchTeam(team): void               — send the C2S (menu onSwitchTeam + e2e debug)
//   debugSetLook(yaw, pitch): void       — writes InputController yaw/pitch
//   debugSetMove(x, z): void             — overrides move axes (0,0 releases)
//   debugSetButton(btn, down): void      — sets/clears an INPUT_* held bit
//   debugInfo(): { pos; players; pingMs } — e2e state probe (pos = predicted feet)
//   scoreboard(down): void               — e2e-only mirror of the Tab edge
//   consoleExec(text): string            — dev console Enter + e2e debug hook
// Reverse direction: main.ts dispatches ONE 'fps:gesture' window Event on the
// first pointerdown/keydown; we listen for it and resume the AudioEngine here
// (browsers gate AudioContext creation on a user gesture).
// ============================================================================
import {
  BASE_FOV,
  GEAR,
  INPUT_ALT,
  INPUT_CROUCH,
  INPUT_FIRE,
  INPUT_JUMP,
  INPUT_WALK,
  MAPS,
  MIN_PLAYERS_FOR_MATCH,
  NET,
  PLAYER,
  TICK_RATE,
  WEAPONS,
  WEAPON_ORDER,
  raycastAABB,
} from '@fps/shared';
import type {
  AABB,
  GameEvent,
  GearId,
  MapId,
  MatId,
  PlayerId,
  PlayerSnap,
  RoomInfo,
  RosterEntry,
  S2C,
  Team,
  Vec3,
  WeaponId,
  YouSnap,
} from '@fps/shared';
// shared cross-game browser identity (CONTRACT_IDENTITY.md): durable `sig` on
// every join, `resume` when we have a session on file, and the room pointer
// that lets a reload/reconnect re-enter the SAME room with no click.
import { cleanName, clearSession, loadName, loadSession, loadSig, saveSession } from '@platform/shared';
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
import type { Hud, HudState, DeathCardInfo, WinStreak } from '../ui/hud.js';
import {
  NO_STREAK,
  STREAK_MIN,
  damageSeverity01,
  nextWinStreak,
  swapStreakSides,
} from '../ui/hud.js';
import {
  SHAKE_FIRE_ADD,
  SHAKE_FIRE_CEIL,
  shakeTraumaForDamage,
} from '../render/scene.js';
import type { Menus } from '../ui/menus.js';
import { ClientState } from './state.js';

// ---- identity (CONTRACT_IDENTITY.md) -----------------------------------------
const GAME = 'fps'; // this client's @platform/shared session-storage key

// ---- tuning (frozen by CONTRACT.md / UX_BIBLE.md) ---------------------------
const TICK_MS = 1000 / TICK_RATE;
const MAX_INPUTS_PER_FRAME = 4; // mirrors NET.maxInputPerTick — drop backlog after a hitch
const STEP_EVERY_M = PLAYER.speedRun * 0.38; // one footstep per 1.824m ≈ 0.38s at run speed
const STEP_CLAMP_M = 0.5; // teleport/reconcile snaps never trigger footsteps
const WALK_STEP_VOL = 0.4; // Shift walk: slow AND quiet (PLAYER.walkSpeedMul does the slow)
const MOVE_MIN_SPEED = 0.5; // m/s — matches PlayerSnap.moving / walk-bob threshold
const SPRINT_MIN_SPEED = 3.4; // m/s — above this, footsteps kick dust (Shift walk caps ~2.64)
const LIST_ROOMS_TIMEOUT_MS = 4000;
const BOT_PROMPT_HIDE_MS = 20000; // solo bot prompt auto-dismiss
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

// indoor maps (ceilinged) get the low hum; everything else gets wind
const INDOOR_MAPS: ReadonlySet<MapId> = new Set(['office', 'bunker']);

// multikill banner titles by streak count (5+ = ACE, handled at the call site)
const MULTIKILL_LABELS: Record<number, string> = {
  2: 'DOUBLE KILL',
  3: 'TRIPLE KILL',
  4: 'QUAD KILL',
};

const PRIMARIES: readonly WeaponId[] = ['smg', 'shotgun', 'rifle', 'sniper'];

function wrapPi(a: number): number {
  return ((((a + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Console `buy` argument validation (WEAPON_ORDER is the frozen id list). */
function isWeaponId(s: string): s is WeaponId {
  return (WEAPON_ORDER as readonly string[]).includes(s);
}

/**
 * Stamp identity onto an outgoing join — the ONE place all four join C2S
 * messages pick up `sig` (always; the durable per-browser signature) and
 * `resume` (only when a stored session exists; the previous playerId, which
 * the room's addPlayer() prefers over `sig` for a rebind — exact and
 * cheapest, per CONTRACT_IDENTITY.md §2.3). `msg` is never a literal at the
 * call site, so the extra fields ride as structural extras of Connection's
 * C2S/LobbyCreate union rather than tripping an excess-property error.
 */
function withIdentity<T extends { t: string }>(msg: T): T & { sig: string; resume?: PlayerId } {
  const session = loadSession(GAME);
  return session === null
    ? { ...msg, sig: loadSig() }
    : { ...msg, sig: loadSig(), resume: session.playerId };
}

/** Per-room render/sim bundle. Built on 'joined', disposed wholesale on leave. */
interface World {
  rig: SceneRig;
  predictor: Predictor;
  interp: InterpBuffer;
  models: PlayerModels;
  viewmodel: ViewModel;
  effects: Effects;
  solids: AABB[]; // map collision — decal wall raycasts on 'shot' events
  mats: MatId[]; // per-solid material (same order as solids) — impact classification
  floorMat: MatId; // ground-plane material — ground impacts + footstep dust tint
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
  private buySig = ''; // money|weapons|canBuy|armor|helmet signature of the open buy menu
  private pendingGear: GearId | null = null; // last buy_gear sent — buy_result carries no item id
  private consoleOpen = false; // `~` dev console overlay visible; pointer unlocked
  private stepAccM = 0; // own footstep distance accumulator
  private lastBodyX = 0;
  private lastBodyZ = 0;
  private respawnSec = -1; // cached countdown second for the warmup-death label
  private respawnLabel = '';
  private lastWeapon: WeaponId | null = null; // last weapon pushed into the viewmodel
  private prevHeld: WeaponId | null = null; // Q quick-switch target (held before lastWeapon)
  private warmupBannerShown = false; // WARMUP banner fires once per warmup entry
  private botPromptShown = false; // solo bot prompt fires once per join
  private botPromptVisible = false;
  private botPromptTimer: ReturnType<typeof setTimeout> | null = null;
  private lastGuardErrMs = Number.NEGATIVE_INFINITY; // guard() error-log rate limit
  // set true only for the in-flight join started by tryAutoRejoin(); read once
  // by the 'error' handler to tell "the stored room is gone" (clear the
  // session so the next reconnect stops retrying a grave) apart from any
  // other join-time rejection (bad manual code, full room, etc.), which must
  // leave a possibly-unrelated stored session untouched
  private rejoinInFlight = false;
  // Warmup START control, mirrored verbatim from the latest snapshot. canStart
  // is the SERVER's verdict on `{t:'start'}` — never recomputed here; seated /
  // minPlayers are displayed so the player can read WHY it is not ready yet.
  private snapSeated = 0;
  private snapMinPlayers = MIN_PLAYERS_FOR_MATCH;
  private snapCanStart = false;
  // e2e debug overrides (window.__fps.debug via C11); win over held keys when set
  private dbgMove: { x: number; z: number } | null = null;
  private dbgButtons = 0;

  private roomListResolve: ((rooms: RoomInfo[]) => void) | null = null;
  private roomListTimer: ReturnType<typeof setTimeout> | null = null;

  // reused per-frame scratch — zero allocation in the rAF hot path
  private readonly camPos: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly fxPoint: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly decalDir: Vec3 = { x: 0, y: 0, z: 0 }; // shot-event wall raycast
  private readonly smokePos: Vec3 = { x: 0, y: 0, z: 0 }; // shot-event muzzle smoke spawn
  private readonly sfxDir: Vec3 = { x: 0, y: 0, z: 0 }; // sfx occlusion raycast direction
  private readonly hudState: HudState = {
    hp: 100, armor: 0, alive: true, money: 0, canBuy: false,
    weapon: 'pistol', weaponName: '', mag: -1, reserve: -1,
    phase: 'warmup', phaseEndsInSec: 0, round: 0, scoreT: 0, scoreCT: 0,
    spreadPx: 0, scoped: false, spectating: null,
    team: null, you: '', players: [],
    seated: 0, minPlayers: MIN_PLAYERS_FOR_MATCH, canStart: false,
    streakTeam: null, streakCount: 0,
  };
  /**
   * Round-win run, folded from the `round_end` stream (C6's sibling — derived
   * client-side, nothing on the wire). The server's private `lossStreak` pair
   * is NOT this quantity: a draw increments BOTH of its counters, so the
   * opponent's loss streak overstates a win streak the moment one draw lands.
   * `nextWinStreak` handles the draw explicitly by breaking both runs.
   */
  private winStreak: WinStreak = NO_STREAK;
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
    // the warmup lobby's START button is the only interactive HUD node; it hands
    // the intent back here and C10 owns the socket (and the canStart gate)
    this.hud.onStart = () => this.startMatch();
    // C10/C11 seam: main.ts dispatches ONE 'fps:gesture' on the first real
    // pointerdown/keydown; resume() is idempotent (C7)
    window.addEventListener('fps:gesture', this.onFirstGesture);
    // B/Esc close an open buy menu while the pointer is unlocked (InputController
    // only sees keys while locked, so it never delivers these)
    window.addEventListener('keydown', this.onKeyDown);
    // the GPU context can die mid-session (driver reset, VRAM pressure) —
    // surface it through the standard menu error path, not a frozen canvas
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    // AUTO-REJOIN (CONTRACT_IDENTITY.md §3): main.ts's boot() ALWAYS ends with
    // a synchronous menus.showMain() right after constructing us — deferring
    // to a microtask lets that finish first, so a stored session's overlay
    // lands on top of it instead of being clobbered by it. No stored session
    // -> tryAutoRejoin() is a no-op and the main menu stands untouched.
    queueMicrotask(() => this.tryAutoRejoin());
  }

  // ---- public API (frozen; called by C11 main.ts) -----------------------------

  joinQuick(name: string): void {
    this.startJoin((c) => c.send(withIdentity({ t: 'quick_join', name, game: 'fps-sdk' })));
  }

  createPublic(name: string, mapId: MapId): void {
    // platform lobby envelope: mapId rides inside opaque settings (see
    // connection.ts LobbyCreate); the module validates it in createRoom
    this.startJoin((c) => c.send(withIdentity({ t: 'create_public', name, game: 'fps-sdk', settings: { mapId } })));
  }

  createPrivate(name: string, mapId: MapId): void {
    this.startJoin((c) => c.send(withIdentity({ t: 'create_private', name, game: 'fps-sdk', settings: { mapId } })));
  }

  joinPrivate(name: string, code: string): void {
    this.startJoin((c) => c.send(withIdentity({ t: 'join_private', name, code })));
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
    // the ONLY clearSession call site: an explicit leave/back-to-menu means
    // the player chose to abandon the room, so there is nothing left to
    // auto-rejoin. A socket drop must NEVER reach this — that is exactly the
    // case the stored session exists to recover from (see handleClose).
    clearSession(GAME);
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
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
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

  /**
   * Menu onBuyGear + console 'buy kevlar|helmet': send the gear buy request;
   * server validates (same canBuy window as weapons). buy_result reports no
   * item id (weapon is null for gear), so remember it for the optimistic
   * money/armor mirror that re-renders the open buy menu.
   */
  buyGear(item: GearId): void {
    this.pendingGear = item;
    this.conn?.send({ t: 'buy_gear', item });
  }

  /** Menu onAddBot: ask the server to add a bot to the current room. */
  addBot(): void {
    if (this.world === null) return; // in-room only
    this.conn?.send({ t: 'add_bot' });
  }

  /** Menu onRemoveBot: remove the most recently added bot. */
  removeBot(): void {
    if (this.world === null) return; // in-room only
    this.conn?.send({ t: 'remove_bot' });
  }

  /**
   * Menu onRemoveAllBots + console 'removebot all': kick every bot. Sends one
   * remove_bot per live bot (the server kicks most-recent-first); the roster
   * — and with it botCount() — only shrinks as the server confirms each kick.
   * Returns how many kicks were sent.
   */
  removeAllBots(): number {
    if (this.world === null) return 0; // in-room only
    const n = this.botCount();
    for (let i = 0; i < n; i++) this.removeBot();
    return n;
  }

  /** Menu onSwitchTeam + e2e debug: request a team change; server guards balance. */
  switchTeam(team: Team): void {
    if (this.world === null) return; // in-room only
    this.conn?.send({ t: 'switch_team', team });
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
  debugSetButton(btn: 'fire' | 'jump' | 'crouch' | 'alt' | 'walk', down: boolean): void {
    const bit =
      btn === 'fire'
        ? INPUT_FIRE
        : btn === 'jump'
          ? INPUT_JUMP
          : btn === 'crouch'
            ? INPUT_CROUCH
            : btn === 'walk'
              ? INPUT_WALK
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

  /** E2E-only mirror of the Tab edge (window.__fps.debug.scoreboard). */
  scoreboard(down: boolean): void {
    if (down) {
      const s = this.state;
      const roster = this.rosterArray();
      // roster money only refreshes on joins/halftime — patch ours live
      const me = s.youId !== null ? s.roster.get(s.youId) : undefined;
      if (me !== undefined && s.latestYou !== null) me.money = s.latestYou.money;
      // syncOut carries this round's alive/dead (RosterEntry does not)
      this.menus.showScoreboard(roster, s.youId ?? '', s.scoreT, s.scoreCT, this.syncOut);
    } else {
      this.menus.hideScoreboard();
    }
  }

  /**
   * Dev console Enter handler + e2e hook (__fps.debug.console): parse and run
   * one command line; returns the result line the overlay echoes under `> cmd`.
   * Commands are frozen in CONTRACT.md "Developer console" — case-insensitive,
   * optional '/' prefix; unknown commands / bad args get a helpful error.
   */
  consoleExec(text: string): string {
    const parts = text.trim().replace(/^\/+/, '').split(/\s+/).filter((p) => p !== '');
    const cmd = (parts[0] ?? '').toLowerCase();
    const arg = parts[1];
    switch (cmd) {
      case '':
        return "type 'help' for commands";
      case 'help':
        return 'help · addbot [n] / bot_add [n] · removebot [all] / bot_kick [all] · jointeam t|ct · buy <weapon|kevlar|helmet> · killbots · kill';
      case 'addbot':
      case 'bot_add': {
        if (this.world === null) return 'not in a room';
        let n = 1;
        if (arg !== undefined) {
          n = Number(arg);
          if (!Number.isInteger(n) || n < 1) return `bad bot count '${arg}' — usage: addbot [n]`;
        }
        for (let i = 0; i < n; i++) this.addBot();
        return 'ok';
      }
      case 'removebot':
      case 'bot_kick': {
        if (this.world === null) return 'not in a room';
        if (arg !== undefined) {
          if (arg.toLowerCase() !== 'all') return `bad argument '${arg}' — usage: removebot [all]`;
          return `removed ${this.removeAllBots()} bots`;
        }
        this.removeBot();
        return 'ok';
      }
      case 'jointeam': {
        if (this.world === null) return 'not in a room';
        const team = arg?.toLowerCase();
        if (team !== 't' && team !== 'ct') return 'usage: jointeam t|ct';
        this.switchTeam(team === 'ct' ? 'CT' : 'T');
        return 'ok';
      }
      case 'buy': {
        if (this.world === null) return 'not in a room';
        if (arg === undefined) return `usage: buy <${WEAPON_ORDER.join('|')}|kevlar|helmet>`;
        const id = arg.toLowerCase();
        // gear before the weapon check: kevlar/helmet are GearIds, not WeaponIds
        if (id === 'kevlar' || id === 'helmet') {
          this.buyGear(id);
          return 'ok';
        }
        if (!isWeaponId(id)) return `unknown weapon '${arg}' — ${WEAPON_ORDER.join(' ')} kevlar helmet`;
        this.buy(id);
        return 'ok';
      }
      case 'killbots': {
        if (this.world === null) return 'not in a room';
        this.conn?.send({ t: 'kill_bots' }); // server: every bot dies in place, stays in the room
        return 'ok';
      }
      case 'kill': {
        if (this.world === null) return 'not in a room';
        this.conn?.send({ t: 'suicide' }); // server: death with killerId null
        return 'ok';
      }
      default:
        return `unknown command '${cmd}' — type 'help'`;
    }
  }

  // ---- join / connection plumbing ----------------------------------------------

  /**
   * `subtitle` distinguishes a fresh join (default "Reserving a slot…") from
   * an AUTO-REJOIN after boot/a drop ("Reconnecting…", see tryAutoRejoin) —
   * same overlay, same flow, the player just needs to know which one it is.
   */
  private startJoin(
    sendJoin: (conn: Connection) => void,
    subtitle?: string,
    isRejoin = false,
  ): void {
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
    // every call re-stamps this (never left stale from a previous join): the
    // 'error' handler below reads it exactly once, right after this join's
    // own rejection, so there is no window for a later unrelated join to
    // inherit a stale true
    this.rejoinInFlight = isRejoin;
    const token = ++this.joinToken;
    this.menus.showJoining(subtitle);
    this.ensureConn()
      .then((conn) => sendJoin(conn))
      .catch(() => {
        if (this.joinToken !== token) return; // superseded by a newer join
        this.joining = false;
        this.menus.showMain('Could not reach the server');
      });
  }

  /**
   * AUTO-REJOIN — the whole point of CONTRACT_IDENTITY.md: with a stored
   * session on file, re-enter THAT room with zero clicks (boot, and again
   * after every socket drop via handleClose). `code` wins when present
   * (private rooms are keyed by it); else `roomId` targets the exact public
   * room via `join_public` (Connection now accepts platform's `LobbyC2S`,
   * see connection.ts send() — this is precisely the shape that was
   * unreachable before); only a session with neither falls back to
   * quick_join, which is matchmaking and can land in a DIFFERENT room —
   * acceptable only when there is no specific room left to ask for.
   * `isRejoin: true` marks this join so the 'error' handler can tell a dead
   * stored room apart from any other join-time rejection (see handleMessage
   * 'error' + rejoinInFlight).
   */
  private tryAutoRejoin(): void {
    if (this.disposed || this.world !== null || this.joining) return; // already somewhere
    const session = loadSession(GAME);
    if (session === null) return; // nothing to resume — the main menu stands as-is
    const name = cleanName(loadName());
    const code = session.code;
    const roomId = session.roomId;
    if (code !== null) {
      this.startJoin(
        (c) => c.send(withIdentity({ t: 'join_private', name, code })),
        'Reconnecting…',
        true,
      );
    } else if (roomId !== null) {
      this.startJoin(
        (c) => c.send(withIdentity({ t: 'join_public', name, game: 'fps-sdk', roomId })),
        'Reconnecting…',
        true,
      );
    } else {
      this.startJoin((c) => c.send(withIdentity({ t: 'quick_join', name, game: 'fps-sdk' })), 'Reconnecting…', true);
    }
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
      this.reconnectOrShowMain();
    } else if (this.joining) {
      this.joining = false;
      this.reconnectOrShowMain();
    }
  }

  /**
   * A drop is exactly the case the stored session exists to recover from —
   * see tryAutoRejoin's doc and clearSession's ONE call site in leave(). With
   * a session on file, go straight back into the same room instead of
   * bouncing the player to the main menu; only fall back to the old
   * "Connection lost" banner when there is truly nothing to resume.
   */
  private reconnectOrShowMain(): void {
    if (loadSession(GAME) !== null) {
      this.tryAutoRejoin();
    } else {
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
      solids: built.solids,
      mats: map.boxes.map((b) => b.mat), // aligned with built.solids (boxToAABB per BoxDef)
      floorMat: map.floorMat,
      mapName: map.name,
    };
    this.input.start();
  }

  private teardownWorld(): void {
    const w = this.world;
    if (w === null) return;
    this.world = null; // null first: input.stop()'s lock-loss must not pop the pause menu
    this.closeConsole(); // the console overlay must not outlive the room (relock no-ops here)
    this.input.stop();
    this.audio.stopAmbient(); // the looping bed must not outlive the room
    this.hideBotPrompt(); // the solo prompt must not outlive the room either
    w.models.clear(); // nameplate canvases/materials are per-instance
    w.effects.dispose(); // tracer/particle materials are per-instance clones
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
    this.lastWeapon = null;
    this.prevHeld = null;
    this.pendingGear = null;
    this.warmupBannerShown = false;
    this.botPromptShown = false;
    this.snapSeated = 0;
    this.snapMinPlayers = MIN_PLAYERS_FOR_MATCH;
    this.snapCanStart = false;
    this.dbgMove = null;
    this.dbgButtons = 0;
    this.winStreak = NO_STREAK;
    this.hud.matchEnd(null); // a rejoin must never flash the last match's board
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
          // 'no_room' is the platform lobby's ONLY signal for "that room does
          // not exist" (platform/server/src/lobby.ts joinPublic/joinPrivate —
          // reaped public room, or a private code nobody holds any more).
          // When it rejects the join tryAutoRejoin() itself started, the
          // stored pointer is provably dead: forget it, or every future
          // reconnect (boot, or the next drop) retries the same grave
          // forever. Any OTHER join-time rejection (room_full, a manually
          // mistyped code, rooms_full) must NOT touch the session — it says
          // nothing about whether the stored room still exists.
          if (msg.code === 'no_room' && this.rejoinInFlight) clearSession(GAME);
          this.rejoinInFlight = false;
          this.menus.showMain(msg.message);
        } else if (this.world !== null) {
          // in-room rejections (team_full on a denied switch, etc.): the
          // existing HUD banner is the visible in-room error surface (it
          // renders under an open menu's dim, but stays queued/visible in
          // play and after the menu closes)
          this.hud.banner(msg.message, '');
        }
        break;
      case 'pong':
        break; // consumed inside Connection — never forwarded in practice
    }
  }

  private onJoined(msg: Extract<S2C, { t: 'joined' }>): void {
    this.joining = false;
    // the ROOM POINTER, for auto-rejoin: `msg.you` becomes the resume token
    // for the NEXT drop (this is the "roll the current id into the stored
    // record" step — playerId is fresh per socket, so this write is what
    // keeps the resume chain valid across repeated reconnects).
    saveSession(GAME, { playerId: msg.you, roomId: msg.roomId, code: msg.code });
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
    this.botPromptShown = false; // one solo bot prompt per join
    // clock: trust the min-RTT pong sample once it exists, else seed from joined
    const conn = this.conn;
    s.serverOffset =
      conn !== null && conn.pingMs() > 0
        ? conn.serverOffsetMs()
        : msg.serverTime - performance.now();

    try {
      this.buildWorld(msg.mapId);
    } catch {
      // WebGL unavailable — SceneRig posted an opaque error div over the whole
      // viewport; clear it or it blocks the menu we're falling back to
      SceneRig.clearContextError();
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
    this.audio.ambient(msg.mapId); // per-map beds (desert wind / office AC / bunker hum / frost whistle)
    this.maybeShowBotPrompt();
  }

  private onSnapshot(msg: Extract<S2C, { t: 'snapshot' }>): void {
    const w = this.world;
    if (w === null) return; // snapshot for a room we already left
    const s = this.state;
    const conn = this.conn;
    if (conn !== null && conn.pingMs() > 0) s.serverOffset = conn.serverOffsetMs();

    const prevPhase = s.phase;
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
          // freeze start / any >2m snap is a server teleport (round spawn) —
          // in-flight inputs are meaningless across it: re-base, don't replay
          const b = w.predictor.body();
          const teleported = Math.hypot(p.x - b.x, p.y - b.y, p.z - b.z) > 2;
          if ((prevPhase !== 'freeze' && msg.phase === 'freeze') || teleported) {
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
        }
        break;
      }
    }

    s.phase = msg.phase;
    s.phaseEndsAt = msg.phaseEndsAt;
    s.latestYou = you;

    // START control inputs. Additive optional fields: a server that predates
    // them leaves the button disabled with an honest seat count rather than
    // offering a start that would be silently dropped.
    this.snapSeated = msg.seated ?? msg.players.length;
    this.snapMinPlayers = msg.minPlayers ?? MIN_PLAYERS_FOR_MATCH;
    this.snapCanStart = msg.canStart ?? false;

    // a (re-)entry into warmup is a new match — stale scores must not survive it
    if (msg.phase === 'warmup' && (prevPhase !== 'warmup' || s.round !== 0)) {
      s.round = 0;
      s.scoreT = 0;
      s.scoreCT = 0;
      this.winStreak = NO_STREAK; // a new match starts with nobody on a run
    }
    // UX_BIBLE: name the pre-match phase, once per warmup entry
    if (msg.phase === 'warmup') {
      if (!this.warmupBannerShown && s.round === 0) {
        this.warmupBannerShown = true;
        // nothing auto-starts: name the phase AND the action that ends it
        this.hud.banner('WARMUP', 'PRESS START (ENTER) WHEN THE ROOM IS READY');
      }
    } else {
      this.warmupBannerShown = false;
    }
    // solo bot prompt: any phase change out of warmup dismisses it
    if (msg.phase !== 'warmup') this.hideBotPrompt();
    this.maybeShowBotPrompt();
    // the server changes the held weapon silently (death->pistol, buy replace,
    // match reset, spawn) where the slot edge never fires; same-id is a no-op
    if (you.weapon !== this.lastWeapon) {
      this.prevHeld = this.lastWeapon; // Q target: the weapon held before this one
      this.lastWeapon = you.weapon;
      w.viewmodel.setWeapon(you.weapon);
    }

    // match end screen is dismissed by the return to warmup
    if (prevPhase === 'matchEnd' && msg.phase === 'warmup') {
      this.hud.matchEnd(null);
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
        // shot direction (shared by the muzzle smoke drift + the wall raycast)
        const d = this.decalDir;
        d.x = ev.to.x - ev.from.x;
        d.y = ev.to.y - ev.from.y;
        d.z = ev.to.z - ev.from.z;
        const shotLen = Math.hypot(d.x, d.y, d.z);
        if (shotLen > 1e-6) {
          d.x /= shotLen;
          d.y /= shotLen;
          d.z /= shotLen;
        }
        // muzzle smoke after every shot (own + remote): puffs just past the
        // muzzle — ~0.55m ahead of the eye, dropped to gun-tip height
        const mp = this.smokePos;
        mp.x = ev.from.x + d.x * 0.55;
        mp.y = ev.from.y + d.y * 0.55 - 0.14;
        mp.z = ev.from.z + d.z * 0.55;
        w.effects.muzzleSmoke(mp, d);
        // wall raycast: `to` is a player hit point or the wall endpoint. The
        // nearest solid at <= |to-from| + eps owns the wall decal AND the
        // material-classified impact (sand dust / metal sparks / snow puffs);
        // decals stay wall-only — no floating splats on flesh hits
        let wallT = -1;
        let wallIdx = -1;
        if (shotLen > 1e-6) {
          for (let i = 0; i < w.solids.length; i++) {
            const solid = w.solids[i];
            if (solid === undefined) continue;
            const t = raycastAABB(ev.from, d, solid, shotLen + 0.05);
            if (t >= 0 && (wallT < 0 || t < wallT)) {
              wallT = t;
              wallIdx = i;
            }
          }
        }
        if (wallT >= 0) {
          const p = this.fxPoint;
          p.x = ev.from.x + d.x * wallT;
          p.y = ev.from.y + d.y * wallT;
          p.z = ev.from.z + d.z * wallT;
          w.effects.impact(p, w.mats[wallIdx]);
          w.effects.decal(p);
        } else {
          // air/flesh end, or a ground hit (y≈0 takes the floor material)
          w.effects.impact(ev.to, ev.to.y <= 0.06 ? w.floorMat : undefined);
        }
        this.audio.sfx(SHOT_SFX[ev.weapon], this.spatialOpts(w, ev.from));
        // self: viewmodel/shake/bloom already fired on the local input edge —
        // re-firing here would double the kick a full RTT + tick late
        if (ev.shooterId !== s.youId) w.models.muzzle(ev.shooterId);
        break;
      }
      case 'kill': {
        const killer = ev.killerId !== null ? s.roster.get(ev.killerId) : undefined;
        const victim = s.roster.get(ev.victimId);
        // server only re-sends the roster on joins/halftime — K/D tracked locally
        if (killer !== undefined) killer.kills += 1;
        if (victim !== undefined) victim.deaths += 1;
        this.hud.killfeed(
          killer?.name ?? null,
          victim?.name ?? ev.victimId,
          ev.weapon,
          ev.headshot,
          killer?.team ?? null,
          victim?.team ?? null,
        );
        // OUR death: the one moment the player most needs information and
        // previously got none. killerId is already on the wire (C4) — no server
        // or protocol change is needed to answer "who killed me?".
        if (ev.victimId === s.youId) {
          // A killer that is null (world damage, console `kill`) OR that is us
          // (self-inflicted) is not a killer: C4 requires the neutral form, so
          // the name is passed as null rather than as an id or "undefined".
          const kid = ev.killerId;
          const selfInflicted = kid === null || kid === ev.victimId;
          const card: DeathCardInfo = {
            // roster miss on a REAL killer falls back to the id, mirroring the
            // killfeed's `victim?.name ?? ev.victimId` — losing the name is not
            // a reason to also lose the fact that somebody killed you
            killerName: selfInflicted ? null : (killer?.name ?? kid),
            killerTeam: selfInflicted ? null : (killer?.team ?? null),
            weapon: ev.weapon,
            headshot: ev.headshot,
          };
          this.hud.deathCard(card);
        }
        const pos = this.victimPoint(ev.victimId);
        const w = this.world;
        // first person: no burst at our own feet — the particles would fill
        // the lens on the death frame (the corpse cam never sees a model)
        if (pos !== null && w !== null && ev.victimId !== s.youId) {
          w.effects.death(pos, victim?.team ?? 'T');
          w.effects.blood(pos);
          this.audio.sfx('death', this.spatialOpts(w, pos));
        } else {
          this.audio.sfx('death');
        }
        break;
      }
      case 'multikill': {
        const name = s.roster.get(ev.playerId)?.name ?? ev.playerId;
        const label = ev.count >= 5 ? 'ACE' : MULTIKILL_LABELS[ev.count] ?? 'MULTI KILL';
        this.hud.banner(`${label} — ${name}`, '');
        this.audio.sfx('multikill');
        break;
      }
      case 'hit': {
        // our shot connected: hitmarker (+dmg number) + sound + blood + a tracer
        this.hud.hitmarker(ev.headshot, ev.killed, ev.dmg);
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
        // first person: no own blood — directional red edge flash + shake.
        // `ev.dmg` used to be dropped here, which made a 12-damage graze and an
        // 89-damage near-kill pixel-identical. One severity drives both halves
        // of the response so the flash and the shake always agree.
        const sev = damageSeverity01(ev.dmg);
        this.hud.damageFrom(wrapPi(ev.yaw - this.input.yaw), ev.dmg);
        this.world?.rig.shake(shakeTraumaForDamage(sev));
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
        // The round-win run is derived HERE, from this event stream and nothing
        // else. A draw (winner === null) breaks both sides' runs — see
        // nextWinStreak, and the warning beside `round_end` in types.ts about
        // the server's lossStreak pair, which is a different quantity.
        this.winStreak = nextWinStreak(this.winStreak, ev.winner);
        const run = this.winStreak;
        this.hud.banner(
          ev.winner === null ? 'ROUND DRAW' : `${ev.winner} WINS THE ROUND`,
          run.count >= STREAK_MIN
            ? `T ${ev.scoreT} : ${ev.scoreCT} CT  •  ${run.team} ${run.count} IN A ROW`
            : `T ${ev.scoreT} : ${ev.scoreCT} CT`,
        );
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
        // The end screen is the HUD's now, not the menus' — C5's stats array
        // carries every player on both teams and the old menus panel could only
        // show a top-3-by-kills list built from the roster. `ev.stats` is
        // passed straight through in the order the server sent it.
        this.menus.hideScoreboard(); // a held Tab must not cover the board
        this.hud.matchEnd({
          winner: ev.winner,
          scoreT: ev.scoreT,
          scoreCT: ev.scoreCT,
          you: s.team,
          youId: s.youId ?? '',
          stats: ev.stats,
        });
        this.audio.sfx(ev.winner === s.team ? 'win' : 'lose');
        break;
      }
      case 'halftime': {
        // sides swapped: REPLACE the roster (and with it our own team)
        s.roster.clear();
        for (const r of ev.roster) s.roster.set(r.id, r);
        const me = s.youId !== null ? s.roster.get(s.youId) : undefined;
        if (me !== undefined) s.team = me.team;
        // The server swaps the SCORES with the sides so they follow the players
        // (game.ts advanceAfterRound). The run has to make the same trip or it
        // would credit the wrong half of the room for the rest of the match.
        this.winStreak = swapStreakSides(this.winStreak);
        this.hud.banner('HALFTIME', 'SIDES SWAPPED');
        break;
      }
      case 'player_joined':
        s.roster.set(ev.entry.id, ev.entry);
        if (s.roster.size > 1) this.hideBotPrompt(); // no longer solo
        break;
      case 'player_left':
        s.roster.delete(ev.id);
        this.syncPool.delete(ev.id);
        this.others.delete(ev.id);
        this.maybeShowBotPrompt(); // solo again — no-op once shown this join
        break;
      case 'team_changed': {
        // roster carries team (nameplates/scoreboard/sync merge all read it);
        // when it's us, state.team drives the pause menu's current-team disable
        const entry = s.roster.get(ev.id);
        if (entry !== undefined) entry.team = ev.team;
        if (ev.id === s.youId) s.team = ev.team;
        break;
      }
      case 'buy_result': {
        if (ev.ok) {
          this.audio.sfx('buy');
          const you = s.latestYou;
          if (ev.weapon !== null && you !== null) {
            // optimistic mirror of tryBuy (primary replaced); next snapshot confirms
            you.money = Math.max(0, you.money - WEAPONS[ev.weapon].price);
            you.weapons = you.weapons.filter((id) => !PRIMARIES.includes(id));
            you.weapons.push(ev.weapon);
          } else if (you !== null && this.pendingGear !== null) {
            // gear buy (weapon null carries no item id — buyGear remembered it):
            // mirror money + armor so the open buy menu re-renders immediately
            if (this.pendingGear === 'kevlar') {
              you.money = Math.max(0, you.money - GEAR.kevlarPrice);
              you.armor = GEAR.armorStart;
            } else {
              you.money = Math.max(0, you.money - GEAR.helmetPrice);
              you.helmet = true;
            }
          }
          if (this.buyOpen && you !== null) this.refreshBuy(you);
        } else {
          this.audio.sfx('deny');
        }
        this.pendingGear = null;
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

    // the menus console input swallows Esc (stopPropagation) and hides itself —
    // reconcile our flags + relock once a frame when that happens
    if (this.consoleOpen && !this.menus.consoleVisible()) this.closeConsole();
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
      const prevButtons = this.lastButtons;
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
      // immediate local fire feedback — the server 'shot' echo trails by an
      // RTT + tick; mag is -1 for melee (always fires), 0 = empty. The self
      // echo skips viewmodel/shake/bloom (see onEvent 'shot').
      if (
        alive &&
        you !== null &&
        you.mag !== 0 &&
        (buttons & INPUT_FIRE) !== 0 &&
        (prevButtons & INPUT_FIRE) === 0
      ) {
        w.viewmodel.fire();
        // ceilinged: emptying a mag must not pin the camera at full amplitude
        w.rig.shake(SHAKE_FIRE_ADD, SHAKE_FIRE_CEIL);
        const fireDef = WEAPONS[you.weapon];
        this.bloomDeg = Math.min(
          this.bloomDeg + fireDef.spreadPerShot,
          Math.max(0, fireDef.maxSpreadDeg - fireDef.spreadDeg),
        );
      }
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
    let spectId: PlayerId | null = null;
    if (!alive && you !== null && you.spectateTarget !== null) {
      for (const p of this.syncOut) {
        if (p.id !== you.spectateTarget) continue;
        c.x = p.x;
        c.y = p.y + (p.crouch ? PLAYER.heightCrouch : PLAYER.heightStand) - PLAYER.eyeOffset;
        c.z = p.z;
        w.rig.applyCamera(c, p.yaw, p.pitch, BASE_FOV);
        spectName = s.roster.get(p.id)?.name ?? p.id;
        spectId = p.id;
        break;
      }
    }
    const spectated = spectId !== null;
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
        // Shift walk is slow AND quiet: own steps at the frozen x0.4 volume
        const walking = (this.lastButtons & INPUT_WALK) !== 0;
        const stepOpts: { vol: number; dist: number; bearing: number; occluded: boolean } = {
          vol: walking ? WALK_STEP_VOL : 1,
          dist: 0,
          bearing: 0,
          occluded: false,
        };
        this.audio.sfx('footstep', stepOpts);
        // sprinting kicks visible dust off the floor (tinted by the floor mat)
        if (!walking && hSpeed > SPRINT_MIN_SPEED) {
          const f = this.fxPoint;
          f.x = body.x;
          f.y = body.y;
          f.z = body.z;
          w.effects.footDust(f, w.floorMat);
        }
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
        const stepDist = Math.min(Math.hypot(p.x - t.x, p.z - t.z), STEP_CLAMP_M);
        t.acc += stepDist;
        if (t.acc >= STEP_EVERY_M) {
          t.acc %= STEP_EVERY_M;
          this.audio.sfx('footstep', this.spatialOpts(w, p));
          // sprinting remotes kick dust too — speed from this frame's interp delta
          if (dt > 0 && stepDist / dt > SPRINT_MIN_SPEED) {
            const f = this.fxPoint;
            f.x = p.x;
            f.y = p.y;
            f.z = p.z;
            w.effects.footDust(f, w.floorMat);
          }
        }
      }
      t.x = p.x;
      t.y = p.y;
      t.z = p.z;
    }

    // ---- models / viewmodel / effects / hud ----
    // spectating parks the camera at the target's eye: hide the TARGET's model
    // (not our own corpse's), or we render the inside of its head as a black band
    w.models.sync(this.syncOut, spectId ?? s.youId ?? '', dt);
    // scoped hides the viewmodel; dead/spectating must too (no floating own gun)
    w.viewmodel.update(dt, alive && hSpeed > MOVE_MIN_SPEED, scopedNow || !alive);
    w.effects.update(dt);

    const h = this.hudState;
    h.hp = you?.hp ?? 100;
    h.armor = you?.armor ?? 0;
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
    // team identity + roster rail: syncOut is already the roster-merged snapshot
    // (name/team/alive per player), so the HUD reads it directly — no copy, no
    // allocation. The HUD hashes it and rebuilds only when it actually changes.
    h.team = s.team;
    h.you = s.youId ?? '';
    h.players = this.syncOut;
    // warmup START control: the server's own numbers and its own verdict
    h.seated = this.snapSeated;
    h.minPlayers = this.snapMinPlayers;
    h.canStart = this.snapCanStart;
    // stakes row: the run we folded from round_end (match point is derived
    // inside the HUD from scoreT/scoreCT + ROUNDS.winRounds)
    h.streakTeam = this.winStreak.team;
    h.streakCount = this.winStreak.count;
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
          walk: (this.lastButtons & INPUT_WALK) !== 0,
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

  /**
   * Spatial sfx options for a world-space source: distance, stereo bearing
   * (radians to the source relative to the camera yaw, + = left, matching the
   * damage-arc convention), and `occluded` — a wall raycast from the camera
   * to the source (the same solids table the shot impacts use). Returned as a
   * typed object (not a literal) so the audio owner's opts extension seam
   * (surface, and the bearing/occluded stereo work) stays forward-compatible.
   */
  private spatialOpts(
    w: World,
    p: Vec3,
  ): { dist: number; bearing: number; occluded: boolean } {
    const c = this.camPos;
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const dz = p.z - c.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-3) return { dist, bearing: 0, occluded: false };
    // world yaw of the source direction minus our look yaw -> stereo bearing
    const bearing = wrapPi(Math.atan2(-dx, -dz) - this.input.yaw);
    const d = this.sfxDir;
    d.x = dx / dist;
    d.y = dy / dist;
    d.z = dz / dist;
    // a solid strictly between camera and source occludes; shave the far end
    // so the wall the source stands against doesn't count
    const limit = Math.max(0, dist - 0.3);
    let occluded = false;
    for (const s of w.solids) {
      if (raycastAABB(c, d, s, limit) >= 0) {
        occluded = true;
        break;
      }
    }
    return { dist, bearing, occluded };
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
        case 'console': {
          if (this.consoleOpen) this.closeConsole();
          else this.openConsole();
          break;
        }
        case 'qswitch': {
          // Q: swap to the previously HELD weapon (frozen quick-switch) —
          // no-op until a second weapon was held, or when it is no longer owned
          const you = this.state.latestYou;
          const prev = this.prevHeld;
          if (
            w !== null &&
            you !== null &&
            prev !== null &&
            prev !== you.weapon &&
            you.weapons.includes(prev)
          ) {
            this.conn?.send({ t: 'switch', weapon: prev });
            // optimistic, same as the slot edge; the snapshot confirms
            w.viewmodel.setWeapon(prev);
            this.bloomDeg = 0;
          }
          break;
        }
        case 'scoreboard': {
          this.scoreboard(e.down);
          break;
        }
        case 'menu': {
          // Esc priority: an open buy menu eats it first ("B / Esc to close") —
          // only a second Esc, with no buy menu open, reaches the pause menu.
          if (this.buyOpen) {
            this.closeBuy();
          } else if (this.world !== null) {
            this.menus.showPause(this.botCount(), this.state.team);
            if (document.pointerLockElement !== null) document.exitPointerLock();
          } else {
            this.menus.showMain();
          }
          break;
        }
      }
    }
  }

  // ---- warmup START (lobby button + ENTER) -------------------------------------------
  //
  // No game on this platform auto-starts: warmup ends only when a seated player
  // asks for it. Two ways in, because pointer lock makes one of them impossible
  // at any given moment:
  //   * the lobby button — the ONLY pointer-events:auto node in the HUD layer.
  //     Reachable whenever the pointer is FREE (right after joining, after Esc,
  //     after the buy menu closes), which is most of a real warmup.
  //   * ENTER — reachable while the pointer is LOCKED, where no DOM node can be
  //     clicked at all. The key is printed on the button's cap so it is never a
  //     hidden binding. InputController ignores Enter (it falls through its
  //     switch untouched), so this window listener is its only consumer.
  //
  // Both funnel here, and here alone decides to send: `snapCanStart` is the
  // server's verdict, mirrored from the last snapshot and never recomputed.

  /** Send `{t:'start'}` if the server said right now would be accepted. */
  private startMatch(): void {
    if (this.world === null || !this.snapCanStart) return;
    this.conn?.send({ t: 'start' });
    // the click that got here IS a user gesture — take the pointer back so the
    // freeze phase starts with the player aiming, not staring at a cursor
    if (document.pointerLockElement === null && !this.buyOpen && !this.consoleOpen) this.relock();
  }

  /** ENTER may start the match only from live play — never from under a menu. */
  private startKeyArmed(): boolean {
    if (this.world === null || this.buyOpen || this.consoleOpen) return false;
    if (this.menus.modalOpen()) return false;
    // A focused TEXT FIELD owns Enter — never steal it. A focused BUTTON does
    // not disqualify the shortcut (clicking 'NO THANKS' on the bot prompt must
    // not silently disarm it), with one exception: when the START button itself
    // has focus the browser already turns Enter into a click on it, and firing
    // here as well would send the message twice.
    const tag = document.activeElement?.tagName ?? '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
    if (this.hud.startFocused()) return false;
    return this.snapCanStart;
  }

  /** Send reload + play the dip animation (shared by the R edge and e2e debug). */
  private doReload(): void {
    const you = this.state.latestYou;
    this.conn?.send({ t: 'reload' });
    const w = this.world;
    if (w !== null && you !== null) {
      const dur = WEAPONS[you.weapon].reload;
      if (dur > 0) {
        w.viewmodel.reload(dur); // knife has no reload animation
        this.audio.sfx('reload');
      }
    }
  }

  // ---- buy menu (pointer unlocks while open so the cards are clickable) -----------------

  private openBuy(you: YouSnap): void {
    if (!you.canBuy) return;
    this.buyOpen = true;
    this.buySig = `${you.money}|${you.weapons.join(',')}|${you.canBuy}|${you.armor}|${you.helmet}`;
    this.menus.showBuy(you.money, you.weapons, you.canBuy, {
      hasKevlar: you.armor > 0, // vest persists while armor points remain (re-buy refills)
      hasHelmet: you.helmet,
    });
    if (document.pointerLockElement !== null) document.exitPointerLock();
  }

  private closeBuy(): void {
    if (!this.buyOpen) return;
    this.buyOpen = false;
    this.buySig = '';
    this.menus.hideBuy();
    this.relock();
  }

  /** Re-show the open buy menu only when money/owned/canBuy/armor actually changed. */
  private refreshBuy(you: YouSnap): void {
    const sig = `${you.money}|${you.weapons.join(',')}|${you.canBuy}|${you.armor}|${you.helmet}`;
    if (sig === this.buySig) return;
    this.buySig = sig;
    this.menus.showBuy(you.money, you.weapons, you.canBuy, {
      hasKevlar: you.armor > 0,
      hasHelmet: you.helmet,
    });
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

  // ---- developer console (pointer unlocks while open so the input is typeable) ----

  private openConsole(): void {
    if (this.world === null || this.consoleOpen) return; // in-room only (input not started out of room)
    this.consoleOpen = true; // set BEFORE the unlock so onLockChange skips the pause menu
    this.input.consoleOpen = true; // InputController suppresses gameplay keys while open
    this.menus.showConsole((text) => this.consoleExec(text));
    if (document.pointerLockElement !== null) document.exitPointerLock();
  }

  private closeConsole(): void {
    if (!this.consoleOpen) return;
    this.consoleOpen = false;
    this.input.consoleOpen = false;
    this.menus.hideConsole();
    this.relock();
  }

  // ---- misc ------------------------------------------------------------------------------

  private rosterArray(): RosterEntry[] {
    return [...this.state.roster.values()];
  }

  /** Live bot count for the pause menu's REMOVE BOT disabled state. */
  private botCount(): number {
    let n = 0;
    for (const r of this.state.roster.values()) {
      if (r.bot) n++;
    }
    return n;
  }

  /**
   * Solo bot prompt: in a room, alone (roster = just you), in warmup — offer
   * bots once per join. Hidden by hideBotPrompt triggers (roster > 1, phase
   * leaving warmup, 20s timeout, leaving the room).
   */
  private maybeShowBotPrompt(): void {
    const s = this.state;
    if (this.world === null || this.botPromptShown || s.youId === null) return;
    if (s.phase !== 'warmup' || s.roster.size !== 1 || !s.roster.has(s.youId)) return;
    this.botPromptShown = true;
    this.botPromptVisible = true;
    this.menus.showBotPrompt(
      (n) => {
        for (let i = 0; i < n; i++) this.addBot();
      },
      () => {},
    );
    this.botPromptTimer = setTimeout(() => {
      this.botPromptTimer = null;
      this.hideBotPrompt();
    }, BOT_PROMPT_HIDE_MS);
  }

  /** Idempotent: safe to call from every roster/phase/lifecycle change. */
  private hideBotPrompt(): void {
    if (this.botPromptTimer !== null) {
      clearTimeout(this.botPromptTimer);
      this.botPromptTimer = null;
    }
    if (!this.botPromptVisible) return;
    this.botPromptVisible = false;
    this.menus.hideBotPrompt();
  }

  private onLockChange(locked: boolean): void {
    if (locked) return;
    // browsers swallow the Esc keydown on pointer-lock exit — this is the pause signal;
    // an intentional unlock for the buy menu or dev console must NOT pause
    if (this.world !== null && !this.buyOpen && !this.consoleOpen) {
      this.menus.showPause(this.botCount(), this.state.team);
    }
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.consoleOpen) {
      // the console overlay owns keystrokes while open. Esc closes it here:
      // InputController swallows Esc while consoleOpen (and Backquote it turns
      // into a 'console' edge, which toggles via handleEdges — do NOT also
      // close on Backquote here or the key would close-then-reopen)
      if (e.code === 'Escape') {
        e.preventDefault();
        this.closeConsole();
      }
      return;
    }
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      if (!e.repeat && this.startKeyArmed()) {
        e.preventDefault();
        this.startMatch();
      }
      return;
    }
    if (!this.buyOpen) return;
    if (e.code === 'KeyB' || e.code === 'Escape') {
      e.preventDefault();
      this.closeBuy();
    }
  };

  private readonly onFirstGesture = (): void => {
    this.audio.resume(); // idempotent — creates/unlocks the AudioContext (C7)
  };

  private readonly onContextLost = (): void => {
    // no preventDefault: we never attempt a webglcontextrestored recovery —
    // tear down and surface the standard menu error path (the main.ts banner
    // mechanism is window.onerror-only, unreachable without a real throw)
    if (this.world === null) return;
    this.conn?.close();
    this.conn = null;
    this.teardownWorld();
    this.resetState();
    this.hud.show(false);
    this.menus.showMain('Graphics context lost — reload the page');
  };

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      // robustness rule: one bad message/frame must never kill the rAF loop —
      // keep swallowing, but log (≤1 per 2s) so a persistent frameInner fault
      // is visible instead of silently dead
      const now = performance.now();
      if (now - this.lastGuardErrMs >= 2000) {
        this.lastGuardErrMs = now;
        console.error('[frame]', err);
      }
    }
  }
}
