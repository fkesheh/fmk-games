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
  heroById,
  MAP_SIDE_BASE,
  MAP_SIDE_PER_LANE,
} from '@rift/shared';
import type { HeroId, RiftC2S, RiftEvent, RiftSettings, TeamId } from '@rift/shared';
import type { LobbyC2S, RoomInfo } from '@platform/shared';
import type {
  BeginMsg,
  ClientModules,
  ClientState,
  EndEvent,
  HelloMsg,
  InterpHandle,
  LobbyMsg,
  SnapMsg,
  UiActions,
} from './contract.js';
import { createNet, type NetHandle, type NetMsg } from './net.js';
import { createInterp } from './interp.js';
import { createInput, type InputHandle } from './input.js';

// ---- tuning ----------------------------------------------------------------------
const RESUME_KEY = 'rift.resume'; // localStorage: { playerId, code, roomId }
const NAME_KEY = 'rift.name'; // localStorage: last joined name
const EVENTS_MAX = 32; // state.events ring (killfeed/audio), newest last
const SNAPS_MAX = 32; // __rift.snaps() ring
const FOG_EVERY_MS = 200; // fog mask refresh ≈ 5Hz (CONTRACT §6)
const CAM_MIN_H = 18; // wheel zoom clamp (CONTRACT §6)
const CAM_MAX_H = 55;
const CAM_DEFAULT_H = 36;
const ROOMS_EVERY_MS = 3000; // menu room-list poll (wordbomb pattern)
const NAME_MAX = 16; // lobby cleanName cap (platform protocol)

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
}

declare global {
  interface Window {
    __rift?: RiftDebugApi;
  }
}

function cleanName(v: string): string {
  return v.trim().slice(0, NAME_MAX) || 'Player';
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
  private end: EndEvent | null = null;
  private readonly events: RiftEvent[] = [];
  private readonly snapsRing: SnapMsg[] = [];
  private lastFogMs = -FOG_EVERY_MS;
  private selfEntId = -1;
  private lastYouHp: number | null = null;
  private lastYouLevel = 0;

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
  };
  private readonly actions: UiActions;
  private lastFrameMs = 0;

  /** Orchestrator hook (wire.ts): fired with each rift_begin so map-dependent
   *  handles can be built/swapped. Additive to the frozen constructor seam. */
  onBegin: ((begin: BeginMsg) => void) | null = null;

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
    };

    // ---- rejoin record + invite link (wordbomb pattern) -----------------------------
    this.loadResume();
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
    this.lastFrameMs = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  // ---- localStorage (try/catch'd — storage may be blocked) -------------------------
  private loadResume(): void {
    try {
      const raw = localStorage.getItem(RESUME_KEY);
      if (raw === null) return;
      const v: unknown = JSON.parse(raw);
      if (typeof v !== 'object' || v === null) return;
      const o = v as Record<string, unknown>;
      if (typeof o.playerId === 'string') this.resumeToken = o.playerId;
      if (typeof o.code === 'string') this.roomCode = o.code;
      if (typeof o.roomId === 'string') this.roomId = o.roomId;
    } catch {
      // storage blocked or corrupt JSON — play without rejoin
    }
  }

  private persistResume(): void {
    if (this.playerId === null) return;
    try {
      localStorage.setItem(
        RESUME_KEY,
        JSON.stringify({ playerId: this.resumeToken ?? this.playerId, code: this.roomCode, roomId: this.roomId }),
      );
    } catch {
      // storage blocked — non-fatal
    }
  }

  private clearResume(): void {
    this.resumeToken = null;
    this.roomCode = null;
    this.roomId = null;
    try {
      localStorage.removeItem(RESUME_KEY);
    } catch {
      // storage blocked — non-fatal
    }
  }

  private storedName(): string | null {
    try {
      const v = localStorage.getItem(NAME_KEY);
      return v !== null && v.trim().length > 0 ? v : null;
    } catch {
      return null;
    }
  }

  private persistName(name: string): void {
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      // storage blocked — non-fatal
    }
  }

  // ---- lobby actions (game:'rift' on every create/join) ------------------------------
  private withResume<T extends LobbyC2S>(msg: T): T {
    if (this.resumeToken !== null && 'name' in msg) {
      return { ...msg, resume: this.resumeToken };
    }
    return msg;
  }

  private static settingsRecord(settings?: RiftSettings): Record<string, unknown> {
    const s: Record<string, unknown> = {};
    if (settings?.teamSize !== undefined) s.teamSize = settings.teamSize;
    if (settings?.speed !== undefined) s.speed = settings.speed;
    return s;
  }

  private quickJoin(name: string): void {
    const clean = cleanName(name);
    this.persistName(clean);
    this.net.send(this.withResume({ t: 'quick_join', name: clean, game: 'rift' }));
  }

  private createPublic(name: string, settings?: RiftSettings): void {
    const clean = cleanName(name);
    this.persistName(clean);
    this.net.send(
      this.withResume({ t: 'create_public', name: clean, game: 'rift', settings: Game.settingsRecord(settings) }),
    );
  }

  private createPrivate(name: string, settings?: RiftSettings): void {
    const clean = cleanName(name);
    this.persistName(clean);
    this.roomCode = null; // server-generated; arrives on rift_hello
    this.net.send(
      this.withResume({ t: 'create_private', name: clean, game: 'rift', settings: Game.settingsRecord(settings) }),
    );
  }

  private joinPublic(name: string, roomId: string): void {
    const clean = cleanName(name);
    this.persistName(clean);
    this.roomId = roomId;
    this.net.send(this.withResume({ t: 'join_public', name: clean, roomId }));
  }

  private joinPrivate(name: string, code: string): void {
    const c = code.length > 0 ? code : (this.roomCode ?? '');
    if (c.length === 0) return; // menus surface their own validation copy
    const clean = cleanName(name);
    this.persistName(clean);
    this.roomCode = c; // candidate; a 'no_room' error clears it again
    this.net.send(this.withResume({ t: 'join_private', name: clean, code: c }));
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
          this.persistResume();
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
        this.persistResume();
        this.state.error = null; // a successful (re)join clears the drop banner
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
      case 'rift_end':
        this.onEvent(msg);
        break;
    }
  }

  private onSnap(msg: SnapMsg): void {
    this.snap = msg;
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
        break; // events ring + audio already handled above
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

  private entTeam(id: number): TeamId | null {
    const snap = this.snap;
    if (snap === null) return null;
    for (const e of snap.ents) {
      if (e.id === id) return e.team;
    }
    return null;
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
    if (msg.t === 'rift_buy') this.modules.audio.ui('buy');
    this.net.send(msg);
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
    if (inMatch) {
      m.units.sync(this.interp.sample(), this.interp.ghosts(), this.selfEntId);
    }
    m.scene.render(dtMs);
    m.fx.tick(dtMs);

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

    m.hud.render(s, this.actions);
    m.shop.render(s, this.actions);
    m.minimap.render(s, this.actions);
    m.menus.render(s, this.actions);
  }
}
