// ============================================================================
// ANCIENTS (rift) — GAME (T8). The client app shell: connection lifecycle
// (wordbomb-style: rift.name + rift.resume in try/catch'd localStorage, ?code=
// invite prefill + history.replaceState, auto-resume after a socket drop,
// every create/join carries game:'rift', room list filtered to rift), the
// menu -> lobby -> live -> ended state machine, ClientState assembly +
// UiActions implementation, event routing to fx/audio (killfeed reads
// state.events), the camera, and the frozen window.__rift debug surface.
//
// This file imports ONLY contract.ts types from client territory — never a
// T7/T9 implementation module (CONTRACT §6). It is constructible purely
// through ClientModules; main.ts/wire.ts are orchestrator-owned.
//
// Wire hook: `game.onBegin` is called with each rift_begin — the orchestrator
// uses it to build the map meshes and swap in map-dependent handles (the
// frozen Game signature has no map channel, and lanes are unknown until the
// match locks).
// ============================================================================
import {
  BASE_INSET,
  isHeroId,
  isItemId,
  isPlayerTeam,
  heroById,
  ITEMS,
  MAP_SIDE_BASE,
  MAP_SIDE_PER_LANE,
  TICK_DT,
  ULT_LEVEL_REQ,
  WARD_PLACE_RANGE,
} from '@rift/shared';
import type { HeroId, RiftC2S, RiftEvent, RiftSettings, TeamId } from '@rift/shared';
import { cleanName, clearSession, loadName, loadSession, loadSig, saveName, saveSession } from '@platform/shared';
import type { LobbyC2S, RoomInfo } from '@platform/shared';
import type {
  BeginMsg,
  ClientModules,
  ClientState,
  EndEvent,
  HelloMsg,
  InterpHandle,
  LobbyMsg,
  SceneHandle,
  SnapMsg,
  UiActions,
} from './contract.js';
import { createNet, type NetHandle, type NetMsg } from './net.js';
import { createInterp } from './interp.js';
import { createInput, type InputHandle } from './input.js';

// ---- tuning ----------------------------------------------------------------------
const GAME = 'rift'; // this client's GameModule.id (@platform/shared session/identity key)
const EVENTS_MAX = 32; // state.events ring (killfeed/audio), newest last
const SNAPS_MAX = 32; // __rift.snaps() ring
const FOG_EVERY_MS = 200; // fog mask refresh ≈ 5Hz (CONTRACT §6)
/**
 * Wheel-zoom lower clamp, in metres (CONTRACT §6, STYLE_BIBLE §5).
 *
 * 11, not 18, and it is a measurement rather than a preference: at camH 18 a
 * hero occupies roughly 40 px of a 1080p frame, at which size the 45-70 part
 * hero silhouettes the mesh tasks build carry no legible headgear, cape or
 * weapon — every argument in STYLE_BIBLE §7 for hero detail is void unless the
 * camera can reach the detail. `CAM_MAX_H` and `CAM_DEFAULT_H` are unchanged,
 * so ordinary play framing does not move; only full zoom-in does.
 *
 * The camera cannot clip the ground at this height. render/scene.ts's rig puts
 * the eye at `heightAt(target) + camH` and pulls it back `camH / tan(55°)` =
 * 7.70 m along -z, so the worst case is the lowest possible target under the
 * highest possible ground — the same two numbers R_FOG measured its lid
 * against (fog.ts "WHY +6.0 AND NOT +7.5"):
 *     lowest ground  = -(RIVER_DIP 0.4 + UNDULATION_RIVER 0.06)   = -0.46 m
 *     lowest eye     = -0.46 + 11                                 = 10.54 m
 *     highest ground = ELEV_STEP 2.6 + UNDULATION_HIGH 0.18       =  2.78 m
 *     clearance      = 10.54 - 2.78                               =  7.76 m
 * against a 0.5 m near plane. R_FOG's occluding lid sits at 8.78 m in that
 * same case, 1.76 m under the eye, and that clearance was computed against
 * this exact 11 — moving this number invalidates it.
 */
const CAM_MIN_H = 11;
const CAM_MAX_H = 55;
const CAM_DEFAULT_H = 36;
const ROOMS_EVERY_MS = 3000; // menu room-list poll (wordbomb pattern)
const TOAST_MS = 1500; // cast-denied note lifetime (UX: transient, not a banner)

type Phase = ClientState['phase'];

/** ClientState is readonly to UI modules; the game mutates its single
 *  preallocated copy in place (no per-frame allocation). */
type MutableState = { -readonly [K in keyof ClientState]: ClientState[K] };

/** The frozen debug surface (CONTRACT §6) plus the additive fields T9/T14
 *  need — see RiftDebugApi below. */
export interface RiftDebugState {
  readonly phase: Phase;
  readonly connected: boolean;
  readonly you: string | null;
  readonly team: TeamId | null;
  readonly hero: HeroId | null;
  readonly gold: number | null;
  readonly tick: number | null;
  readonly ents: number;
  readonly positions: readonly { readonly id: number; readonly x: number; readonly z: number }[];
}

export interface RiftDebugApi {
  state(): RiftDebugState;
  createPrivate(name: string, settings?: RiftSettings): void;
  joinPrivate(name: string, code: string): void;
  start(): void;
  pick(hero: string): void;
  order(kind: 'move' | 'attackmove' | 'attack' | 'stop', x?: number, z?: number, target?: number): void;
  cast(slot: number, x?: number, z?: number, target?: number): void;
  buy(item: string): void;
  skill(slot: number): void;
  item(slot: number, x?: number, z?: number): void;
  snaps(): readonly SnapMsg[];
  lastEvents(): readonly RiftEvent[];
  messageLog(): readonly unknown[];
  // -- additive (not in the frozen list; required by T9 menus / T14 perf) ------
  rooms(): readonly RoomInfo[]; // T9's menu room list (ClientState has no channel)
  quickJoin(name: string): void;
  createPublic(name: string, settings?: RiftSettings): void;
  joinPublic(name: string, roomId: string): void;
  storedName(): string | null; // name-input prefill
  inviteCode(): string | null; // ?code= prefill (already stripped from the URL)
  serverNow(): number; // lobby countdown rendering (offset-corrected)
  drawCalls(): number; // T14 perf gate
  /** Triangles rasterised in the last frame — `renderer.info.render.triangles`,
   *  read through {@link WireProbes}. A FROZEN debug-surface name
   *  (AMENDMENT_1 §B.5); the capture harness reads it against the 1.2 M budget.
   *
   *  It ACCUMULATES THE SHADOW PASS by design: R_SCENE holds
   *  `info.autoReset = false` and resets once per frame, so the figure is the
   *  whole frame — scene pass, shadow map, AO, both bloom targets, grade,
   *  output and AA — not one pass (render/core.ts, AMENDMENT_3 §D). */
  triangles(): number;
  /** `true` only once the chunked terrain AND vegetation bakes have BOTH
   *  finished (`TerrainHandle.ready() && VegetationHandle.ready()`). A FROZEN
   *  debug-surface name (AMENDMENT_1 §B.5) and the harness's only signal that
   *  a shot will not photograph a half-built map.
   *
   *  It is `false` before `rift_begin` (neither module exists yet) and it stays
   *  `false` forever if either bake FAILS — both handles report not-ready on a
   *  failed build (AMENDMENT_3 §G.1) and wire.ts leaves a module that threw
   *  during construction unset. A failure therefore surfaces as a harness
   *  timeout with a named cause, never as a green light over a broken world. */
  worldReady(): boolean;
  /** Pin the day/night cycle at `t` (0 = full day, 1 = full night, clamped);
   *  `null` releases the pin and resumes snapshot-driven updates, re-applying
   *  the newest snapshot's phase immediately. Routed into BOTH sinks —
   *  `SceneHandle.setTimeOfDay` and `PostHandle.setTimeOfDay`.
   *
   *  The capture harness pins before every in-world shot: unpinned, the
   *  lighting depends on how long the match happened to have been running and
   *  no two judge rounds can be compared. */
  setDayPhase(t: number | null): void;
  /** Entities dropped from otherwise-valid snapshots since load (net.ts). A
   *  non-zero value means the wire carries something this client cannot parse
   *  — a protocol drift that is now survivable instead of frame-blanking, but
   *  still a defect. */
  droppedEnts(): number;
  /** World ground point under a screen pixel via the scene's real raycast —
   *  the camera-mapping probe the pan regression harness reads (at the canvas
   *  centre this IS the camera target). Null when the ray misses the map. */
  screenToGround(sx: number, sy: number): { x: number; z: number } | null;
}

declare global {
  interface Window {
    __rift?: RiftDebugApi;
  }
}

/**
 * The three things the Game needs that live in wire.ts's half of the world.
 *
 * `ClientModules` is frozen (contract.ts) and deliberately carries neither
 * `TerrainHandle`, `VegetationHandle` nor `PostHandle` — game.ts has no
 * business driving any of them. But the two frozen debug-surface members
 * `worldReady()` and `triangles()` (AMENDMENT_1 §B.5) read exactly those
 * handles, and `dayPhase` has a second sink on `PostHandle` that the scene
 * cannot forward to (GRAPHICS_CONTRACT §6 makes `setFramePass` the only
 * scene<->post link). So the orchestrator installs three narrow probes rather
 * than the handles themselves — the same additive mechanism as {@link
 * Game.onBegin}, and the constructor's `window.__rift` closures read the field
 * lazily, so installing it immediately after `new Game(...)` is soon enough.
 */
export interface WireProbes {
  /** `TerrainHandle.ready() && VegetationHandle.ready()`, and `false` while
   *  either module is unbuilt or failed. Must never report a false `true`. */
  worldReady(): boolean;
  /** `sceneCore(scene).renderer.info.render.triangles` at read time. */
  triangles(): number;
  /** `PostHandle.setTimeOfDay` — the second of the two day/night sinks. */
  postTimeOfDay(t: number): void;
}

/** Control over the baked structure instances (hide a dead one, restore all
 *  at a rematch), built by render/mapMesh.ts's `buildMapMeshes`. The Game may
 *  not import that module (CONTRACT §6) and the frozen Game signature has no
 *  map channel, so mapMesh installs the control on the `SceneHandle` itself
 *  and this side reads it through a cast — the same seam render/core.ts's
 *  `sceneCore` reads `.core` through. The type is re-declared here, never
 *  imported; mapMesh.ts's `MapStructureControl` is the authoring side. */
interface MapStructureControl {
  hideStructure(structureId: number): void;
  resetStructures(): void;
}

/** Null until the first rift_begin builds the map — and stays null on the
 *  late-joiner path where a live snap arrives with no rift_begin at all. */
function structureControlOf(scene: SceneHandle): MapStructureControl | null {
  const c = (scene as SceneHandle & { riftStructureControl?: MapStructureControl })
    .riftStructureControl;
  return c ?? null;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class Game {
  private readonly modules: ClientModules;
  private readonly net: NetHandle;
  private interp: InterpHandle = createInterp();
  private readonly input: InputHandle;

  // ---- connection / identity --------------------------------------------------
  private playerId: string | null = null; // this session's id (welcome)
  private resumeToken: string | null = null; // previous session's id (rejoin)
  private roomCode: string | null = null;
  private roomId: string | null = null;
  private wasDropped = false; // onClose fired: next welcome auto-resumes
  private pendingJoin: { name: string; code: string } | null = null;
  private invite: string | null = null;
  private rooms: readonly RoomInfo[] = [];

  // ---- match state --------------------------------------------------------------
  private helloView: HelloMsg | null = null;
  private lobby: LobbyMsg | null = null;
  private begin: BeginMsg | null = null;
  private snap: SnapMsg | null = null;
  private prevSnap: SnapMsg | null = null; // atk-transition + death-diff source for fx
  private end: EndEvent | null = null;
  private readonly events: RiftEvent[] = [];
  private readonly snapsRing: SnapMsg[] = [];
  private lastFogMs = -FOG_EVERY_MS;
  private selfEntId = -1;
  // Preallocated, mutated in place each update — the audio module's own
  // AudioWorldCtx/ListenerState fields are readonly to the callee only
  // (client/src/audio/contract.ts §"Everything the deriver needs" / §2).
  private readonly audioWorld = {
    selfPid: null as string | null,
    selfEntId: -1,
    selfTeam: null as TeamId | null,
    isVisible: (x: number, z: number): boolean => this.modules.fog.isVisible(x, z),
  };
  private readonly audioListener = { x: 0, z: 0, height: CAM_DEFAULT_H };
  private lastYouHp: number | null = null;
  private lastYouLevel = 0;
  private toast: { text: string; untilMs: number } | null = null; // cast-denied note
  /** Structure ids already hidden in the baked map (death = hp <= 0; dead
   *  structures never leave the snapshot, so without this set the fold in
   *  onSnap would re-hide them every tick). */
  private readonly deadStructures = new Set<number>();

  // ---- day/night --------------------------------------------------------------
  /** Capture pin from `__rift.setDayPhase`; null = follow the snapshot. */
  private dayPin: number | null = null;
  /** Last value published to the two sinks; -1 = nothing published yet. Both
   *  sinks are documented cheap-when-unchanged, and the scene's PMREM rebuild
   *  is gated on a real change — this just keeps the two calls off the hot
   *  path of every 20 Hz snapshot when the phase has not moved. */
  private dayPhaseSent = -1;

  // ---- camera ---------------------------------------------------------------------
  private camX = 0;
  private camZ = 0;
  private camH = CAM_DEFAULT_H;
  private centeredOnHero = false;

  private readonly state: MutableState = {
    phase: 'menu',
    connected: false,
    error: null,
    hello: null,
    lobby: null,
    begin: null,
    snap: null,
    interp: null,
    fog: null,
    end: null,
    events: [],
    shopOpen: false,
    scoreboardOpen: false,
    cameraX: 0,
    cameraZ: 0,
    cameraHeight: CAM_DEFAULT_H,
    toast: null,
  };
  private readonly actions: UiActions;
  private lastFrameMs = 0;

  /** Orchestrator hook (wire.ts): fired with each rift_begin so map-dependent
   *  handles can be built/swapped. Additive to the frozen constructor seam. */
  onBegin: ((begin: BeginMsg) => void) | null = null;

  /** Orchestrator probes (wire.ts), installed immediately after construction.
   *  Null only in the microtask between `new Game(...)` and that assignment,
   *  and in a unit test that constructs a Game without a wire — in which case
   *  the world is genuinely not ready and no post stack exists, which is what
   *  the fallbacks below report. See {@link WireProbes}. */
  probes: WireProbes | null = null;

  constructor(root: HTMLElement, modules: ClientModules) {
    this.modules = modules;
    this.state.events = this.events;

    this.actions = {
      send: (msg) => this.sendGame(msg),
      toggleShop: () => {
        if (this.state.phase !== 'live') return;
        this.state.shopOpen = !this.state.shopOpen;
        this.modules.audio.ui('click');
      },
      setScoreboard: (open) => {
        this.state.scoreboardOpen = open;
      },
      centerCamera: () => this.centerCamera(),
      panCameraTo: (x, z) => this.panCameraTo(x, z),
      leaveToMenu: () => this.leaveToMenu(),
    };

    this.net = createNet({
      onMessage: (msg) => this.onMessage(msg),
      onClose: () => this.onSocketClose(),
    });

    this.input = createInput(root, modules.scene, {
      send: (msg) => this.net.send(msg),
      isLive: () => this.state.phase === 'live',
      selfTeam: () => this.helloView?.team ?? null,
      entTeam: (id) => this.entTeam(id),
      ownHero: () => this.snap?.you?.hero ?? null,
      ownItems: () => this.snap?.you?.items ?? [],
      cameraHeight: () => this.camH,
      panBy: (dx, dz) => this.panCameraTo(this.camX + dx, this.camZ + dz),
      zoomBy: (factor) => {
        this.camH = clamp(this.camH * factor, CAM_MIN_H, CAM_MAX_H);
      },
      setScoreboard: (open) => {
        this.state.scoreboardOpen = open;
      },
      setSelected: (id) => modules.units.setSelected(id),
      orderMarker: (x, z, attack) => modules.units.orderMarker(x, z, attack),
      castBlockReason: (slot, aim) => this.castBlockReason(slot, aim),
      itemBlockReason: (slot, aim) => this.itemBlockReason(slot, aim),
      castDenied: (reason) => this.castDenied(reason),
    });

    // ---- frozen e2e debug surface (CONTRACT §6) -----------------------------------
    window.__rift = {
      state: () => this.debugState(),
      createPrivate: (name, settings) => this.createPrivate(name, settings),
      joinPrivate: (name, code) => this.joinPrivate(name, code),
      start: () => this.net.send({ t: 'rift_start' }),
      pick: (hero) => {
        if (isHeroId(hero)) this.net.send({ t: 'rift_pick', hero });
      },
      order: (kind, x, z, target) => this.debugOrder(kind, x, z, target),
      cast: (slot, x, z, target) => this.debugCast(slot, x, z, target),
      buy: (item) => {
        if (isItemId(item)) this.net.send({ t: 'rift_buy', item });
      },
      skill: (slot) => {
        if (Number.isInteger(slot) && slot >= 0 && slot < 4) this.net.send({ t: 'rift_skill', slot });
      },
      item: (slot, x, z) => this.debugItem(slot, x, z),
      snaps: () => this.snapsRing.slice(),
      lastEvents: () => this.events.slice(),
      messageLog: () => this.net.messageLog(),
      rooms: () => this.rooms.slice(),
      quickJoin: (name) => this.quickJoin(name),
      createPublic: (name, settings) => this.createPublic(name, settings),
      joinPublic: (name, roomId) => this.joinPublic(name, roomId),
      storedName: () => this.storedName(),
      inviteCode: () => this.invite,
      serverNow: () => this.net.serverNow(),
      drawCalls: () => this.modules.scene.drawCalls(),
      triangles: () => this.probes?.triangles() ?? 0,
      worldReady: () => this.probes?.worldReady() ?? false,
      setDayPhase: (t) => this.setDayPhase(t),
      droppedEnts: () => this.net.droppedEntities(),
      screenToGround: (sx, sy) => {
        const out = { x: 0, z: 0 };
        return this.modules.scene.screenToGround(sx, sy, out) ? out : null;
      },
    };

    // ---- rejoin record + invite link (wordbomb pattern) -----------------------------
    this.loadStoredSession();
    const linkCode = new URLSearchParams(location.search).get('code');
    if (linkCode !== null && linkCode.length > 0) {
      history.replaceState(null, '', location.pathname + location.hash);
      this.invite = linkCode;
      this.roomCode = linkCode;
      const name = this.storedName();
      if (name !== null) this.pendingJoin = { name, code: linkCode };
    }

    window.setInterval(() => {
      if (this.state.phase === 'menu' && this.net.connected) this.net.send({ t: 'list_rooms' });
    }, ROOMS_EVERY_MS);

    this.modules.audio.setPhase('menu');
    // Resume-on-gesture: WebAudio autoplay policy requires a real user
    // gesture; `resume()` is a documented safe-to-call-repeatedly no-op once
    // already running, so no de-dup bookkeeping is needed here.
    window.addEventListener('pointerdown', () => this.modules.audio.resume(), { once: true });
    window.addEventListener('keydown', () => this.modules.audio.resume(), { once: true });
    this.lastFrameMs = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  // ---- shared identity / session (@platform/shared — try/catch'd internally,
  //      storage may be blocked; everything degrades to in-memory-only) -------------
  /** Rehydrate {@link resumeToken}/{@link roomCode}/{@link roomId} from the
   *  platform-shared session pointer (was a private 'rift.resume' record —
   *  identical shape, so this is a straight swap, not a redesign). */
  private loadStoredSession(): void {
    const rec = loadSession(GAME);
    if (rec === null) return;
    this.resumeToken = rec.playerId;
    this.roomCode = rec.code;
    this.roomId = rec.roomId;
  }

  private persistSession(): void {
    if (this.playerId === null) return;
    saveSession(GAME, { playerId: this.resumeToken ?? this.playerId, roomId: this.roomId, code: this.roomCode });
  }

  /** Forget the room pointer — explicit leave ONLY, never a socket drop
   *  (CONTRACT §2.1: clearSession is the "I'm done with this room" signal). */
  private clearResume(): void {
    this.resumeToken = null;
    this.roomCode = null;
    this.roomId = null;
    clearSession(GAME);
  }

  /** name-input prefill: '' from loadName() means "never typed one", which the
   *  original 'rift.name' probe reported as null — preserved so callers (menus'
   *  prefill, the wasDropped auto-resume fallback below) keep their exact
   *  "nothing stored yet" branch. */
  private storedName(): string | null {
    const n = loadName();
    return n !== '' ? n : null;
  }

  // ---- lobby actions (game:'rift' on every create/join) ------------------------------
  /**
   * Stamp every lobby join with this browser's identity (CONTRACT §2.2/§3):
   * `sig` — the durable per-browser signature — ALWAYS, and `resume` — the
   * previous session's playerId — whenever we hold one. The room tries
   * `resume` first (exact, cheapest) and falls back to `sig` (CONTRACT §2.3),
   * so sending both on every join is what makes that fallback reachable at
   * all; `resume` alone (the old `withResume` behaviour) is still exactly
   * what a room sees when this browser has never held a session.
   */
  private withIdentity<T extends LobbyC2S>(msg: T): T {
    if (!('name' in msg)) return msg;
    if (this.resumeToken !== null) {
      return { ...msg, resume: this.resumeToken, sig: loadSig() };
    }
    return { ...msg, sig: loadSig() };
  }

  private static settingsRecord(settings?: RiftSettings): Record<string, unknown> {
    const s: Record<string, unknown> = {};
    if (settings?.teamSize !== undefined) s.teamSize = settings.teamSize;
    if (settings?.speed !== undefined) s.speed = settings.speed;
    return s;
  }

  private quickJoin(name: string): void {
    const clean = cleanName(name);
    saveName(clean);
    this.net.send(this.withIdentity({ t: 'quick_join', name: clean, game: 'rift' }));
  }

  private createPublic(name: string, settings?: RiftSettings): void {
    const clean = cleanName(name);
    saveName(clean);
    this.net.send(
      this.withIdentity({ t: 'create_public', name: clean, game: 'rift', settings: Game.settingsRecord(settings) }),
    );
  }

  private createPrivate(name: string, settings?: RiftSettings): void {
    const clean = cleanName(name);
    saveName(clean);
    this.roomCode = null; // server-generated; arrives on rift_hello
    this.net.send(
      this.withIdentity({ t: 'create_private', name: clean, game: 'rift', settings: Game.settingsRecord(settings) }),
    );
  }

  private joinPublic(name: string, roomId: string): void {
    const clean = cleanName(name);
    saveName(clean);
    this.roomId = roomId;
    this.net.send(this.withIdentity({ t: 'join_public', name: clean, roomId }));
  }

  private joinPrivate(name: string, code: string): void {
    const c = code.length > 0 ? code : (this.roomCode ?? '');
    if (c.length === 0) return; // menus surface their own validation copy
    const clean = cleanName(name);
    saveName(clean);
    this.roomCode = c; // candidate; a 'no_room' error clears it again
    this.net.send(this.withIdentity({ t: 'join_private', name: clean, code: c }));
  }

  // ---- message routing ---------------------------------------------------------------
  private onMessage(msg: NetMsg): void {
    switch (msg.t) {
      case 'welcome': {
        this.playerId = msg.playerId;
        this.state.error = null;
        this.net.send({ t: 'list_rooms' });
        if (this.pendingJoin !== null) {
          const { name, code } = this.pendingJoin;
          this.pendingJoin = null; // single attempt — on failure the error shows
          this.joinPrivate(name, code);
        } else if (this.wasDropped && this.resumeToken !== null) {
          // Socket dropped mid-room: re-seat through the SAME join paths a
          // human hits; the room rebinds the hero via the resume token.
          this.wasDropped = false;
          const name = this.storedName() ?? 'Player';
          if (this.roomCode !== null) this.joinPrivate(name, this.roomCode);
          else if (this.roomId !== null) this.joinPublic(name, this.roomId);
          else this.quickJoin(name);
        }
        break;
      }
      case 'room_list':
        this.rooms = msg.rooms.filter((r) => r.game === 'rift');
        break;
      case 'error':
        if (msg.code === 'no_room') {
          this.roomCode = null;
          this.roomId = null;
          this.persistSession();
        }
        this.state.error = msg.message;
        this.modules.audio.ui('error');
        break;
      case 'rift_hello': {
        this.helloView = msg;
        // the CURRENT session id becomes the valid rejoin token
        this.resumeToken = this.playerId ?? this.resumeToken;
        if (msg.code !== null) this.roomCode = msg.code;
        this.roomId = msg.roomId;
        this.persistSession();
        this.state.error = null; // a successful (re)join clears the drop banner
        // Identity + team are known now, before any snapshot has arrived
        // (audio needs this for lobby-phase events like hero picks).
        this.audioWorld.selfPid = msg.you;
        this.audioWorld.selfTeam = msg.team;
        this.modules.audio.setWorld(this.audioWorld);
        if (this.state.phase === 'menu') this.setPhase('lobby');
        break;
      }
      case 'rift_lobby': {
        this.lobby = msg;
        // The room full-resets to lobby after MATCH_END_MS and waits; that
        // broadcast is the way back from the end screen. A lobby message
        // during 'live' is a countdown/roster echo and never demotes a match.
        if (this.state.phase === 'menu' || this.state.phase === 'ended') {
          this.clearMatch();
          this.setPhase('lobby');
        }
        break;
      }
      case 'rift_begin': {
        this.begin = msg;
        this.interp = createInterp(); // fresh buffer: no cross-match ghosts
        this.snapsRing.length = 0;
        this.snap = null;
        this.end = null;
        this.selfEntId = -1;
        this.lastYouHp = null;
        this.lastYouLevel = 0;
        this.centeredOnHero = false;
        // A rematch on the same map reuses the static bake (wire.ts), so last
        // match's fallen structures are still hidden — stand them back up
        // before the new match's snaps start reporting deaths. Null on the
        // first begin (the bake does not exist yet; onBegin below builds it).
        this.deadStructures.clear();
        structureControlOf(this.modules.scene)?.resetStructures();
        this.setPhase('live');
        this.modules.audio.setPhase('live');
        // camera starts on the own base until the first snap centres the hero
        const side = MAP_SIDE_BASE + MAP_SIDE_PER_LANE * (msg.lanes - 1);
        const team = this.helloView?.team ?? 0;
        const base = team === 0 ? BASE_INSET : side - BASE_INSET;
        this.panCameraTo(base, base);
        this.onBegin?.(msg);
        break;
      }
      case 'rift_snap':
        this.onSnap(msg);
        break;
      case 'rift_kill':
      case 'rift_structure':
      case 'rift_surge':
      case 'rift_pick':
      case 'rift_roster':
      case 'rift_cast':
      case 'rift_miss':
      case 'rift_end':
        this.onEvent(msg);
        break;
    }
  }

  private onSnap(msg: SnapMsg): void {
    this.combatFx(msg);
    this.snap = msg;
    // The day/night cycle is server-authoritative (protocol.ts freezes
    // `dayPhase` as a continuous wrapping triangle, AMENDMENT_1 §C) — except
    // while a capture holds it pinned.
    if (this.dayPin === null) this.applyDayPhase(msg.dayPhase);
    this.interp.push(msg);
    this.snapsRing.push(msg);
    if (this.snapsRing.length > SNAPS_MAX) this.snapsRing.splice(0, this.snapsRing.length - SNAPS_MAX);

    // Late joiner path: a live snap can arrive without a rift_begin (the room
    // sends begin at lock). The match view still works; the map/lane-arrow
    // data simply stays null. (Flagged to the orchestrator for T10.)
    if (msg.phase === 'live' && this.state.phase !== 'live') {
      this.setPhase('live');
      this.modules.audio.setPhase('live');
    } else if (msg.phase === 'ended' && this.state.phase === 'live') {
      this.setPhase('ended');
    }

    // Own hero entity id (drives unit selection/hp-bar "self" colouring).
    const me = this.helloView?.you ?? null;
    this.selfEntId = -1;
    if (me !== null) {
      for (const e of msg.ents) {
        if (e.k === 'hero' && e.pid === me) {
          this.selfEntId = e.id;
          break;
        }
      }
    }
    this.audioWorld.selfEntId = this.selfEntId;
    this.modules.audio.snapshot(msg);

    // Structure deaths. The snap carries no alive flag and dead structures are
    // sent forever (hp <= 0), so a death is detected exactly once per id here —
    // which also means a late joiner's FIRST snap hides every structure that
    // is already down. Allocation-free: a Set hit per already-dead structure,
    // and the one add/hide per death transition.
    for (const e of msg.ents) {
      if (e.hp > 0) continue;
      if (e.k !== 'tower' && e.k !== 'guard' && e.k !== 'ancient') continue;
      if (this.deadStructures.has(e.id)) continue;
      // No control = the map bake is not up (snap before rift_begin): do NOT
      // mark the id, so the next snap retries once the bake exists.
      const control = structureControlOf(this.modules.scene);
      if (control === null) continue;
      this.deadStructures.add(e.id);
      control.hideStructure(e.id);
    }

    const you = msg.you;
    if (you !== null) {
      // Own-damage feedback: shake + a danger damage number, same frame.
      if (this.lastYouHp !== null && you.hp < this.lastYouHp - 0.5) {
        const drop = this.lastYouHp - you.hp;
        this.modules.fx.shake(Math.min(1, (drop / Math.max(1, you.maxHp)) * 4));
        this.modules.fx.damageNumber(you.x, you.z, `-${String(Math.round(drop))}`, 'danger');
      }
      this.lastYouHp = you.hp;
      if (you.level > this.lastYouLevel) {
        this.lastYouLevel = you.level;
        if (you.level > 1) this.modules.audio.ui('levelup');
      }
      if (!this.centeredOnHero) {
        this.centeredOnHero = true;
        this.panCameraTo(you.x, you.z);
      }
    } else {
      this.lastYouHp = null;
    }

    // Fog mask refresh at ~5Hz (CONTRACT §6), straight off the snap.
    const now = performance.now();
    if (now - this.lastFogMs >= FOG_EVERY_MS) {
      this.lastFogMs = now;
      this.modules.fog.update(msg);
    }
  }

  /** Combat feedback off the snapshot stream (CONTRACT §6: tracers driven by
   *  atk transitions, death bursts where units die). rift_kill only carries
   *  hero pids, so creep deaths are detected here as "present last snap, gone
   *  now, last position still inside our vision" — a unit that merely walked
   *  out of the fog is NOT a death and must not burst. */
  private combatFx(msg: SnapMsg): void {
    const prev = this.prevSnap;
    this.prevSnap = msg;
    if (prev === null) return;
    const fx = this.modules.fx;
    const curById = new Map<number, SnapMsg['ents'][number]>();
    for (const e of msg.ents) curById.set(e.id, e);
    const prevById = new Map<number, SnapMsg['ents'][number]>();
    for (const e of prev.ents) prevById.set(e.id, e);

    // attack tracers: atk is transient per snap (set only on the swing tick)
    for (const e of msg.ents) {
      if (e.atk === undefined || e.k === 'proj') continue;
      const p = prevById.get(e.id);
      if (p !== undefined && p.atk === e.atk) continue; // same swing, already shown
      const tgt = curById.get(e.atk) ?? prevById.get(e.atk);
      if (tgt === undefined) continue;
      const kind =
        e.k === 'tower' || e.k === 'guard' || e.k === 'ancient'
          ? 'tower'
          : e.k === 'melee' || e.k === 'siege'
            ? 'phys'
            : 'magic';
      fx.tracer(e.x, e.z, tgt.x, tgt.z, kind);
    }

    // creep death bursts: vanished while their last position stays visible
    // (structures never vanish — rift_structure covers them; heroes carry pids
    // and rift_kill covers them)
    for (const p of prev.ents) {
      if (p.hp <= 0 || p.pid !== undefined) continue;
      if (p.k === 'tower' || p.k === 'guard' || p.k === 'ancient' || p.k === 'proj') continue;
      if (curById.has(p.id)) continue;
      if (!this.modules.fog.isVisible(p.x, p.z)) continue; // walked out of vision
      fx.burst(p.x, p.z, 'death');
    }
  }

  private onEvent(ev: RiftEvent): void {
    this.events.push(ev);
    if (this.events.length > EVENTS_MAX) this.events.splice(0, this.events.length - EVENTS_MAX);
    this.modules.audio.event(ev);
    const fx = this.modules.fx;
    switch (ev.t) {
      case 'rift_kill': {
        // victim position from the newest snap (the ent may already be gone —
        // dead heroes leave the visible set; then the sting alone carries it)
        const pos = this.entPosByPid(ev.victim);
        if (pos !== null) {
          fx.burst(pos.x, pos.z, 'death');
          if (ev.killer !== null && ev.killer === this.helloView?.you) {
            fx.damageNumber(pos.x, pos.z, `+${String(ev.gold)}`, 'gold');
          }
        }
        break;
      }
      case 'rift_structure': {
        // The event carries no id; the fallen structure is the one matching
        // team+kind+lane with hp <= 0 in the newest snap (structures are
        // always sent, destroyed included).
        const snap = this.snap;
        if (snap !== null) {
          for (const e of snap.ents) {
            if (e.k === ev.kind && e.team === ev.team && e.hp <= 0) {
              fx.burst(e.x, e.z, 'tower');
              break;
            }
          }
        }
        break;
      }
      case 'rift_cast': {
        fx.burst(ev.x, ev.z, Game.castFxKind(this.snap, ev.id, ev.slot));
        break;
      }
      case 'rift_roster': {
        if (this.helloView !== null) {
          this.helloView = { ...this.helloView, roster: ev.roster };
        }
        break;
      }
      case 'rift_end': {
        this.end = ev;
        this.setPhase('ended');
        this.modules.audio.setPhase('menu');
        break;
      }
      case 'rift_surge':
      case 'rift_pick':
      case 'rift_miss':
        // No fx of their own: the surge sting and the pick chime come from
        // `audio.event` above, and `rift_miss` is drawn by hud.ts off
        // `state.events` (the MISS / EVADED float) — the swing's tracer was
        // already emitted by combatFx, because a miss still spends the swing.
        break;
    }
  }

  /** Ability school -> fx burst kind for a cast event (paper/arcane/heal). */
  private static castFxKind(snap: SnapMsg | null, entId: number, slot: number): 'phys' | 'magic' | 'heal' {
    if (snap !== null) {
      for (const e of snap.ents) {
        if (e.id !== entId || e.hero === undefined) continue;
        const def = heroById(e.hero).abilities[slot];
        if (def !== undefined) {
          let hasHeal = false;
          for (const eff of def.effects) {
            if (eff.kind === 'damage') return eff.school === 'physical' ? 'phys' : 'magic';
            if (eff.kind === 'heal') hasHeal = true;
          }
          if (hasHeal) return 'heal';
        }
        break;
      }
    }
    return 'magic';
  }

  private entPosByPid(pid: string): { x: number; z: number } | null {
    const snap = this.snap;
    if (snap === null) return null;
    for (const e of snap.ents) {
      if (e.pid === pid) return { x: e.x, z: e.z };
    }
    return null;
  }

  /**
   * The team of entity `id` as `input.ts` must read it, which is HOSTILITY,
   * not identity.
   *
   * Both of input.ts's call sites reduce this to `team !== self` — "is this a
   * legal right-click attack target / does the cursor show the crosshair" —
   * and its hook is typed `TeamId | null` (input.ts is not R_WIRE's file and
   * its signature cannot be widened here). `EntSnap.team` is the widened
   * `EntTeam`, so a jungle camp arrives carrying `NEUTRAL_TEAM`, and a camp is
   * hostile to BOTH player teams. Reporting it as the opposing player team is
   * what that reduces to correctly; reporting `null` would make every
   * right-click on a camp fall through to a MOVE order and leave the entire
   * jungle unclickable, in the build whose whole server wave was the jungle.
   *
   * Unknown ids, and a neutral seen before `rift_hello` has told us our own
   * side, stay null.
   */
  private entTeam(id: number): TeamId | null {
    const snap = this.snap;
    if (snap === null) return null;
    for (const e of snap.ents) {
      if (e.id !== id) continue;
      if (isPlayerTeam(e.team)) return e.team;
      const mine = this.helloView?.team ?? null;
      return mine === null ? null : mine === 0 ? 1 : 0;
    }
    return null;
  }

  // ---- cast/item preflight + denial toast (the silent-no-op fix) --------------
  // The server DROPS invalid casts in silence (parse-level: never an error),
  // so a rejected QWER used to be indistinguishable from a dead key. input.ts
  // preflights every quick-cast here against the latest snapshot — the same
  // data the server validates with — and toasts the reason instead of sending.
  // Item actives (1-6) got the same treatment (itemBlockReason below).

  /** Null when the cast may be sent; otherwise the short player-facing reason. */
  private castBlockReason(slot: number, aim: { x?: number; z?: number; target?: number }): string | null {
    const snap = this.snap;
    const you = snap?.you ?? null;
    if (snap === null || you === null) return 'not in game yet';
    const def = heroById(you.hero).abilities[slot];
    if (def === undefined || def.isPassive) return null; // input.ts guards these
    const tick = snap.matchTick;
    if (you.respawnAtTick > tick) {
      return `dead — respawn in ${String(Math.max(1, Math.ceil((you.respawnAtTick - tick) * TICK_DT)))}s`;
    }
    const st = you.abilities[slot];
    const rank = st?.rank ?? 0;
    if (rank < 1) {
      return def.ult
        ? `ult unlocks at LV ${String(ULT_LEVEL_REQ[rank] ?? '?')}`
        : 'not learned — level it first (+ or Ctrl+key)';
    }
    const cd = st?.cdUntilTick ?? 0;
    if (cd > tick) return `on cooldown (${String(Math.max(1, Math.ceil((cd - tick) * TICK_DT)))}s)`;
    const cost = def.manaCost[rank - 1] ?? 0;
    if (you.mana < cost) return 'not enough mana';
    const range = def.castRange[rank - 1] ?? 0;
    if (aim.target !== undefined) {
      const ent = snap.ents.find((e) => e.id === aim.target);
      if (ent === undefined) return 'target is not visible';
      if (ent.k !== 'hero' && ent.k !== 'melee' && ent.k !== 'ranged' && ent.k !== 'siege' && ent.k !== 'shade') {
        return 'invalid target';
      }
      const mine = this.helloView?.team ?? null;
      if (mine !== null) {
        if (def.targetTeam === 'enemy' && ent.team === mine) return 'needs an ENEMY target';
        if (def.targetTeam === 'ally' && ent.team !== mine) return 'needs an ALLY target';
      }
      if (Math.hypot(ent.x - you.x, ent.z - you.z) > range) return 'out of range';
    } else if (aim.x !== undefined && aim.z !== undefined) {
      if (Math.hypot(aim.x - you.x, aim.z - you.z) > range) return 'out of range';
    }
    return null;
  }

  /** Item-active preflight (1-6 keys), mirroring the server's silent no-ops in
   *  sim/world.ts useItem: dead / cooldown / ward charges / team ward stock /
   *  ward place range. Null = the use may be sent. Empty slots and passive
   *  items return null too — input.ts never reaches here for those. */
  private itemBlockReason(slot: number, aim: { x?: number; z?: number }): string | null {
    const snap = this.snap;
    const you = snap?.you ?? null;
    if (snap === null || you === null) return 'not in game yet';
    const id = you.items[slot];
    if (id === null || id === undefined) return null;
    const active = ITEMS[id].active;
    if (active === undefined) return null;
    const tick = snap.matchTick;
    if (you.respawnAtTick > tick) {
      return `dead — respawn in ${String(Math.max(1, Math.ceil((you.respawnAtTick - tick) * TICK_DT)))}s`;
    }
    const cd = you.itemCdUntilTick[slot] ?? 0;
    if (cd > tick) {
      return `${ITEMS[id].name} on cooldown (${String(Math.max(1, Math.ceil((cd - tick) * TICK_DT)))}s)`;
    }
    if (active.kind === 'ward') {
      if ((you.itemCharges[slot] ?? 0) < 1) return 'no ward charges left';
      if (snap.wardStock < 1) return 'team ward stock empty — restocks over time';
      if (
        aim.x !== undefined &&
        aim.z !== undefined &&
        Math.hypot(aim.x - you.x, aim.z - you.z) > WARD_PLACE_RANGE
      ) {
        return 'out of range';
      }
    }
    return null;
  }

  /** Transient denial note + the error blip (1.5s pill, hud reads state.toast). */
  private castDenied(reason: string): void {
    this.toast = { text: reason, untilMs: performance.now() + TOAST_MS };
    this.modules.audio.ui('error');
  }

  // ---- phase / lifecycle --------------------------------------------------------------
  private setPhase(p: Phase): void {
    if (this.state.phase === p) return;
    this.state.phase = p;
    if (p !== 'live') {
      this.state.shopOpen = false;
      this.state.scoreboardOpen = false;
    }
  }

  /** Match-scoped state cleared on the way back to the lobby (room reset). */
  private clearMatch(): void {
    this.begin = null;
    this.snap = null;
    this.prevSnap = null;
    this.end = null;
    this.interp = createInterp();
    this.snapsRing.length = 0;
    this.events.length = 0;
    this.selfEntId = -1;
    this.lastYouHp = null;
    this.lastYouLevel = 0;
    this.centeredOnHero = false;
  }

  private leaveToMenu(): void {
    this.net.send({ t: 'leave' });
    this.clearResume();
    this.helloView = null;
    this.lobby = null;
    this.clearMatch();
    this.state.error = null;
    this.setPhase('menu');
    this.modules.audio.setPhase('menu');
    if (this.net.connected) this.net.send({ t: 'list_rooms' });
  }

  private onSocketClose(): void {
    this.wasDropped = true;
    // Stay on the current screen behind a banner; the auto-resume on welcome
    // brings the match back. (CONTRACT §10: socket drop -> banner + resume.)
    this.state.error = 'connection lost — reconnecting…';
  }

  // ---- camera ---------------------------------------------------------------------------
  private mapSide(): number {
    const begin = this.begin;
    return begin === null ? MAP_SIDE_BASE : MAP_SIDE_BASE + MAP_SIDE_PER_LANE * (begin.lanes - 1);
  }

  private panCameraTo(x: number, z: number): void {
    const side = this.mapSide();
    this.camX = clamp(x, 0, side);
    this.camZ = clamp(z, 0, side);
  }

  private centerCamera(): void {
    const you = this.snap?.you;
    if (you !== null && you !== undefined) this.panCameraTo(you.x, you.z);
  }

  // ---- UiActions.send: game messages only (lobby messages go through the
  //      dedicated create/join methods, which also persist the name) -----------
  private sendGame(msg: RiftC2S): void {
    if (msg.t === 'rift_buy' || msg.t === 'rift_sell') this.modules.audio.ui('buy');
    else if (msg.t === 'rift_drop') this.modules.audio.ui('click');
    this.net.send(msg);
  }

  // ---- day / night ------------------------------------------------------------------
  /** The ONE place the day/night phase is published, and it publishes to BOTH
   *  sinks. `setTimeOfDay` deliberately exists twice — on `SceneHandle` (sun
   *  and moon direction and intensity, the sky gradient, the PMREM rebuild,
   *  fog colour and density, tone-mapping exposure) and on `PostHandle` (bloom
   *  strength and radius, AO intensity, the grade and vignette curve) —
   *  because the scene holds no reference to the post stack and
   *  GRAPHICS_CONTRACT §6 makes `setFramePass` the only link between them. The
   *  Game holds the scene; wire.ts holds the post stack and lends it here as
   *  `probes.postTimeOfDay`. Same value, same 0=day/1=night scale, same frame:
   *  a night sky graded by a daytime vignette is exactly the split-brain this
   *  routing exists to prevent. */
  private applyDayPhase(t: number): void {
    const v = Number.isFinite(t) ? clamp(t, 0, 1) : 0;
    if (v === this.dayPhaseSent) return;
    this.dayPhaseSent = v;
    this.modules.scene.setTimeOfDay(v);
    this.probes?.postTimeOfDay(v);
  }

  /** `__rift.setDayPhase`. Pinning is what makes a judge round reproducible;
   *  releasing re-applies the newest snapshot's phase at once rather than
   *  leaving the world stuck on the pinned value until the next snapshot. */
  private setDayPhase(t: number | null): void {
    if (t === null) {
      this.dayPin = null;
      const snap = this.snap;
      if (snap !== null) this.applyDayPhase(snap.dayPhase);
      return;
    }
    if (!Number.isFinite(t)) return; // a NaN pin would poison every sink
    const v = clamp(t, 0, 1);
    this.dayPin = v;
    this.applyDayPhase(v);
  }

  // ---- debug surface helpers ------------------------------------------------------
  private debugState(): RiftDebugState {
    const snap = this.snap;
    return {
      phase: this.state.phase,
      connected: this.net.connected,
      you: this.helloView?.you ?? null,
      team: this.helloView?.team ?? null,
      hero: snap?.you?.hero ?? null,
      gold: snap?.you?.gold ?? null,
      tick: snap?.tick ?? null,
      ents: snap?.ents.length ?? 0,
      positions:
        snap === null ? [] : snap.ents.map((e) => ({ id: e.id, x: e.x, z: e.z })),
    };
  }

  private debugOrder(kind: 'move' | 'attackmove' | 'attack' | 'stop', x?: number, z?: number, target?: number): void {
    if (kind === 'stop') {
      this.net.send({ t: 'rift_order', kind: 'stop' });
    } else if (kind === 'attack') {
      if (typeof target === 'number') this.net.send({ t: 'rift_order', kind: 'attack', target });
    } else if (typeof x === 'number' && typeof z === 'number') {
      this.net.send({ t: 'rift_order', kind, x, z });
    }
  }

  private debugCast(slot: number, x?: number, z?: number, target?: number): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= 4) return;
    const msg: { t: 'rift_cast'; slot: number; x?: number; z?: number; target?: number } = {
      t: 'rift_cast',
      slot,
    };
    if (typeof x === 'number' && typeof z === 'number') {
      msg.x = x;
      msg.z = z;
    }
    if (typeof target === 'number') msg.target = target;
    this.net.send(msg);
  }

  private debugItem(slot: number, x?: number, z?: number): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= 6) return;
    const msg: { t: 'rift_item'; slot: number; x?: number; z?: number } = { t: 'rift_item', slot };
    if (typeof x === 'number' && typeof z === 'number') {
      msg.x = x;
      msg.z = z;
    }
    this.net.send(msg);
  }

  // ---- the frame loop (guarded: one exception must never white-screen) --------------
  private frame(nowMs: number): void {
    requestAnimationFrame((t) => this.frame(t));
    const dtMs = Math.min(100, Math.max(0, nowMs - this.lastFrameMs));
    this.lastFrameMs = nowMs;
    try {
      this.step(dtMs);
    } catch (err) {
      // render loop is guarded (CONTRACT §10): log once-ish, keep animating
      if (this.state.error === null) this.state.error = 'render error — see console';
      console.error('[rift] render loop error', err);
    }
  }

  private step(dtMs: number): void {
    const m = this.modules;
    const live = this.state.phase === 'live';
    const inMatch = live || this.state.phase === 'ended';

    this.input.update(dtMs);
    m.scene.setCamera(this.camX, this.camZ, this.camH);
    if (inMatch && !this.state.scoreboardOpen) {
      m.units.sync(this.interp.sample(), this.interp.ghosts(), this.selfEntId);
      m.nameLabels.update(
        this.interp.sample(),
        (x, z, out) => m.scene.groundToScreen(x, z, out),
        (pid) => this.helloView?.roster.find((r) => r.id === pid)?.name,
      );
    } else {
      m.nameLabels.update([], () => false, () => undefined);
      if (inMatch) m.units.sync(this.interp.sample(), this.interp.ghosts(), this.selfEntId);
    }
    m.scene.render(dtMs);
    m.fx.tick(dtMs);
    // Camera ground point is the audio listener (SONIC_BIBLE §2); mutate the
    // preallocated ListenerState in place, no per-frame allocation.
    this.audioListener.x = this.camX;
    this.audioListener.z = this.camZ;
    this.audioListener.height = this.camH;
    m.audio.tick(dtMs, this.audioListener);

    // Refresh the single preallocated ClientState in place (no per-frame alloc).
    const s = this.state;
    s.connected = this.net.connected;
    s.hello = this.helloView;
    s.lobby = this.lobby;
    s.begin = this.begin;
    s.snap = this.snap;
    s.interp = live ? this.interp : null;
    s.fog = live ? m.fog : null;
    s.end = this.end;
    s.cameraX = this.camX;
    s.cameraZ = this.camZ;
    s.cameraHeight = this.camH;
    if (this.toast !== null && performance.now() >= this.toast.untilMs) this.toast = null;
    s.toast = this.toast;

    m.hud.render(s, this.actions);
    m.shop.render(s, this.actions);
    m.minimap.render(s, this.actions);
    m.menus.render(s, this.actions);
  }
}
