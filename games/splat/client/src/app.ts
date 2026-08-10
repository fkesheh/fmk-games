// ============================================================================
// SKI SPLAT client — connection, lobby flow, race screens, net wiring. Task C2
// (CONTRACT §7 C2). Structure cloned from games/kart/client/src/app.ts (do NOT
// import from kart): clock-offset EMA, lobby flow, interp buffers, tablet
// auto-detect + touch DOM with cached rects, settings flags, wake lock, the
// window.__splat debug surface.
//
// Net model: SERVER-AUTHORitative. The wire carries INTENT, never coordinates
// — one splat_input (steer + dt + seq) per SIM_DT from drive.ts (C1), flushed
// here. The server integrates the shared stepSki over those inputs and owns
// every position; snapshots at SNAPSHOT_HZ carry you.sim + you.lastProcessedSeq
// and drive.reconcile() replays whatever is unacknowledged. Remote skiers
// render INTERP_DELAY_MS behind serverTime from per-player interpolation
// buffers. ALL inbound messages are parsed defensively (invalid => drop) and
// every handler is wrapped: one bad frame never white-screens the client.
//
// WIRE SEQ CONTINUITY (the one piece of netcode kart does NOT have): the
// server's per-seat input gate (lastQueuedSeq / lastProcessedSeq) survives a
// resume rebind AND a rematch, but drive.ts starts its wire seq at 1 per
// instance and its frozen §7a API has no seq setter. So C2 owns a session-
// monotonic OFFSET: every outgoing splat_input is re-stamped seq += seqOffset
// (the object is drive's outbox entry, mutated in the flush callback — drive
// drops its reference the moment flush() returns and the predictor queued
// COPIES, so the mutation is allocation-free and cannot corrupt the replay),
// and every ack is mapped back with ack - seqOffset before reconcile(). The
// offset is seeded from the persisted session's lastSeq and from the highest
// ack the server ever reports, so the wire seq keeps counting across socket
// reconnects, page reloads, DriveController recreation on seed change, and
// rematches — exactly what V1's surviving watermark requires.
// ============================================================================
import {
  EXTRAPOLATE_MAX_MS,
  INTERP_DELAY_MS,
  MAX_PLAYERS,
  MAX_SPEED,
  MIN_PLAYERS,
  SKIER_COLORS,
  SKIER_GLYPHS,
  SPAL,
} from '@splat/shared';
import { genSlope } from '@splat/shared/slope.js';
import type {
  Phase,
  RosterEntry,
  SkierSim,
  SkierSnap,
  SlopeDef,
  SplatC2S,
  SplatEvent,
  SplatJoined,
  SplatRoster,
  SplatSnapshot,
} from '@splat/shared';
import { NET, cleanName, loadName, loadSig, saveName } from '@platform/shared';
import type { LobbyC2S } from '@platform/shared';
import { DriveController } from './drive.js';
import { SplatScene } from './render/scene.js';
import { PlantField } from './render/plants.js';
import { SkierVisuals } from './render/skiers.js';
import { SplatFx } from './render/fx.js';
import { SplatHud } from './ui/hud.js';
import type { HudRacer, HudState } from './ui/hud.js';
import { SplatAudio } from './audio.js';

// ---- wire parsing (mirror of the platform style: invalid => null, never throw) ----
type LobbyMsg =
  | { t: 'welcome'; playerId: string }
  | { t: 'pong'; ts: number; serverTime: number }
  | { t: 'error'; code: string; message: string };

type S2C = LobbyMsg | SplatJoined | SplatRoster | SplatSnapshot | { t: 'splat_event'; ev: SplatEvent };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function str(v: unknown): v is string {
  return typeof v === 'string';
}
function bool(v: unknown): v is boolean {
  return typeof v === 'boolean';
}
function phaseOf(v: unknown): Phase | null {
  return v === 'lobby' || v === 'countdown' || v === 'racing' || v === 'results' ? v : null;
}

function parseRosterEntry(v: unknown): RosterEntry | null {
  if (!isObj(v) || !str(v.id) || !str(v.name) || !num(v.slot)) return null;
  return { id: v.id, name: v.name, slot: v.slot };
}

/** The server's authoritative own-skier state — every field or nothing, and
 *  rebuilt as a plain object: wire objects are pooled and mutated in place on
 *  the server, so nothing downstream may retain the decoded reference. */
function parseSkierSim(v: unknown): SkierSim | null {
  if (!isObj(v)) return null;
  if (!num(v.x) || !num(v.z) || !num(v.yaw) || !num(v.v) || !num(v.simMs)) return null;
  if (!num(v.snareUntilMs) || !num(v.lastPlantIx) || !num(v.lastPlantHitMs)) return null;
  if (!bool(v.finished) || !num(v.finishMs)) return null;
  return {
    x: v.x,
    z: v.z,
    yaw: v.yaw,
    v: v.v,
    simMs: v.simMs,
    snareUntilMs: v.snareUntilMs,
    lastPlantIx: v.lastPlantIx,
    lastPlantHitMs: v.lastPlantHitMs,
    finished: v.finished,
    finishMs: v.finishMs,
  };
}

function parseSkierSnap(v: unknown): SkierSnap | null {
  if (!isObj(v) || !str(v.id) || !num(v.slot)) return null;
  if (!num(v.x) || !num(v.z) || !num(v.yaw) || !num(v.v) || !num(v.steer)) return null;
  if (!bool(v.finished) || !num(v.finishMs) || !num(v.place)) return null;
  return {
    id: v.id,
    slot: v.slot,
    x: v.x,
    z: v.z,
    yaw: v.yaw,
    v: v.v,
    steer: v.steer,
    finished: v.finished,
    finishMs: v.finishMs,
    place: v.place,
  };
}

function parseSplatEvent(v: unknown): SplatEvent | null {
  if (!isObj(v) || !str(v.t)) return null;
  switch (v.t) {
    case 'plant_hit':
      return str(v.id) && num(v.plantIx) && num(v.x) && num(v.z)
        ? { t: 'plant_hit', id: v.id, plantIx: v.plantIx, x: v.x, z: v.z }
        : null;
    case 'finished':
      return str(v.id) && num(v.place) && num(v.finishMs)
        ? { t: 'finished', id: v.id, place: v.place, finishMs: v.finishMs }
        : null;
    case 'player_left':
      return str(v.id) ? { t: 'player_left', id: v.id } : null;
    default:
      return null;
  }
}

function parseRosterList(raw: unknown): RosterEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const players: RosterEntry[] = [];
  for (const p of raw) {
    const entry = parseRosterEntry(p);
    if (entry === null) return null; // a half-known roster would mis-colour the lobby
    players.push(entry);
  }
  return players;
}

function parseS2C(raw: unknown): S2C | null {
  if (!isObj(raw) || typeof raw.t !== 'string') return null;
  switch (raw.t) {
    case 'welcome':
      return str(raw.playerId) ? { t: 'welcome', playerId: raw.playerId } : null;
    case 'pong':
      return num(raw.ts) && num(raw.serverTime)
        ? { t: 'pong', ts: raw.ts, serverTime: raw.serverTime }
        : null;
    case 'error':
      return str(raw.code) && str(raw.message)
        ? { t: 'error', code: raw.code, message: raw.message }
        : null;
    case 'splat_joined': {
      const phase = phaseOf(raw.phase);
      if (!str(raw.you) || !num(raw.slot) || phase === null || !num(raw.seed)) return null;
      if (!num(raw.serverTime)) return null;
      const players = parseRosterList(raw.players);
      if (players === null) return null;
      return {
        t: 'splat_joined',
        code: str(raw.code) ? raw.code : null,
        you: raw.you,
        slot: raw.slot,
        phase,
        seed: raw.seed,
        serverTime: raw.serverTime,
        players,
      };
    }
    case 'splat_roster': {
      const players = parseRosterList(raw.players);
      return players === null ? null : { t: 'splat_roster', players };
    }
    case 'splat_snapshot': {
      const phase = phaseOf(raw.phase);
      if (phase === null) return null;
      if (!num(raw.tick) || !num(raw.serverTime) || !num(raw.seed)) return null;
      if (!num(raw.countdown) || !num(raw.phaseEndsAt)) return null;
      if (!num(raw.playerCount) || !num(raw.minPlayers)) return null;
      if (!isObj(raw.you) || !num(raw.you.lastProcessedSeq)) return null;
      const sim = parseSkierSim(raw.you.sim);
      if (sim === null) return null;
      if (!Array.isArray(raw.players)) return null;
      const players: SkierSnap[] = [];
      for (const p of raw.players) {
        // a malformed entry drops alone at SNAPSHOT_HZ — never the whole frame
        const snap = parseSkierSnap(p);
        if (snap !== null) players.push(snap);
      }
      return {
        t: 'splat_snapshot',
        tick: raw.tick,
        serverTime: raw.serverTime,
        phase,
        seed: raw.seed,
        countdown: raw.countdown,
        phaseEndsAt: raw.phaseEndsAt,
        playerCount: raw.playerCount,
        minPlayers: raw.minPlayers,
        canStart: raw.canStart === true,
        you: { lastProcessedSeq: raw.you.lastProcessedSeq, sim },
        players,
      };
    }
    case 'splat_event': {
      const ev = parseSplatEvent(raw.ev);
      return ev !== null ? { t: 'splat_event', ev } : null;
    }
    default:
      return null; // unknown envelope: drop, never throw on wire data
  }
}

// ---- tuning ------------------------------------------------------------------
const RECONNECT_MS = 1000; // socket dropped -> quiet retry (banner tells the player)
const PING_EVERY_MS = NET.pingEveryMs; // mirrors the platform transport cadence
const OFFSET_EMA = 0.2; // server-clock offset smoothing (a spike must not lurch remotes)
const BUFFER_KEEP_MS = 1000; // per-remote snapshot history
const TELEPORT_SQ = 10 * 10; // m² — bigger jumps snap, never lerp (matches kart interp)
const MAX_FRAME_DT_MS = 250; // tab-switch clamp; drive.step clamps finer internally
const WATCHDOG_MS = 200; // background-tab keepalive cadence (rAF pauses there)
const FRAME_STALE_MS = 250; // rAF silence that wakes the watchdog
const CORRECTION_EPS_M = 0.05; // reconciles smaller than this count as "converged"
const SESSION_KEY = 'splat.session'; // localStorage rejoin pointer + seq watermark
const TABLET_KEY = 'splat.tablet'; // '1'/'0' = decided; absent = auto-detect
const LEFTY_KEY = 'splat.lefty';
const ASSIST_KEY = 'splat.assist';
const NAME_MAX_LEN = 16; // platform cleanName cap
const CODE_MAX_LEN = 8;
const TWO_PI = Math.PI * 2;
const SEQ_SAVE_EVERY_MS = 2000; // localStorage is not a per-snapshot device

/** The rejoin pointer + input-seq watermark persisted across drops/reloads. */
interface SplatSession {
  playerId: string; // the LAST socket's id — sent back as `resume` on rejoin
  name: string;
  roomCode: string | null; // private invite code; null = public room
  lastSeq: number; // highest wire seq this browser has used (see header)
}

/** One buffered remote snapshot (serverTime ms). */
interface RemoteSample {
  t: number;
  x: number;
  z: number;
  yaw: number;
  v: number;
  steer: number;
}

/** What gets drawn for a remote skier this frame. */
interface RemoteVisual {
  x: number;
  z: number;
  yaw: number;
  steer: number;
}

// ---- frozen e2e/debug surface (window.__splat, CONTRACT §7 C2) --------------
interface SplatDebugState {
  phase: Phase | 'menu';
  seated: boolean; // false = late joiner parked at the gate until the next countdown
  slot: number;
  place: number; // 0 until the first racing snapshot
  sim: SkierSim | null; // predicted own state (a COPY — safe to retain)
  code: string | null;
  canStart: boolean;
}

interface SplatRemoteDebug {
  id: string;
  x: number; // last INTERPOLATED position (what is on screen)
  z: number;
  yaw: number;
  samples: number; // interpolation buffer depth
}

interface SplatTelemetry {
  drawCalls: number;
  remotes: SplatRemoteDebug[];
  correction: number; // metres the last reconcile moved the predicted skier
  pending: number; // unacknowledged inputs still queued for replay
  ack: number; // you.lastProcessedSeq (wire space)
  seq: number; // highest wire seq sent
  offsetMs: number; // serverNow = Date.now() + offsetMs
  seed: number;
}

interface SplatApi {
  state(): SplatDebugState;
  telemetry(): SplatTelemetry;
  joinQuick(name: string): void;
  startRace(seed?: number): void;
  setInput(steer: number): void;
}

declare global {
  interface Window {
    __splat?: SplatApi;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * A persisted settings flag (kart idiom). `null` means "never set" — which is
 * NOT false for tablet mode (absent = auto-detect). Storage blocked (private
 * mode) reads as never-set; a blocked write still leaves the toggle live for
 * the session.
 */
function readFlag(key: string): boolean | null {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return null;
    return v === '1' || v === 'true';
  } catch {
    return null;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    // storage unavailable — the toggle still works for this session
  }
}

function loadSession(): SplatSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isObj(parsed) || !str(parsed.playerId) || parsed.playerId === '') return null;
    return {
      playerId: parsed.playerId,
      name: str(parsed.name) ? parsed.name : '',
      roomCode: str(parsed.roomCode) && parsed.roomCode !== '' ? parsed.roomCode : null,
      lastSeq: num(parsed.lastSeq) && parsed.lastSeq >= 0 ? Math.floor(parsed.lastSeq) : 0,
    };
  } catch {
    return null;
  }
}

function saveSession(rec: SplatSession): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(rec));
  } catch {
    // storage unavailable — rejoin still works for the life of the page
  }
}

function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* non-fatal */
  }
}

/** Shortest-arc lerp for wrapped radians (same as the kart interp). */
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d < -Math.PI) d += TWO_PI;
  return a + d * t;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Sample a remote buffer at renderTime: lerp the bracketing pair, snap on
 *  teleports, extrapolate by velocity only up to EXTRAPOLATE_MAX_MS. Velocity
 *  from the snap: yaw 0 = +Z downhill, so vx = sin(yaw)*v, vz = cos(yaw)*v. */
function sampleBuffer(buf: RemoteSample[], renderTime: number): RemoteVisual | null {
  const n = buf.length;
  if (n === 0) return null;
  let lo = -1;
  for (let i = n - 1; i >= 0; i--) {
    const s = buf[i];
    if (s !== undefined && s.t <= renderTime) {
      lo = i;
      break;
    }
  }
  if (lo < 0) {
    const first = buf[0];
    if (first === undefined) return null; // unreachable; satisfies noUncheckedIndexedAccess
    return { x: first.x, z: first.z, yaw: first.yaw, steer: first.steer };
  }
  const a = buf[lo];
  if (a === undefined) return null; // unreachable
  const b = buf[lo + 1];
  if (b === undefined) {
    // at/after the newest sample: short velocity extrapolation, position only
    const k = Math.min(EXTRAPOLATE_MAX_MS, Math.max(0, renderTime - a.t)) / 1000;
    return {
      x: a.x + Math.sin(a.yaw) * a.v * k,
      z: a.z + Math.cos(a.yaw) * a.v * k,
      yaw: a.yaw,
      steer: a.steer,
    };
  }
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (dx * dx + dz * dz > TELEPORT_SQ) {
    return { x: b.x, z: b.z, yaw: b.yaw, steer: b.steer }; // teleport: snap
  }
  const span = b.t - a.t;
  const t = span > 0 ? Math.min(1, Math.max(0, (renderTime - a.t) / span)) : 1;
  return {
    x: a.x + dx * t,
    z: a.z + dz * t,
    yaw: lerpAngle(a.yaw, b.yaw, t),
    steer: a.steer + (b.steer - a.steer) * t,
  };
}

export class SplatApp {
  private ws: WebSocket | null = null;
  private welcomed = false;
  private playerId: string | null = null;
  private screen: 'menu' | 'race' = 'menu';

  // ---- room/race state (server truth arrives via splat_joined + snapshots) ----
  private joined = false;
  private slot = 0;
  private roomCode: string | null = null;
  private phase: Phase = 'lobby';
  private seated = true; // false = late joiner parked at the gate (CONTRACT §4)
  private youSim: SkierSim | null = null; // latest you.sim (fresh parse, never mutated)
  private ownPlace = 0;
  private countdown = 0; // latest snapshot countdown (3..1 during countdown)
  private seatedCount = 0; // snapshot playerCount — server truth for the lobby line
  private minPlayers = MIN_PLAYERS;
  private canStart = false;
  private pendingStart = false; // __splat.startRace() fired before canStart
  private readonly players = new Map<string, SkierSnap>(); // latest snapshot per id
  private readonly roster = new Map<string, RosterEntry>(); // slot -> identity per id

  // ---- net timing ----------------------------------------------------------------
  private offset = 0; // serverNow = Date.now() + offset (rtt/2 estimate, like kart)
  private offsetSet = false; // first fix sets directly; later fixes EMA
  private rttMs = 0;
  private packetsSent = 0;

  // ---- wire seq continuity (header comment) ----------------------------------------
  private seqOffset = 0; // added to every outgoing splat_input seq
  private lastSeqHigh = 0; // highest wire seq actually sent
  private lastAckWire = 0; // highest you.lastProcessedSeq the server reported
  private seqSavedAt = 0; // throttle for session persistence

  // ---- slope + modules (C1/R1/R2/C3/C4 via the frozen §7a seams) -------------------
  private seed = -1; // -1 = no race yet; rebuild terrain on CHANGE (rematch = new mountain)
  private slope: SlopeDef | null = null;
  private drive: DriveController | null = null; // created on join, recreated on seed change, never on reconnect
  private scene: SplatScene | null = null; // null only if WebGL construction failed
  private plants: PlantField | null = null;
  private skiers: SkierVisuals | null = null;
  private fx: SplatFx | null = null;
  private readonly hud: SplatHud;
  private readonly audio = new SplatAudio();
  private resetArmed = false; // first snapshot after (re)join: reset from you.sim

  // ---- remotes ----------------------------------------------------------------------
  private readonly sceneSkierIds = new Set<string>(); // ids currently added to SkierVisuals
  private readonly buffers = new Map<string, RemoteSample[]>(); // per-remote interp history
  private readonly visuals = new Map<string, RemoteVisual>(); // last drawn pose (telemetry)
  private maxCorrectionM = 0; // biggest reconcile this race (reset per race)
  private corrections = 0;

  // ---- presentation state --------------------------------------------------------------
  private lastCountdownBeep = 0; // countdown numeral dedupe (snapshot-driven, 20 Hz)
  private wasFinished = false; // own finish edge (event is primary; snapshot is the fallback)
  private lastFrame = 0;

  // ---- settings (localStorage; tablet tri-state) -----------------------------------------
  private tabletPref: boolean | null = null; // explicit override; null = auto-detect
  private tabletSeen = false; // a coarse/no-hover pointer exists (media query or a real event)
  private lefty = false; // mirrors the HUD chip layout only — never the steering zones
  private assist = false;
  private touchLayerVisible = false; // last written visibility (guarded flip)
  private touchRectsDirty = true;
  private readonly touchZones: { el: HTMLDivElement; side: 'left' | 'right' }[] = [];
  private readonly touchRects: number[] = []; // x0,y0,x1,y1 per zone (layout reads only here)
  private wakeLock: WakeLockSentinel | null = null;

  // ---- DOM handles (built once in the constructor, updated in place) ----------------
  private readonly menuEl: HTMLDivElement;
  private readonly noticeEl: HTMLDivElement;
  private readonly nameInput: HTMLInputElement;
  private readonly codeInput: HTMLInputElement;
  private readonly tabletInput: HTMLInputElement;
  private readonly leftyInput: HTMLInputElement;
  private readonly assistInput: HTMLInputElement;
  private readonly menuButtons: HTMLButtonElement[] = [];
  private readonly raceEl: HTMLDivElement;
  private readonly sceneWrapEl: HTMLDivElement;
  private readonly touchEl: HTMLDivElement;
  private readonly lobbyEl: HTMLDivElement;
  private readonly lobbyCodeEl: HTMLDivElement;
  private readonly lobbyPlayersEl: HTMLDivElement;
  private readonly lobbyStatusEl: HTMLDivElement;
  private readonly lobbyHintEl: HTMLDivElement;
  private readonly startBtn: HTMLButtonElement;
  private readonly netBannerEl: HTMLDivElement;

  // ---- HUD state (reused — the per-frame build allocates nothing) ------------------
  private readonly racerPool: HudRacer[] = [];
  private readonly hudRacers: HudRacer[] = [];
  private readonly colorFor = (slot: number): string => {
    const n = SKIER_COLORS.length;
    return SKIER_COLORS[((slot % n) + n) % n] ?? SPAL.ink;
  };
  private readonly glyphFor = (slot: number): string => {
    const n = SKIER_GLYPHS.length;
    return SKIER_GLYPHS[((slot % n) + n) % n] ?? '';
  };
  private readonly hudState: HudState;

  constructor(root: HTMLElement) {
    this.assist = readFlag(ASSIST_KEY) === true;
    this.tabletPref = readFlag(TABLET_KEY); // null = auto-detect from the pointer
    this.lefty = readFlag(LEFTY_KEY) === true;
    const session = loadSession();
    if (session !== null) {
      // the wire seq must keep counting where the last socket left off
      this.seqOffset = session.lastSeq;
      this.lastSeqHigh = session.lastSeq;
    }
    for (let i = 0; i < MAX_PLAYERS; i++) {
      this.racerPool.push({ slot: i, z: 0, finished: false, finishMs: 0 });
    }
    this.hudState = {
      phase: 'lobby',
      countdown: 0,
      speedKmh: 0,
      place: 0,
      total: 0,
      you: { slot: 0, z: 0, finished: false, finishMs: 0 },
      racers: this.hudRacers,
      results: null,
      colorFor: this.colorFor,
      glyphFor: this.glyphFor,
    };

    // §4.4 / UX_BIBLE: no user-agent sniffing. A coarse pointer with no hover IS
    // a touch device by the only definition the platform gives us; a real
    // touch/pen pointerdown (wired below) arms it too, for hybrids.
    if (typeof window.matchMedia === 'function') {
      const coarse = window.matchMedia('(hover: none) and (pointer: coarse)');
      this.tabletSeen = coarse.matches;
      coarse.addEventListener('change', (e) => {
        this.tabletSeen = this.tabletSeen || e.matches;
        this.syncTouchUi();
      });
    }

    // ---- menu screen ----------------------------------------------------------
    this.menuEl = el('div', 'screen menu');
    this.menuEl.appendChild(el('h1', 'menu-title', 'SKI SPLAT'));
    this.menuEl.appendChild(
      el('p', 'menu-sub', 'first-person downhill racing — dodge the pines, first to the bottom'),
    );
    this.noticeEl = el('div', 'menu-notice hidden');
    this.menuEl.appendChild(this.noticeEl);

    this.nameInput = el('input', 'menu-name');
    this.nameInput.maxLength = NAME_MAX_LEN;
    this.nameInput.placeholder = 'your name';
    this.nameInput.autocomplete = 'off';
    this.nameInput.value = loadName(); // shared across every game on the platform
    this.menuEl.appendChild(this.nameInput);

    const menuActions = el('div', 'menu-actions');
    this.menuButtons.push(
      this.menuButton(menuActions, 'QUICK PLAY', 'btn btn-gold', () => this.joinQuick(this.menuName())),
      this.menuButton(menuActions, 'CREATE PRIVATE', 'btn', () => this.createPrivate(this.menuName())),
    );
    this.menuEl.appendChild(menuActions);

    const codeRow = el('div', 'menu-code');
    this.codeInput = el('input', 'menu-code-input');
    this.codeInput.maxLength = CODE_MAX_LEN;
    this.codeInput.placeholder = 'CODE';
    this.codeInput.autocomplete = 'off';
    codeRow.appendChild(this.codeInput);
    this.menuButtons.push(
      this.menuButton(codeRow, 'JOIN BY CODE', 'btn', () =>
        this.joinPrivate(this.menuName(), this.codeInput.value.trim()),
      ),
    );
    this.menuEl.appendChild(codeRow);

    // invite link (?code=XXXXX): prefill the private-code input (kart convention)
    const linkCode = new URLSearchParams(location.search).get('code');
    if (linkCode !== null && linkCode.trim().length > 0) {
      this.codeInput.value = linkCode.trim().slice(0, CODE_MAX_LEN).toUpperCase();
    }

    // Settings chips. TABLET CONTROLS is a full input surface for any touch
    // player (auto-detected unless decided); LEFT-HANDED mirrors the HUD chip
    // layout only (the steering zones are symmetrical already); ASSIST is the
    // invisible kindness (steer EMA + gentler plants) — toggleable any time.
    const toggles = el('div', 'menu-toggles');
    this.tabletInput = this.toggleChip(toggles, 'TABLET CONTROLS', this.tabletActive(), (on) => {
      this.tabletPref = on;
      writeFlag(TABLET_KEY, on);
      this.syncTouchUi();
    });
    this.leftyInput = this.toggleChip(toggles, 'LEFT-HANDED', this.lefty, (on) => {
      this.lefty = on;
      writeFlag(LEFTY_KEY, on);
      this.syncTouchUi();
    });
    this.assistInput = this.toggleChip(toggles, 'ASSIST', this.assist, (on) => this.setAssist(on));
    this.menuEl.appendChild(toggles);

    // ---- race screen ----------------------------------------------------------
    this.raceEl = el('div', 'screen race hidden');
    this.sceneWrapEl = el('div', 'race-scene');
    this.raceEl.appendChild(this.sceneWrapEl);

    // The two-zone tablet control surface (UX_BIBLE "Input"): left half steers
    // left, right half steers right, both or neither = straight. Built once,
    // appended BEFORE the lobby overlay so the overlay's buttons always paint
    // (and tap) over it; invisible unless tablet mode is live AND racing.
    this.touchEl = el('div', 'touch-layer hidden');
    const zoneL = el('div', 'touch-zone touch-zone-left');
    zoneL.appendChild(el('div', 'touch-thumb touch-thumb-left'));
    const zoneR = el('div', 'touch-zone touch-zone-right');
    zoneR.appendChild(el('div', 'touch-thumb touch-thumb-right'));
    this.touchEl.appendChild(zoneL);
    this.touchEl.appendChild(zoneR);
    this.touchZones.push({ el: zoneL, side: 'left' }, { el: zoneR, side: 'right' });
    this.raceEl.appendChild(this.touchEl);

    // lobby overlay: room code, the roster (colour + glyph + name), explicit START
    this.lobbyEl = el('div', 'lobby-overlay hidden');
    const lobbyPanel = el('div', 'lobby-panel');
    lobbyPanel.appendChild(el('div', 'lobby-title', 'SLOPE'));
    this.lobbyCodeEl = el('div', 'lobby-code hidden');
    lobbyPanel.appendChild(this.lobbyCodeEl);
    this.lobbyPlayersEl = el('div', 'lobby-players');
    lobbyPanel.appendChild(this.lobbyPlayersEl);
    this.lobbyStatusEl = el('div', 'lobby-status', '');
    lobbyPanel.appendChild(this.lobbyStatusEl);
    // START: the room never auto-starts. Any seated player may press it; it is
    // disabled (with the reason on .lobby-status right above) below canStart.
    this.startBtn = el('button', 'btn btn-gold lobby-start', 'START');
    this.startBtn.addEventListener('click', () => {
      this.audio.resume();
      this.startBtn.blur(); // keep arrows off the focused button once racing
      if (this.canStart) this.send({ t: 'start' });
    });
    lobbyPanel.appendChild(this.startBtn);
    const leaveBtn = el('button', 'btn btn-small lobby-leave', 'LEAVE');
    leaveBtn.addEventListener('click', () => {
      this.audio.resume();
      leaveBtn.blur();
      this.leaveToMenu('');
    });
    lobbyPanel.appendChild(leaveBtn);
    this.lobbyHintEl = el('div', 'lobby-hint', '');
    lobbyPanel.appendChild(this.lobbyHintEl);
    this.lobbyEl.appendChild(lobbyPanel);
    this.raceEl.appendChild(this.lobbyEl);

    this.netBannerEl = el('div', 'net-banner hidden', 'Connection lost — rejoining…');

    root.appendChild(this.menuEl);
    root.appendChild(this.raceEl);
    root.appendChild(this.netBannerEl);

    // ---- scene + frozen modules ------------------------------------------------
    // WebGL construction can fail (no context, blocked GPU): the app must still
    // boot to a readable error, never a white screen (CONTRACT §2.8).
    try {
      this.scene = new SplatScene(this.sceneWrapEl);
      this.skiers = new SkierVisuals(this.scene.world);
      this.fx = new SplatFx(this.scene.world);
      // R2 documents the own-skis rig as CAMERA-space: `camera.add(ownSkisRig)`
      // ONCE — the skis ride the first-person camera (SplatScene exposes the
      // camera via §7a and adds it to the world, so its children render).
      this.scene.camera.add(this.skiers.ownSkisRig);
    } catch (err) {
      this.scene = null;
      this.skiers = null;
      this.fx = null;
      this.showBootError(
        `3D unavailable: ${err instanceof Error ? err.message : String(err)} — try another browser`,
      );
    }
    this.hud = new SplatHud(this.raceEl);

    // ---- listeners --------------------------------------------------------------
    window.addEventListener('resize', () => {
      if (this.screen === 'race') this.scene?.resize();
      this.touchRectsDirty = true; // the zones moved: cached rects are lies now
    });
    window.addEventListener('orientationchange', () => {
      this.touchRectsDirty = true;
    });
    // blur clears held input (drive.ts clears keys + touch internally); the app
    // half clears the zone paint and re-measures on return.
    window.addEventListener('blur', () => this.clearTouchPaint());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') {
        this.clearTouchPaint();
      } else if (this.screen === 'race') {
        void this.acquireWakeLock(); // the lock is dropped whenever we are hidden
      }
    });
    // the seq watermark outlives the page only if it is persisted on the way out
    window.addEventListener('pagehide', () => this.persistSession());

    // ---- tablet layer: pointer wiring (kart pad discipline) --------------------
    // Pointer Events, never Touch Events, keyed by pointerId. The listeners live
    // on the LAYER, not the zones: a touch pointer is implicitly captured by the
    // element it went down on, so sliding between halves is resolved against
    // cached rects, never e.target.
    const layer = this.touchEl;
    layer.addEventListener('pointerdown', (e: PointerEvent) => {
      this.armTablet(e.pointerType);
      const side = this.hitTest(e.clientX, e.clientY);
      e.preventDefault(); // no scroll, no synthetic click, no text selection
      this.drive?.touch.press(e.pointerId, side);
      this.audio.resume(); // the first race touch may be the page's only gesture (iOS)
      this.paintTouch();
    });
    layer.addEventListener('pointermove', (e: PointerEvent) => {
      if ((this.drive?.touch.count() ?? 0) === 0) return; // a hovering mouse must not steer
      const side = this.hitTest(e.clientX, e.clientY);
      this.drive?.touch.retarget(e.pointerId, side);
      this.paintTouch();
    });
    // pointerup, pointercancel (system interruption mid-press) and lost capture
    // all release identically — a zone left latched is the worst failure this
    // control scheme has.
    const releasePointer = (e: PointerEvent): void => {
      this.drive?.touch.release(e.pointerId);
      this.paintTouch();
    };
    layer.addEventListener('pointerup', releasePointer);
    layer.addEventListener('pointercancel', releasePointer);
    layer.addEventListener('lostpointercapture', releasePointer);
    // Auto-detect: the first REAL touch/pen pointer anywhere arms tablet mode
    // (capture phase, so a tap on a menu button arms it before the click).
    window.addEventListener(
      'pointerdown',
      (e: PointerEvent) => this.armTablet(e.pointerType),
      { capture: true, passive: true },
    );
    // audio.resume() on EVERY gesture (idempotent; browsers gate AudioContext)
    window.addEventListener('pointerdown', () => this.audio.resume(), { capture: true, passive: true });
    window.addEventListener('keydown', () => this.audio.resume(), { capture: true });

    // ---- timers (setInterval for net: rAF pauses in background tabs) ---------------
    window.setInterval(() => {
      if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
        this.send({ t: 'ping', ts: performance.now() });
      }
    }, PING_EVERY_MS);
    window.setInterval(() => this.watchdog(), WATCHDOG_MS);

    this.lastFrame = performance.now();
    requestAnimationFrame(this.frameBound);

    // ---- frozen e2e debug surface ---------------------------------------------------
    window.__splat = {
      state: () => this.debugState(),
      telemetry: () => this.telemetrySnapshot(),
      joinQuick: (name) => this.joinQuick(name),
      startRace: (seed?: number) => this.debugStartRace(seed),
      setInput: (steer) => this.drive?.setInput(steer),
    };

    this.syncTouchUi(); // layer + layout classes; a no-op on a desktop pointer
    this.connect();
    this.renderMenu();
  }

  // ---- connection ---------------------------------------------------------------
  private connect(): void {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      window.setTimeout(() => this.connect(), RECONNECT_MS);
      return;
    }
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws || typeof ev.data !== 'string') return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(ev.data);
      } catch {
        return; // malformed frame: drop, never throw
      }
      try {
        const msg = parseS2C(decoded);
        if (msg !== null) this.onMessage(msg);
      } catch (err) {
        // one bad message never kills the client (CONTRACT §2.8)
        console.warn('[splat] message handler failed', err);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // stale socket from a previous connect()
      this.ws = null;
      this.welcomed = false;
      if (this.joined || this.screen === 'race') {
        // mid-room drop: keep the screen + the session, show the banner, retry.
        // The DriveController instance SURVIVES (its wire seq must keep counting
        // for the rebind — see the header); prediction resumes from you.sim.
        this.netBannerEl.classList.remove('hidden');
        this.clearTouchPaint();
      } else {
        this.showMenu('');
      }
      this.renderMenu();
      window.setTimeout(() => this.connect(), RECONNECT_MS);
    };
    ws.onerror = () => {
      // the close event follows and does the teardown
    };
  }

  /** No-op unless the socket is open (mirrors the server's Session.send). */
  private send(msg: LobbyC2S | SplatC2S): void {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(msg)); // the wire is plain JSON
    } catch {
      // racing a close — drop the frame
    }
  }

  private serverNow(): number {
    return Date.now() + this.offset;
  }

  // ---- lobby actions (game filter 'splat' on every create/join) --------------------
  /**
   * Stamp identity on every outgoing join: `sig` always (the durable per-browser
   * signature — @platform/shared), `resume` when a dropped splat session exists
   * (the LAST socket's playerId — the exact rebind the room tries first).
   */
  private withIdentity<T extends LobbyC2S>(msg: T): T {
    const resume = loadSession()?.playerId;
    return resume !== undefined ? { ...msg, sig: loadSig(), resume } : { ...msg, sig: loadSig() };
  }

  private joinQuick(name: string): void {
    const clean = cleanName(name);
    saveName(clean);
    const msg: Extract<LobbyC2S, { t: 'quick_join' }> = { t: 'quick_join', name: clean, game: 'splat' };
    this.send(this.withIdentity(msg));
  }

  /** seed is the dev/e2e slope override (room settings {seed}); absent otherwise. */
  private createPrivate(name: string, seed?: number): void {
    const clean = cleanName(name);
    saveName(clean);
    const msg: Extract<LobbyC2S, { t: 'create_private' }> = {
      t: 'create_private',
      name: clean,
      game: 'splat',
    };
    if (seed !== undefined) msg.settings = { seed: Math.floor(seed) };
    this.send(this.withIdentity(msg));
  }

  private joinPrivate(name: string, code: string): void {
    const c = code.trim();
    if (c.length === 0) {
      this.setNotice('enter a room code first');
      return;
    }
    const clean = cleanName(name);
    saveName(clean);
    const msg: Extract<LobbyC2S, { t: 'join_private' }> = { t: 'join_private', name: clean, code: c };
    this.send(this.withIdentity(msg));
  }

  // ---- message routing -------------------------------------------------------------
  private onMessage(msg: S2C): void {
    switch (msg.t) {
      case 'welcome': {
        this.playerId = msg.playerId;
        this.welcomed = true;
        // Auto-rejoin: 'welcome' is the first message on EVERY connection — fresh
        // boot and post-drop reconnect alike — so a stored session re-enters the
        // room with no click. The stored playerId is the DROPPED socket's id; it
        // goes out as `resume` (via withIdentity) and is only replaced by this
        // socket's id once splat_joined confirms the seat.
        const session = loadSession();
        if (session !== null) {
          const name = cleanName(session.name !== '' ? session.name : loadName());
          if (session.roomCode !== null) this.joinPrivate(name, session.roomCode);
          else this.joinQuick(name);
        }
        this.renderMenu();
        break;
      }
      case 'pong': {
        const rtt = performance.now() - msg.ts;
        if (rtt >= 0) {
          this.rttMs = rtt;
          const measured = msg.serverTime + rtt / 2 - Date.now();
          // EMA, never replacement: a single rtt spike must not jump the shared
          // render time base — every remote skier would visibly lurch.
          this.offset = this.offsetSet
            ? this.offset + (measured - this.offset) * OFFSET_EMA
            : measured;
          this.offsetSet = true;
        }
        break;
      }
      case 'error':
        // 'no_room' is the server confirming the stored rejoin pointer is dead
        // (reaped room / stale code) — NOT a transport hiccup. Clear it so the
        // next 'welcome' stops retrying the corpse; any other error leaves the
        // session alone (that is exactly what resume is for).
        if (msg.code === 'no_room') clearSession();
        if (this.screen === 'menu') this.setNotice(msg.message);
        break;
      case 'splat_joined':
        this.onJoined(msg);
        break;
      case 'splat_roster':
        this.roster.clear();
        for (const entry of msg.players) this.roster.set(entry.id, entry);
        this.renderLobbyList();
        break;
      case 'splat_snapshot':
        this.onSnapshot(msg);
        break;
      case 'splat_event':
        this.onEvent(msg.ev);
        break;
    }
  }

  // ---- join / leave -------------------------------------------------------------------
  private onJoined(msg: SplatJoined): void {
    this.joined = true;
    this.slot = msg.slot;
    this.roomCode = msg.code;
    this.phase = msg.phase; // set directly — joining is not a phase TRANSITION
    this.seated = msg.phase === 'lobby'; // late joiner: parked until a snapshot seats them
    this.youSim = null;
    this.ownPlace = 0;
    this.countdown = 0;
    this.seatedCount = msg.players.length; // until the first snapshot lands
    this.canStart = false; // the server decides; a stale true would lie for a frame
    this.players.clear();
    this.roster.clear();
    for (const entry of msg.players) this.roster.set(entry.id, entry);
    this.buffers.clear();
    this.visuals.clear();
    this.clearSceneSkiers();
    this.maxCorrectionM = 0;
    this.corrections = 0;
    this.lastCountdownBeep = 0;
    this.wasFinished = false;
    this.resetArmed = true; // first snapshot resets the predictor from you.sim
    // Record the rejoin pointer: welcome always precedes splat_joined, so
    // this.playerId is THIS socket's id — a reload/drop resumes from here.
    if (this.playerId !== null) {
      saveSession({
        playerId: this.playerId,
        name: cleanName(loadName()),
        roomCode: msg.code,
        lastSeq: Math.max(this.lastSeqHigh, this.lastAckWire),
      });
    }
    // A mid-race join carries the live seed: build the mountain immediately so
    // the waiting screen has the world behind it. The predictor re-bases from
    // the first snapshot's you.sim (resetArmed).
    if (msg.seed !== -1 && msg.seed !== this.seed) this.rebuildSlope(msg.seed, null);
    if (this.drive === null) {
      // Fresh-lobby join (seed -1, no mountain yet): the predictor must still
      // EXIST — its outbox/seq machinery is the lobby keepalive, and the
      // server's INPUT_STALE_MS sweep evicts idle seats in any phase. A
      // stand-in slope is enough: outside racing the server consumes-but-
      // doesn't-integrate, resetArmed re-bases from the first snapshot's
      // you.sim, and the first real seed rebuilds the drive (rebuildSlope
      // carries the wire seq via seqOffset).
      this.drive = new DriveController(genSlope(0));
    }
    this.drive?.setAssist(this.assist);
    if (this.assist) this.send({ t: 'splat_assist', on: true }); // stored per player, never broadcast
    this.netBannerEl.classList.add('hidden');
    this.renderLobbyList();
    this.showRace();
    this.syncLobby();
  }

  private leaveToMenu(notice: string): void {
    this.send({ t: 'leave' });
    clearSession(); // explicit leave — never on a drop, which keeps the pointer
    this.resetRoom();
    this.showMenu(notice);
  }

  /** Drops all per-room state (leave shares this with nothing — drops keep state). */
  private resetRoom(): void {
    this.joined = false;
    this.youSim = null;
    this.phase = 'lobby';
    this.seated = true;
    this.roomCode = null;
    this.ownPlace = 0;
    this.countdown = 0;
    this.seatedCount = 0;
    this.minPlayers = MIN_PLAYERS;
    this.canStart = false;
    this.pendingStart = false;
    this.players.clear();
    this.roster.clear();
    this.buffers.clear();
    this.visuals.clear();
    this.clearSceneSkiers();
    this.drive?.touch.clear();
    this.drive?.setInput(0); // the debug latch does not follow us out of the room
    this.audio.wind(0);
    this.audio.carve(0);
    this.lastCountdownBeep = 0;
    this.wasFinished = false;
  }

  // ---- slope lifecycle ----------------------------------------------------------------
  /**
   * A new mountain. Rebuilds the terrain mesh, the plant field and the
   * DriveController (the predictor is per-slope), then parks the predictor at
   * `sim` (the grid on a countdown-entry snapshot; the origin on a bare join,
   * re-based by the first snapshot's you.sim via resetArmed). The wire seq
   * keeps counting across the recreation via seqOffset — see the header.
   */
  private rebuildSlope(seed: number, sim: SkierSim | null): void {
    this.seed = seed;
    const slope = genSlope(seed);
    this.slope = slope;
    if (this.scene !== null) {
      this.scene.buildTerrain(slope); // idempotent, disposes the prior mountain
      this.plants = new PlantField(this.scene.world, slope);
    } else {
      this.plants = null;
    }
    const old = this.drive;
    if (old !== null) old.dispose(); // keyboard/blur listeners
    this.seqOffset = Math.max(this.seqOffset, this.lastSeqHigh, this.lastAckWire);
    this.drive = new DriveController(slope);
    this.drive.setAssist(this.assist);
    const at = sim ?? { x: 0, z: 0, yaw: 0 };
    this.drive.reset(at.x, at.z, at.yaw);
  }

  // ---- snapshots -----------------------------------------------------------------------
  private onSnapshot(snap: SplatSnapshot): void {
    if (!this.joined) return; // stale room traffic after a leave

    // SLOPE LIFECYCLE: the seed rides every snapshot and changes at countdown
    // entry (rematch = new mountain). It also stays on the previous race's seed
    // after results->lobby, so -1 is "never raced" and ONLY a change rebuilds.
    const seedChanged = snap.seed !== -1 && snap.seed !== this.seed;
    if (seedChanged) this.rebuildSlope(snap.seed, snap.you.sim);

    const prevPhase = this.phase;
    this.phase = snap.phase;
    this.youSim = snap.you.sim;
    this.countdown = snap.phase === 'countdown' ? snap.countdown : 0;
    this.seatedCount = snap.playerCount;
    this.minPlayers = snap.minPlayers;
    this.canStart = snap.canStart;
    // Late joiners are excluded from players[] until the next countdown seats
    // them; a lobby-phase room lists everyone parked at the gate.
    this.seated = snap.players.some((p) => p.id === this.playerId);

    if (snap.phase !== prevPhase) this.onPhaseChange(prevPhase, snap.phase, snap.you.sim, seedChanged);

    // First snapshot after a (re)join: the predictor re-bases from you.sim.
    // On a rebind this is THE restore path — the seat's sim kept skiing while
    // the socket was down.
    if (this.resetArmed && this.drive !== null) {
      this.resetArmed = false;
      this.drive.reset(snap.you.sim.x, snap.you.sim.z, snap.you.sim.yaw);
    }

    // AUTHORITATIVE OWN STATE — exactly once per snapshot, from the `you` block.
    // The ack arrives in wire-seq space; reconcile speaks drive-seq space.
    const ackWire = snap.you.lastProcessedSeq;
    if (ackWire > this.lastAckWire) {
      this.lastAckWire = ackWire;
      this.persistSessionThrottled();
    }
    if (this.drive !== null) {
      const corr = this.drive.reconcile(snap.you.sim, Math.max(0, ackWire - this.seqOffset));
      if (corr > CORRECTION_EPS_M) {
        this.corrections += 1;
        if (corr > this.maxCorrectionM) this.maxCorrectionM = corr;
      }
    }

    const seen = new Set<string>();
    let rosterDirty = false;
    let ownPlace = 0;
    for (const p of snap.players) {
      seen.add(p.id);
      this.players.set(p.id, p);
      if (p.id === this.playerId) {
        ownPlace = p.place;
        continue; // our own skier is predicted, never interpolated
      }
      if (!this.roster.has(p.id)) rosterDirty = true; // a racer we cannot name yet
      this.ensureSkier(p.id, p.slot);
      this.pushRemote(p, snap.serverTime);
    }
    this.ownPlace = ownPlace;
    for (const id of [...this.players.keys()]) {
      if (!seen.has(id) && id !== this.playerId) {
        // gone from the racer list (the results sweep after player_left)
        this.players.delete(id);
        this.buffers.delete(id);
        this.visuals.delete(id);
        this.removeSkier(id);
        rosterDirty = true;
      }
    }
    if (rosterDirty) this.renderLobbyList();

    // countdown numerals ride the snapshot at 20 Hz (no countdown events on the
    // wire) — beep on each new numeral
    if (snap.phase === 'countdown' && snap.countdown > 0) {
      const n = Math.ceil(snap.countdown);
      if (n !== this.lastCountdownBeep) {
        this.lastCountdownBeep = n;
        this.audio.sfx('beep');
      }
    }

    // own finish edge: the event is primary, this is the lost-event fallback
    if (snap.you.sim.finished && !this.wasFinished) {
      this.wasFinished = true;
      this.onOwnFinish(snap.you.sim);
    }

    if (this.pendingStart && this.canStart) {
      this.pendingStart = false;
      this.send({ t: 'start' });
    }
    this.syncLobby();
  }

  private onPhaseChange(prev: Phase, next: Phase, sim: SkierSim, seedChanged: boolean): void {
    if (next === 'countdown' && prev !== 'countdown') {
      // a new race: per-race locals clear, and the predictor parks on the grid.
      // A seed change already rebuilt + reset the drive from this very sim.
      this.buffers.clear();
      this.visuals.clear();
      this.maxCorrectionM = 0;
      this.corrections = 0;
      this.lastCountdownBeep = 0;
      this.wasFinished = false;
      if (!seedChanged && this.drive !== null) {
        // fixed-seed room (settings {seed}) rematch: same mountain, fresh grid
        this.drive.reset(sim.x, sim.z, sim.yaw);
      }
    }
    if (prev === 'countdown' && next === 'racing') {
      this.audio.sfx('go');
      this.hud.showSteerHint(); // first race only (C3 gates it on localStorage)
      void this.acquireWakeLock();
    }
    if (next === 'results') this.audio.sfx('sting');
    this.syncTouchUi(); // the steer layer is up from the countdown, down in results
  }

  // ---- events ---------------------------------------------------------------------------
  private onEvent(ev: SplatEvent): void {
    switch (ev.t) {
      case 'plant_hit': {
        const y = this.slope?.height(ev.x, ev.z) ?? 0;
        this.plants?.hitPlant(ev.plantIx); // squash/shake; the plant is not consumed
        this.fx?.burst('puff', ev.x, y, ev.z);
        if (ev.id === this.playerId) {
          this.scene?.plantHit(); // the dip spring — own hits are felt, not read
          this.audio.sfx('rustle');
        } else {
          const s = this.drive?.state();
          const dist = s !== undefined ? Math.hypot(ev.x - s.x, ev.z - s.z) : 0;
          this.audio.sfx('rustle', { distance: Math.round(dist) });
        }
        break;
      }
      case 'finished':
        if (ev.id === this.playerId) {
          if (!this.wasFinished) {
            this.wasFinished = true;
            this.onOwnFinish(null);
          }
        } else {
          const remote = this.players.get(ev.id);
          const s = this.drive?.state();
          const dist =
            remote !== undefined && s !== undefined
              ? Math.hypot(remote.x - s.x, remote.z - s.z)
              : 0;
          this.audio.sfx('finish', { distance: Math.round(dist) });
        }
        break;
      case 'player_left':
        // ghosts are swept at results; the visual + interp state go with them
        this.players.delete(ev.id);
        this.roster.delete(ev.id);
        this.buffers.delete(ev.id);
        this.visuals.delete(ev.id);
        this.removeSkier(ev.id);
        this.renderLobbyList();
        break;
    }
  }

  /** Own finish: banner rides the HUD state; here the fanfare + the confetti. */
  private onOwnFinish(sim: SkierSim | null): void {
    this.audio.sfx('finish');
    const s = this.drive?.state() ?? sim;
    if (s !== null && this.slope !== null) {
      this.fx?.burst('confetti', s.x, this.slope.height(s.x, s.z) + 1, s.z);
    }
  }

  // ---- splat_input stream ------------------------------------------------------------------
  /**
   * Re-stamp and send one input. The seq is lifted into session-monotonic
   * space (seqOffset — see the header) by mutating drive's outbox entry in
   * place: drive drops the reference the moment flush() returns and the
   * predictor queued copies, so this allocates nothing and corrupts nothing.
   */
  private readonly sendInput = (m: SplatC2S): void => {
    if (m.t === 'splat_input') {
      const w = m as { seq: number };
      w.seq += this.seqOffset;
      if (w.seq > this.lastSeqHigh) this.lastSeqHigh = w.seq;
      this.packetsSent += 1;
    }
    this.send(m);
  };

  /** rAF pauses in background tabs: keep the sim + the input stream alive at a
   *  slow clip (well under INPUT_STALE_MS). Never double-steps while rAF runs.
   *  Every phase, like the frame loop — the lobby sweep does not care that the
   *  tab is backgrounded. */
  private watchdog(): void {
    if (this.screen !== 'race' || !this.joined) return;
    if (performance.now() - this.lastFrame <= FRAME_STALE_MS) return;
    this.drive?.step(WATCHDOG_MS);
    this.drive?.flush(this.sendInput);
  }

  // ---- assist (the invisible kindness — toggleable any time, incl. mid-race) ------
  private setAssist(on: boolean): void {
    this.assist = on;
    this.assistInput.checked = on;
    this.drive?.setAssist(on);
    writeFlag(ASSIST_KEY, on);
    if (this.joined) this.send({ t: 'splat_assist', on }); // stored per player, never broadcast
  }

  // ---- tablet mode (two steering halves, UX_BIBLE "Input") ----------------------------

  /** Is the touch layer live? Explicit setting wins; otherwise the pointer decides. */
  private tabletActive(): boolean {
    return this.tabletPref ?? this.tabletSeen;
  }

  /** A real touch/pen pointer proves this is a touch device (never the user agent). */
  private armTablet(pointerType: string): void {
    if (this.tabletSeen || (pointerType !== 'touch' && pointerType !== 'pen')) return;
    this.tabletSeen = true;
    this.syncTouchUi();
  }

  /**
   * Reconcile every touch-shaped piece of the DOM with the settings: the layout
   * classes the stylesheet keys off, the layer's visibility, the settings chips
   * and the lobby hint. LEFT-HANDED mirrors the HUD chips (stylesheet), never
   * the zones — left half is steer-left for everyone. Cheap and idempotent.
   */
  private syncTouchUi(): void {
    const on = this.tabletActive();
    const cls = this.raceEl.classList;
    cls.toggle('tablet', on);
    cls.toggle('lefty', this.lefty);
    this.tabletInput.checked = on;
    this.leftyInput.checked = this.lefty;
    // The layer is up only while the slope is steerable. It stays DOWN in the
    // lobby and on the results screen: those overlays own the taps.
    const visible =
      on &&
      this.screen === 'race' &&
      this.seated &&
      (this.phase === 'countdown' || this.phase === 'racing');
    if (visible !== this.touchLayerVisible) {
      this.touchLayerVisible = visible;
      this.touchEl.classList.toggle('hidden', !visible);
      this.touchRectsDirty = true;
      if (!visible) {
        this.drive?.touch.clear();
        this.paintTouch();
      }
    }
    const hint = on
      ? 'HOLD THE LEFT OR RIGHT HALF TO STEER'
      : '← / → or A / D to steer';
    if (this.lobbyHintEl.textContent !== hint) this.lobbyHintEl.textContent = hint;
  }

  /** Re-measure the zones. Layout read only — never inside a pointermove. */
  private measureZones(): void {
    const r = this.touchRects;
    r.length = 0;
    for (const z of this.touchZones) {
      const box = z.el.getBoundingClientRect();
      r.push(box.left, box.top, box.right, box.bottom);
    }
    this.touchRectsDirty = false;
  }

  /** Which steering half a viewport point is on (null = dead space). Rect-based
   *  because a touch pointer's moves are captured by its first element. */
  private hitTest(x: number, y: number): 'left' | 'right' | null {
    if (this.touchRectsDirty) this.measureZones();
    const r = this.touchRects;
    for (let i = 0; i < this.touchZones.length; i++) {
      const x0 = r[i * 4] ?? 0;
      const y0 = r[i * 4 + 1] ?? 0;
      const x1 = r[i * 4 + 2] ?? 0;
      const y1 = r[i * 4 + 3] ?? 0;
      if (x1 <= x0 || y1 <= y0) continue; // hidden zone: zero-area, never hit
      if (x >= x0 && x < x1 && y >= y0 && y < y1) return this.touchZones[i]?.side ?? null;
    }
    return null;
  }

  /** Mirror the held set onto the zones (pressed look). Event-driven, not per frame. */
  private paintTouch(): void {
    const touch = this.drive?.touch;
    for (const z of this.touchZones) {
      z.el.classList.toggle('is-down', touch?.isDown(z.side) === true);
    }
  }

  /** Blur / tab hide: nothing may look (or be) held. drive.ts clears the state. */
  private clearTouchPaint(): void {
    this.paintTouch();
  }

  /** Screen Wake Lock while a race is live; silently absent where unsupported. */
  private async acquireWakeLock(): Promise<void> {
    if (this.wakeLock !== null || !('wakeLock' in navigator)) return;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (this.screen !== 'race') {
        void lock.release().catch(() => undefined); // we left while the request was in flight
        return;
      }
      this.wakeLock = lock;
      lock.addEventListener('release', () => {
        if (this.wakeLock === lock) this.wakeLock = null;
      });
    } catch {
      // denied / unsupported / not visible — a race without it is still a race
    }
  }

  private releaseWakeLock(): void {
    const lock = this.wakeLock;
    if (lock === null) return;
    this.wakeLock = null;
    void lock.release().catch(() => undefined);
  }

  // ---- frame loop (sim + render; net runs on flush + setInterval) --------------------
  private readonly frameBound = (now: number): void => this.frame(now);

  private frame(now: number): void {
    const dtMs = Math.min(MAX_FRAME_DT_MS, Math.max(0, now - this.lastFrame));
    this.lastFrame = now;
    const dt = dtMs / 1000;
    if (this.screen === 'race') {
      const drive = this.drive;
      const slope = this.slope;
      // step + flush in EVERY phase (the kart pattern): outside racing the
      // server consumes-but-doesn't-integrate (the pre-GO freeze still acks),
      // and the steady input stream is the liveness the INPUT_STALE_MS lobby
      // sweep looks for — a seat with no room-bound input for 10s is evicted,
      // racing or not. The predictor's idle creep is re-based by the next
      // snapshot's reconcile (and the countdown-entry grid wipe) before it
      // can show on screen.
      if (this.joined && drive !== null) {
        drive.step(dtMs);
        drive.flush(this.sendInput);
      }
      if (this.joined && this.seated && drive !== null && slope !== null) {
        const s = drive.state(); // module scratch — consume, never retain
        const cx = s.x + drive.errorX(); // the visual error offset is a CAMERA
        const cz = s.z + drive.errorZ(); // channel only (drive.ts header)
        // setCamera takes FEET height — R1 adds EYE_HEIGHT (+ dip) itself
        const cy = slope.height(cx, cz);
        this.scene?.setCamera(cx, cy, cz, s.yaw, s.v, drive.steerVisual(), dt);
        this.skiers?.setOwnSkis(drive.steerVisual(), s.v, dt);
        this.updateRemotes(slope, dt);
        this.plants?.update(dt, cz);
        this.fx?.update(dt, cx, cz);
        this.audio.wind(clamp01(s.v / MAX_SPEED));
        this.audio.carve(clamp01(Math.abs(drive.steerVisual()) * (s.v / MAX_SPEED)));
      } else {
        this.audio.wind(0);
        this.audio.carve(0);
      }
      this.updateHud();
      this.scene?.render();
    } else {
      // Menu frames pay the race's first-render bill a slice at a time (kart
      // idiom): shader compiles + first uploads into the hidden canvas.
      this.scene?.prewarm();
    }
    requestAnimationFrame(this.frameBound);
  }

  private updateRemotes(slope: SlopeDef, dt: number): void {
    const renderTime = this.serverNow() - INTERP_DELAY_MS;
    for (const [id, buf] of this.buffers) {
      const v = sampleBuffer(buf, renderTime);
      if (v === null) continue;
      this.visuals.set(id, v);
      // y is never on the wire: a skier rides the terrain (their x,z are truth)
      this.skiers?.update(id, v.x, slope.height(v.x, v.z), v.z, v.yaw, v.steer, dt);
    }
  }

  // ---- HUD (the whole state is built here, change-guarded inside C3) ----------------
  private updateHud(): void {
    const hs = this.hudState;
    const seated = this.seated;
    // a waiting late joiner watches the lobby, not a HUD for a race they are
    // not in — the HUD reads 'lobby' and stands down
    hs.phase = seated ? this.phase : 'lobby';
    hs.countdown = this.countdown;
    const s = this.drive?.state();
    hs.speedKmh = s !== undefined ? s.v * 3.6 : 0;
    hs.place = this.ownPlace;
    hs.total = Math.max(this.players.size, this.ownPlace);
    const you = hs.you;
    you.slot = this.slot;
    you.z = s !== undefined ? s.z : (this.youSim?.z ?? 0);
    you.finished = this.youSim?.finished ?? false;
    you.finishMs = this.youSim?.finishMs ?? 0;
    const racers = this.hudRacers;
    racers.length = 0;
    for (const p of this.players.values()) {
      const r = this.racerPool[((p.slot % MAX_PLAYERS) + MAX_PLAYERS) % MAX_PLAYERS];
      if (r === undefined) continue;
      r.slot = p.slot;
      r.z = p.z;
      r.finished = p.finished;
      r.finishMs = p.finishMs;
      racers.push(r);
    }
    hs.racers = racers;
    // results bars only exist in the results phase (finished by time, the rest
    // "on the mountain" with distance covered — C3 renders, no shame)
    hs.results = this.phase === 'results' && seated ? racers : null;
    this.hud.render(hs);
  }

  // ---- remote bookkeeping ---------------------------------------------------------------
  private ensureSkier(id: string, slot: number): void {
    if (this.sceneSkierIds.has(id)) return;
    this.skiers?.add(id, slot);
    this.sceneSkierIds.add(id);
  }

  private removeSkier(id: string): void {
    if (!this.sceneSkierIds.delete(id)) return;
    this.skiers?.remove(id);
  }

  private clearSceneSkiers(): void {
    for (const id of this.sceneSkierIds) this.skiers?.remove(id);
    this.sceneSkierIds.clear();
  }

  private pushRemote(p: SkierSnap, time: number): void {
    let buf = this.buffers.get(p.id);
    if (buf === undefined) {
      buf = [];
      this.buffers.set(p.id, buf);
    }
    const sample: RemoteSample = { t: time, x: p.x, z: p.z, yaw: p.yaw, v: p.v, steer: p.steer };
    const last = buf[buf.length - 1];
    if (last !== undefined && time < last.t) return; // out-of-order: drop (the next snapshot self-heals)
    if (last !== undefined && time === last.t) buf[buf.length - 1] = sample; // duplicate tick: newest wins
    else buf.push(sample);
    // evict beyond ~1s of history, keeping one older entry for bracketing
    while (buf.length > 2) {
      const second = buf[1];
      if (second === undefined || second.t > time - BUFFER_KEEP_MS) break;
      buf.shift();
    }
  }

  // ---- screens --------------------------------------------------------------------------------
  private showMenu(notice: string): void {
    this.screen = 'menu';
    this.raceEl.classList.add('hidden');
    this.menuEl.classList.remove('hidden');
    this.netBannerEl.classList.add('hidden');
    this.setNotice(notice);
    this.renderMenu();
    this.syncTouchUi(); // the layer comes down with the race screen
    this.releaseWakeLock(); // ...and the screen may sleep again
  }

  private showRace(): void {
    this.screen = 'race';
    this.menuEl.classList.add('hidden');
    this.raceEl.classList.remove('hidden');
    this.scene?.resize(); // the canvas was display:none — measurable only now
    this.syncTouchUi(); // zone geometry is measurable only now, too
    void this.acquireWakeLock(); // a screen that sleeps mid-race is blamed on the game
  }

  // ---- menu rendering ---------------------------------------------------------------------------
  private menuName(): string {
    return cleanName(this.nameInput.value);
  }

  private menuButton(
    parent: HTMLElement,
    label: string,
    className: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = el('button', className, label);
    btn.addEventListener('click', () => {
      this.audio.resume(); // browsers gate AudioContext on a user gesture
      onClick();
    });
    parent.appendChild(btn);
    return btn;
  }

  /** One compact settings chip in the menu's toggle row (the kart pill idiom). */
  private toggleChip(
    parent: HTMLElement,
    label: string,
    checked: boolean,
    onChange: (on: boolean) => void,
  ): HTMLInputElement {
    const row = el('label', 'menu-toggle');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => {
      this.audio.resume();
      onChange(input.checked);
    });
    row.appendChild(input);
    row.appendChild(el('span', 'menu-toggle-label', label));
    parent.appendChild(row);
    return input;
  }

  private setNotice(text: string): void {
    this.noticeEl.textContent = text;
    this.noticeEl.classList.toggle('hidden', text.length === 0);
  }

  private renderMenu(): void {
    for (const btn of this.menuButtons) btn.disabled = !this.welcomed;
  }

  // ---- lobby (room code + roster + the explicit START) ------------------------------------------
  private renderLobbyList(): void {
    this.lobbyPlayersEl.replaceChildren();
    const list = [...this.roster.values()].sort((a, b) => a.slot - b.slot);
    for (const p of list) {
      const chip = el('div', 'player-chip');
      chip.classList.toggle('you', p.id === this.playerId);
      const sw = el('span', 'player-color');
      sw.style.background = this.colorFor(p.slot);
      chip.appendChild(sw);
      chip.appendChild(el('span', 'player-glyph', this.glyphFor(p.slot)));
      const name = el('span', 'player-name', p.name);
      if (p.id === this.playerId) name.appendChild(el('span', 'player-you', 'YOU'));
      chip.appendChild(name);
      chip.appendChild(el('span', 'player-slot', `SLOT ${p.slot + 1}`));
      this.lobbyPlayersEl.appendChild(chip);
    }
  }

  /**
   * The lobby overlay: up in the lobby phase AND over a live race for a waiting
   * late joiner (they watch the mountain behind the panel until the next
   * countdown seats them). START shows the head count and answers to canStart
   * only — nothing auto-starts.
   */
  private syncLobby(): void {
    const waiting = this.joined && !this.seated && this.phase !== 'lobby';
    const showLobby = this.screen === 'race' && (this.phase === 'lobby' || waiting);
    this.lobbyEl.classList.toggle('hidden', !showLobby);
    if (!showLobby) return;

    const code = this.roomCode;
    this.lobbyCodeEl.classList.toggle('hidden', code === null);
    if (code !== null) this.lobbyCodeEl.textContent = `CODE ${code}`;

    if (waiting) {
      this.lobbyStatusEl.textContent = 'RACE ON THE MOUNTAIN — YOU SKI NEXT ROUND';
    } else {
      const n = Math.max(this.seatedCount, this.roster.size);
      const need = Math.max(0, this.minPlayers - n);
      this.lobbyStatusEl.textContent =
        need > 0
          ? `SKIERS ${n}/${this.minPlayers} — NEED ${need} MORE`
          : `SKIERS ${n} · MIN ${this.minPlayers} — READY WHEN YOU ARE`;
    }
    // START shows the count; a waiting late joiner gets no button at all
    const startVisible = this.phase === 'lobby' && this.seated;
    this.startBtn.classList.toggle('hidden', !startVisible);
    if (startVisible) {
      const n = Math.max(this.seatedCount, this.roster.size);
      this.startBtn.textContent = `START · ${n}/${this.minPlayers}`;
      this.startBtn.disabled = !this.canStart;
      this.startBtn.title = this.canStart
        ? 'Start the race'
        : `Waiting for ${Math.max(0, this.minPlayers - n)} more skier${n + 1 === this.minPlayers ? '' : 's'}`;
    }
    this.syncTouchUi();
  }

  // ---- errors ----------------------------------------------------------------------------------
  /** A readable, non-fatal boot problem (WebGL missing). Mirrors main.ts's banner. */
  private showBootError(text: string): void {
    const banner = el('div', 'error-banner', text);
    document.body.appendChild(banner);
  }

  // ---- session persistence -------------------------------------------------------------------------
  private persistSession(): void {
    const session = loadSession();
    if (session === null) return;
    const lastSeq = Math.max(session.lastSeq, this.lastSeqHigh, this.lastAckWire);
    if (lastSeq === session.lastSeq) return;
    saveSession({ ...session, lastSeq });
  }

  private persistSessionThrottled(): void {
    const now = performance.now();
    if (now - this.seqSavedAt < SEQ_SAVE_EVERY_MS) return;
    this.seqSavedAt = now;
    this.persistSession();
  }

  // ---- debug surface ------------------------------------------------------------------------------
  private debugState(): SplatDebugState {
    const s = this.drive?.state();
    return {
      phase: this.screen === 'menu' ? 'menu' : this.phase,
      seated: this.seated,
      slot: this.slot,
      place: this.ownPlace,
      sim:
        s !== undefined
          ? {
              x: s.x,
              z: s.z,
              yaw: s.yaw,
              v: s.v,
              simMs: s.simMs,
              snareUntilMs: s.snareUntilMs,
              lastPlantIx: s.lastPlantIx,
              lastPlantHitMs: s.lastPlantHitMs,
              finished: s.finished,
              finishMs: s.finishMs,
            }
          : null,
      code: this.roomCode,
      canStart: this.canStart,
    };
  }

  private telemetrySnapshot(): SplatTelemetry {
    const remotes: SplatRemoteDebug[] = [];
    for (const [id, p] of this.players) {
      if (id === this.playerId) continue;
      const v = this.visuals.get(id);
      remotes.push({
        id,
        x: v?.x ?? p.x,
        z: v?.z ?? p.z,
        yaw: v?.yaw ?? p.yaw,
        samples: this.buffers.get(id)?.length ?? 0,
      });
    }
    return {
      drawCalls: this.scene?.drawCalls() ?? 0,
      remotes,
      correction: this.drive?.lastCorrection() ?? 0,
      pending: this.drive?.pending() ?? 0,
      ack: this.lastAckWire,
      seq: this.lastSeqHigh,
      offsetMs: this.offset,
      seed: this.seed,
    };
  }

  /** create/join + send start; a numeric seed rides as room settings {seed}
   *  on the create (dev/e2e slope override). */
  private debugStartRace(seed?: number): void {
    if (this.joined) {
      if (this.canStart) this.send({ t: 'start' });
      else this.pendingStart = true; // fires the moment the room fills (min 2)
      return;
    }
    this.pendingStart = true;
    const name = cleanName(loadName());
    if (typeof seed === 'number' && Number.isFinite(seed)) this.createPrivate(name, seed);
    else this.joinQuick(name);
  }
}
