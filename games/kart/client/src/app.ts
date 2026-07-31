// ============================================================================
// KART GP client — connection, lobby flow, race screens, net wiring.
// Lobby protocol: platform/shared/src/protocol.ts (every join/create carries
// game:'kart'; the room list is filtered to it). Race protocol + tuning come
// from the frozen @kart/shared contract. Driving (./drive.js), rendering
// (./render.js) and sound (./audio.js) are separate frozen modules — this
// file codes against their frozen signatures only (docs/KART.md). Juice
// (skid marks / smoke / dust / sparks / nitro trail / speed lines) lives in
// ./fx.js — pooled and zero-alloc; this file only feeds it sim facts.
//
// Net model: the kart is simulated LOCALLY — drive.ts wraps shared stepKart,
// owns the keyboard (WASD/arrows/Space, R = respawn) and paces the 15Hz
// kart_state packets; app.ts wires packet() -> ws. Snapshots carry the
// server's race truth (phase/places/laps). Own position is corrected GENTLY —
// only past 5m divergence, and then only a fraction of the gap per snapshot.
// Remote karts render ~120ms behind serverTime from per-player interpolation
// buffers. Debug surface window.__kart per docs/KART.md.
// ============================================================================
import {
  GATES,
  KART_COLORS,
  KPAL,
  LAPS_TO_WIN,
  MIN_PLAYERS,
  NITRO_CHARGES,
  TOP_SPEED,
  buildTrack,
  engineRevs,
  forwardSpeed,
  gridSlot,
  surfaceAt,
} from '@kart/shared';
import type {
  KartC2S,
  KartInput,
  KartPhase,
  KartPlayerInfo,
  KartPlayerSnap,
  KartS2C,
  KartState,
  KartYou,
  RaceEvent,
  TrackDef,
} from '@kart/shared';
import type { LobbyC2S, RoomInfo } from '@platform/shared';
import { KartScene } from './render.js';
import { DriveController } from './drive.js';
import { KartAudio } from './audio.js';
import { KartFx } from './fx.js';

// ---- wire parsing (mirror of the platform style: invalid => null, never throw) ----
type LobbyMsg =
  | { t: 'welcome'; playerId: string }
  | { t: 'room_list'; rooms: RoomInfo[] }
  | { t: 'pong'; ts: number; serverTime: number }
  | { t: 'error'; code: string; message: string };

// the frozen contract carries no code; servers that know the room's invite code
// piggyback it (private rooms only) — optional on the wire, null when unknown
type JoinedMsg = Extract<KartS2C, { t: 'kart_joined' }> & { code: string | null };
type SnapshotMsg = Extract<KartS2C, { t: 'kart_snapshot' }>;
type RaceEventMsg = Extract<KartS2C, { t: 'race_event' }>;

type S2C = LobbyMsg | JoinedMsg | SnapshotMsg | RaceEventMsg;

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
function vec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && num(v[0]) && num(v[1]) && num(v[2]);
}
function vec2(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && num(v[0]) && num(v[1]);
}
function kartPhase(v: unknown): KartPhase | null {
  return v === 'lobby' || v === 'ready' || v === 'countdown' || v === 'racing' || v === 'results'
    ? v
    : null;
}

function parseRoomInfo(v: unknown): RoomInfo | null {
  if (!isObj(v) || !str(v.id) || !str(v.game) || !str(v.label) || !str(v.phase)) return null;
  if (!(str(v.code) || v.code === null)) return null;
  if (!num(v.players) || !num(v.maxPlayers)) return null;
  if (v.visibility !== 'public' && v.visibility !== 'private') return null;
  return {
    id: v.id,
    code: v.code,
    game: v.game,
    label: v.label,
    players: v.players,
    maxPlayers: v.maxPlayers,
    phase: v.phase,
    visibility: v.visibility,
  };
}

function parsePlayerInfo(v: unknown): KartPlayerInfo | null {
  if (!isObj(v) || !str(v.id) || !str(v.name) || !num(v.slot) || !num(v.color)) return null;
  return { id: v.id, name: v.name, slot: v.slot, color: v.color };
}

function parseYou(v: unknown): KartYou | null {
  if (!isObj(v)) return null;
  if (!num(v.lap) || !num(v.nextGate) || !num(v.progress) || !num(v.place)) return null;
  if (!bool(v.finished) || !num(v.finishMs) || !num(v.bestLapMs)) return null;
  if (!num(v.nitroLeft) || !num(v.gapAheadMs)) return null;
  return {
    lap: v.lap,
    nextGate: v.nextGate,
    progress: v.progress,
    place: v.place,
    finished: v.finished,
    finishMs: v.finishMs,
    bestLapMs: v.bestLapMs,
    nitroLeft: v.nitroLeft,
    gapAheadMs: v.gapAheadMs,
  };
}

function parsePlayerSnap(v: unknown): KartPlayerSnap | null {
  if (!isObj(v)) return null;
  const info = parsePlayerInfo(v);
  if (info === null) return null;
  if (!vec3(v.p) || !num(v.yaw) || !vec2(v.v) || !num(v.steer) || !bool(v.drift)) return null;
  if (!num(v.lap) || !num(v.nextGate) || !num(v.progress) || !num(v.place)) return null;
  if (!bool(v.finished) || !num(v.finishMs) || !bool(v.nitroActive)) return null;
  return {
    ...info,
    p: v.p,
    yaw: v.yaw,
    v: v.v,
    steer: v.steer,
    drift: v.drift,
    lap: v.lap,
    nextGate: v.nextGate,
    progress: v.progress,
    place: v.place,
    finished: v.finished,
    finishMs: v.finishMs,
    nitroActive: v.nitroActive,
  };
}

function parseRaceEvent(v: unknown): RaceEvent | null {
  if (!isObj(v) || !str(v.kind)) return null;
  switch (v.kind) {
    case 'countdown':
      return num(v.n) ? { kind: 'countdown', n: v.n } : null;
    case 'go':
      return { kind: 'go' };
    case 'gate':
      return str(v.playerId) && num(v.gate) ? { kind: 'gate', playerId: v.playerId, gate: v.gate } : null;
    case 'lap':
      return str(v.playerId) && num(v.lap) && num(v.lapMs)
        ? { kind: 'lap', playerId: v.playerId, lap: v.lap, lapMs: v.lapMs }
        : null;
    case 'nitro':
      return str(v.playerId) && num(v.left)
        ? { kind: 'nitro', playerId: v.playerId, left: v.left }
        : null;
    case 'finish':
      return str(v.playerId) && num(v.place)
        ? { kind: 'finish', playerId: v.playerId, place: v.place }
        : null;
    case 'timeout':
      return { kind: 'timeout' };
    case 'restart':
      return { kind: 'restart' };
    default:
      return null;
  }
}

function parseS2C(raw: unknown): S2C | null {
  if (!isObj(raw) || typeof raw.t !== 'string') return null;
  switch (raw.t) {
    case 'welcome':
      return str(raw.playerId) ? { t: 'welcome', playerId: raw.playerId } : null;
    case 'room_list': {
      if (!Array.isArray(raw.rooms)) return null;
      const rooms: RoomInfo[] = [];
      for (const r of raw.rooms) {
        const room = parseRoomInfo(r);
        if (room !== null) rooms.push(room);
      }
      return { t: 'room_list', rooms };
    }
    case 'pong':
      return num(raw.ts) && num(raw.serverTime)
        ? { t: 'pong', ts: raw.ts, serverTime: raw.serverTime }
        : null;
    case 'error':
      return str(raw.code) && str(raw.message)
        ? { t: 'error', code: raw.code, message: raw.message }
        : null;
    case 'kart_joined': {
      const ph = kartPhase(raw.phase);
      if (!str(raw.you) || !num(raw.slot) || !num(raw.color) || ph === null) return null;
      if (!Array.isArray(raw.players)) return null;
      const players: KartPlayerInfo[] = [];
      for (const p of raw.players) {
        const info = parsePlayerInfo(p);
        if (info === null) return null;
        players.push(info);
      }
      return {
        t: 'kart_joined',
        you: raw.you,
        slot: raw.slot,
        color: raw.color,
        phase: ph,
        players,
        code: str(raw.code) ? raw.code : null,
      };
    }
    case 'kart_snapshot': {
      const ph = kartPhase(raw.phase);
      if (ph === null) return null;
      if (!num(raw.tick) || !num(raw.serverTime) || !num(raw.countdown) || !num(raw.phaseEndsAt)) {
        return null;
      }
      const you = parseYou(raw.you);
      if (you === null || !Array.isArray(raw.players)) return null;
      const players: KartPlayerSnap[] = [];
      for (const p of raw.players) {
        // a malformed entry drops alone at 15Hz — never the whole frame
        const snap = parsePlayerSnap(p);
        if (snap !== null) players.push(snap);
      }
      // lobby contract fields are additive: an older server that omits them
      // still yields a valid snapshot (count from the roster, min from config)
      return {
        t: 'kart_snapshot',
        tick: raw.tick,
        serverTime: raw.serverTime,
        phase: ph,
        countdown: raw.countdown,
        phaseEndsAt: raw.phaseEndsAt,
        playerCount: num(raw.playerCount) ? raw.playerCount : players.length,
        minPlayers: num(raw.minPlayers) ? raw.minPlayers : MIN_PLAYERS,
        canStart: raw.canStart === true,
        you,
        players,
      };
    }
    case 'race_event': {
      const ev = parseRaceEvent(raw.ev);
      return ev !== null ? { t: 'race_event', ev } : null;
    }
    case 'event': {
      // server may wrap game events as {t:'event', ev} (fps convention) — unwrap + re-parse
      const ev = parseRaceEvent(raw.ev);
      if (ev !== null) return { t: 'race_event', ev };
      return parseS2C(raw.ev);
    }
    default:
      return null; // unknown envelope: drop, never throw on wire data
  }
}

// ---- frozen e2e surface (docs/KART.md "Client modules") --------------------------
/** JSON-safe snapshot of everything a test driver needs. */
interface KartDebugState {
  phase: KartPhase | 'menu'; // 'menu' before/after a room
  place: number; // 0 until the first snapshot
  lap: number;
  nextGate: number;
  progress: number;
  pos: { x: number; y: number; z: number };
  speed: number; // signed forward speed, m/s
  gear: number; // 1-based automatic gearbox gear (index into the contract GEARS)
  players: number; // karts in the room (snapshot count)
  nitroLeft: number; // charges left this race (you.nitroLeft, server-authoritative)
  gapAheadMs: number; // ms behind the player one place ahead; 0 for the leader
  frozen: boolean; // drive sim frozen (pre-GO freeze: every phase but 'racing')
  assist: boolean; // KIDS MODE auto-steer active (drive.setAssist)
  code: string | null; // private-room invite code (null for public rooms / before join)
  canStart: boolean; // the lobby START button is live (server says a {t:'start'} lands)
}

interface KartRemoteDebug {
  id: string;
  name: string;
  place: number;
  lap: number;
  x: number; // last INTERPOLATED position (what is on screen)
  z: number;
  yaw: number;
  samples: number; // interpolation buffer depth
}

interface KartTelemetry {
  phase: KartPhase | 'menu';
  playerId: string | null;
  slot: number;
  seq: number; // kart_state frames sent (drive.ts owns the wire seq)
  offsetMs: number; // serverNow = Date.now() + offsetMs
  rttMs: number;
  input: KartInput; // the latched ext input (keyboard is drive-internal)
  own: {
    x: number;
    y: number;
    z: number;
    yaw: number;
    speedMps: number;
    speedKmh: number;
    gear: number; // current gearbox gear (1-based)
    drifting: boolean;
    nitroLeft: number; // remaining nitro BOOST seconds (client sim, not the charge count)
  };
  remotes: KartRemoteDebug[];
  phaseEndsInMs: number;
  nitroLeft: number; // nitro charges left (you.nitroLeft, server-authoritative)
  gapAheadMs: number; // ms behind the player one place ahead; 0 for the leader
  frozen: boolean; // drive sim frozen (pre-GO freeze: every phase but 'racing')
  assist: boolean; // KIDS MODE auto-steer active (drive.setAssist)
}

interface KartApi {
  state(): KartDebugState;
  joinQuick(name: string): void;
  createPublic(name: string): void;
  createPrivate(name: string): void;
  joinPrivate(name: string, code: string): void;
  /** Ask the room to start the race (same message the lobby START button sends). */
  startRace(): void;
  setInput(throttle: number, brake: number, steer: number, drift: boolean): void;
  telemetry(): KartTelemetry;
}

declare global {
  interface Window {
    __kart?: KartApi;
  }
}

// ---- tuning ------------------------------------------------------------------
const RECONNECT_MS = 1000; // socket dropped -> back to the menu, retry quietly
const PING_EVERY_MS = 2000; // mirrors NET.pingEveryMs (platform protocol)
const ROOMS_EVERY_MS = 3000; // menu room-list poll
const WATCHDOG_MS = 200; // background-tab keepalive cadence (rAF pauses there)
const WATCHDOG_DT = 0.2; // s of sim per watchdog step (slow-mo, still < INPUT_STALE_MS)
const FRAME_STALE_MS = 250; // rAF silence that wakes the watchdog
const INTERP_DELAY_MS = 120; // remote karts render this far behind serverTime
const BUFFER_KEEP_MS = 1000; // per-remote snapshot history
const EXTRAPOLATE_MAX_MS = 250; // past-newest velocity extrapolation cap
const TELEPORT_SQ = 10 * 10; // m² — bigger jumps snap, never lerp (matches fps interp)
const CORRECT_DIST_SQ = 5 * 5; // m² — server/own divergence that triggers a correction
const CORRECT_BLEND = 0.35; // fraction of the gap closed per correcting snapshot (GENTLE)
const OFFSET_EMA = 0.2; // server-clock offset smoothing per pong (spike must not lurch remotes)
const MAX_FRAME_DT = 0.05; // s — tab-switch clamp for the local sim
const GO_FLASH_MS = 900; // how long the big GO! stays up
const HINT_HOLD_MS = 5000; // controls hint card stays fully up this long after GO…
const HINT_FADE_MS = 1000; // …then fades out (gone at ~6s, per docs/KART.md)
const MSG_MS = 2600; // transient center message lifetime
const THUD_DROP = 4; // m/s of forward speed lost in one frame => barrier thud
// ---- fx emit pacing (fx.ts pools; distances in m, rates in s) -----------------
const SKID_MARK_EVERY = 0.5; // per-wheel mark spacing (fx pool covers ~32m of trail)
const SKID_MIN_SPEED = 3; // no marks while crawling
const BRAKE_SKID_DECEL = 14; // m/s² — hard braking lays marks too (BRAKE is 24)
const BRAKE_SKID_MIN_SPEED = 8; // ...only at real speed
const SMOKE_EVERY_S = 0.045; // drift smoke cadence — discrete puffs with gaps
const DUST_EVERY_S = 0.045; // grass dust cadence
const DUST_MIN_SPEED = 6;
const TRAIL_EVERY_S = 0.03; // nitro streak cadence
const WHEEL_REAR = 0.78; // rear axle offset behind the kart origin (kartMesh)
const WHEEL_HALF = 0.66; // half track width (kartMesh wheel spots)
const NOSE_AHEAD = 1.4; // spark burst point ahead of the kart origin
const MINIMAP_EVERY_MS = 250; // 4Hz minimap redraw
const MINIMAP_SIZE = 140; // css px (2x backing store for retina)
const NAME_MAX = 16; // lobby cleanName cap (platform protocol)
const CODE_MAX = 8;
const KIDS_KEY = 'kart.kids'; // localStorage key for the KIDS MODE assist toggle
const TWO_PI = Math.PI * 2;

const ZERO_INPUT: KartInput = { throttle: 0, brake: 0, steer: 0, drift: false };

/** drive.state() shape per the frozen drive.ts signature (docs/KART.md). */
type DriveState = KartState & { steer: number; driftVisual: number };

/** One buffered remote snapshot (serverTime ms). */
interface RemoteSample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  steer: number;
  drift: boolean;
  nitroActive: boolean;
}

/** What gets drawn for a remote kart this frame. */
interface RemoteVisual {
  x: number;
  y: number;
  z: number;
  yaw: number;
  steer: number;
  drift: boolean;
  nitroActive: boolean;
}

/** Per-remote fx bookkeeping: last laid skid-mark position per rear wheel + emit clocks. */
interface RemoteFxState {
  lx: number;
  lz: number;
  rx: number;
  rz: number;
  init: boolean;
  smokeAcc: number;
  trailAcc: number;
  side: boolean; // smoke/dust puff wheel alternation
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

/** KIDS MODE persisted toggle (localStorage 'kart.kids'); false when storage is blocked. */
function readKidsStored(): boolean {
  try {
    const v = localStorage.getItem(KIDS_KEY);
    return v === '1' || v === 'true';
  } catch {
    return false; // storage unavailable (private mode) — assist defaults off
  }
}

/** Trimmed, length-capped display name; 'Player' when whitespace-only (lobby rule). */
function cleanName(v: string): string {
  return v.trim().slice(0, NAME_MAX) || 'Player';
}

/** 'm:ss.mmm' race-clock format; '—' for unset (-1) times. */
function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const mmm = total % 1000;
  const ss = String(s).padStart(2, '0');
  const tail = String(mmm).padStart(3, '0');
  return `${m}:${ss}.${tail}`;
}

/** English ordinal suffix for a 1-based place (grid is ≤ 8, no 11/12/13 case). */
function ordinalSuffix(place: number): string {
  if (place === 1) return 'st';
  if (place === 2) return 'nd';
  if (place === 3) return 'rd';
  return 'th';
}

/** Shortest-arc lerp for wrapped radians (same as the fps interp). */
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d < -Math.PI) d += TWO_PI;
  return a + d * t;
}

function clampNum(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0;
}

/** Sample a remote buffer at renderTime: lerp the bracketing pair, snap on
 *  teleports, extrapolate by velocity only up to EXTRAPOLATE_MAX_MS. */
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
    return { x: first.x, y: first.y, z: first.z, yaw: first.yaw, steer: first.steer, drift: first.drift, nitroActive: first.nitroActive };
  }
  const a = buf[lo];
  if (a === undefined) return null; // unreachable
  const b = buf[lo + 1];
  if (b === undefined) {
    // at/after the newest sample: short velocity extrapolation, position only
    const k = Math.min(EXTRAPOLATE_MAX_MS, Math.max(0, renderTime - a.t)) / 1000;
    return { x: a.x + a.vx * k, y: a.y, z: a.z + a.vz * k, yaw: a.yaw, steer: a.steer, drift: a.drift, nitroActive: a.nitroActive };
  }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  if (dx * dx + dy * dy + dz * dz > TELEPORT_SQ) {
    return { x: b.x, y: b.y, z: b.z, yaw: b.yaw, steer: b.steer, drift: b.drift, nitroActive: b.nitroActive }; // teleport: snap
  }
  const span = b.t - a.t;
  const t = span > 0 ? Math.min(1, Math.max(0, (renderTime - a.t) / span)) : 1;
  return {
    x: a.x + dx * t,
    y: a.y + dy * t,
    z: a.z + dz * t,
    yaw: lerpAngle(a.yaw, b.yaw, t),
    steer: a.steer + (b.steer - a.steer) * t,
    drift: b.drift, // discrete fields from the newer sample
    nitroActive: b.nitroActive,
  };
}

export class KartApp {
  private ws: WebSocket | null = null;
  private welcomed = false;
  private playerId: string | null = null;
  private rooms: RoomInfo[] = [];
  private screen: 'menu' | 'race' = 'menu';

  // ---- room/race state (server truth arrives via kart_joined + snapshots) -------
  private joined = false;
  private slot = 0; // our grid slot (join order)
  private colorIdx = 0; // our KART_COLORS index
  private roomCode: string | null = null; // invite code from kart_joined (private rooms)
  private phase: KartPhase = 'lobby';
  private you: KartYou | null = null;
  private phaseEndsAt = 0; // serverTime ms; 0 when no phase timer
  // ---- lobby contract (server truth; the START button reads these) --------------
  private seatedCount = 0; // players seated in the room (snapshot playerCount)
  private minPlayers = MIN_PLAYERS; // the room's minimum (snapshot minPlayers)
  private canStart = false; // a {t:'start'} would be accepted right now
  private readonly players = new Map<string, KartPlayerSnap>(); // latest snapshot per id
  private readonly roster = new Map<string, KartPlayerInfo>(); // names/colors/slots per id
  private readonly bestLaps = new Map<string, number>(); // from 'lap' race events (results table)

  // ---- net timing ----------------------------------------------------------------
  private offset = 0; // serverNow = Date.now() + offset (rtt/2 estimate, like bank)
  private offsetSet = false; // first pong sets the offset directly; later pongs EMA it
  private rttMs = 0;
  private packetsSent = 0; // kart_state frames actually sent (drive.ts owns the seq)

  // ---- local kart + remotes -------------------------------------------------------
  private readonly track: TrackDef = buildTrack();
  private readonly drive: DriveController;
  private readonly scene: KartScene;
  private readonly audio = new KartAudio();
  private readonly sceneKarts = new Set<string>(); // ids currently added to the scene
  private readonly buffers = new Map<string, RemoteSample[]>(); // per-remote interp history
  private readonly visuals = new Map<string, RemoteVisual>(); // last drawn remote pose (telemetry)

  // ---- input -----------------------------------------------------------------------
  // The keyboard is owned by drive.ts; the only input app.ts injects is the
  // latched debug driver (e2e), via drive.setInput.
  private debugInput: KartInput | null = null; // __kart.setInput override (e2e driver)

  // ---- presentation state ------------------------------------------------------------
  private countdownShown = 0; // big number currently up (dedupes event + snapshot)
  private goActive = false;
  private goUntil = 0; // performance.now() deadline for the GO! flash
  private goAt = 0; // performance.now() at GO (0 = none yet); times the hint card fade
  private msgUntil = 0; // performance.now() deadline for the transient message
  private lapStartAt = 0; // serverNow ms when the current lap began
  private lastYouLap = 1; // previous snapshot lap (edge detection)
  private lastLapMs = -1; // our last completed lap (from 'lap' events)
  private frozenLapMs = -1; // lap-time value frozen at our finish
  private wasFinished = false;
  private prevSpeed = 0;
  private lastFrame = 0;
  private assist = false; // KIDS MODE auto-steer (docs/KART.md) — mirrored to localStorage 'kart.kids'

  // ---- fx (./fx.js pools) + minimap ------------------------------------------------
  private readonly fx: KartFx;
  private readonly ownFx: RemoteFxState = {
    lx: 0, lz: 0, rx: 0, rz: 0, init: false, smokeAcc: 0, trailAcc: 0, side: false,
  };
  private dustAcc = 0;
  private readonly remoteFx = new Map<string, RemoteFxState>();
  private minimapNextAt = 0; // performance.now() of the next 4Hz redraw
  private readonly mapPath: Path2D; // track outline, precomputed once
  private readonly mapScale: number; // world -> map px: mx = (x + mapOffX) * mapScale
  private readonly mapOffX: number;
  private readonly mapOffZ: number;

  // ---- DOM handles (built once in the constructor, updated in place) ----------------
  private readonly menuEl: HTMLDivElement;
  private readonly noticeEl: HTMLDivElement;
  private readonly nameInput: HTMLInputElement;
  private readonly codeInput: HTMLInputElement;
  private readonly kidsInput: HTMLInputElement; // menu KIDS MODE checkbox
  private readonly roomsEl: HTMLDivElement;
  private readonly menuButtons: HTMLButtonElement[] = [];
  private readonly raceEl: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly hudEl: HTMLDivElement;
  private readonly hudLeftEl: HTMLDivElement; // top-left chip stack (pos + lap; hosts the invite chip mid-race)
  private readonly placeNumEl: HTMLSpanElement; // big ordinal numeral ('2')
  private readonly placeSufEl: HTMLSpanElement; // ordinal suffix ('nd')
  private readonly placeTotalEl: HTMLSpanElement; // '/N' field size
  private readonly placeGapEl: HTMLDivElement; // '+1.8s' / 'LEADER'
  private readonly crownEl: HTMLDivElement; // P1 accent badge, hidden off the lead
  private readonly kidsBadgeEl: HTMLDivElement; // small 'KIDS' badge in the position chip
  private readonly lapEl: HTMLDivElement;
  private readonly speedNumEl: HTMLSpanElement;
  private readonly speedBarEl: HTMLDivElement; // speed meter fill (width is the only JS-set style)
  private prevSpeedPct = -1; // last written meter width, to skip no-op style writes
  private readonly gearEl: HTMLSpanElement;
  private prevShifting = false; // upshift rising edge, for the one-shot gear flash
  private readonly lapTimeEl: HTMLSpanElement;
  private readonly bestEl: HTMLSpanElement;
  private readonly nitroEl: HTMLDivElement;
  private readonly nitroPips: HTMLSpanElement[] = []; // NITRO_CHARGES pips, dim when spent
  private prevNitroPips = NITRO_CHARGES; // spend-edge detection for the pip flash
  private lastSurface: 'asphalt' | 'grass' = 'asphalt'; // from updateFx, for the skid sfx
  private readonly minimapEl: HTMLCanvasElement;
  private readonly gateWrapEl: HTMLDivElement;
  private readonly gateEl: HTMLDivElement;
  private readonly gateLabelEl: HTMLDivElement;
  private readonly lobbyEl: HTMLDivElement;
  private readonly lobbyPlayersEl: HTMLDivElement;
  private readonly lobbyStatusEl: HTMLDivElement;
  private readonly startBtn: HTMLButtonElement; // explicit race start (no auto-start)
  private readonly countdownEl: HTMLDivElement;
  private readonly msgEl: HTMLDivElement;
  private readonly hintEl: HTMLDivElement;
  private readonly inviteEl: HTMLDivElement; // private-room invite chip ('CIRCUIT · code XXXXX')
  private readonly inviteCodeEl: HTMLSpanElement;
  private readonly copyBtn: HTMLButtonElement;
  private copiedTimer = 0; // 'COPIED' feedback reset handle
  private readonly resultsEl: HTMLDivElement;
  private readonly resultsBodyEl: HTMLTableSectionElement;
  private readonly resultsNoteEl: HTMLDivElement;

  constructor(root: HTMLElement) {
    this.assist = readKidsStored(); // KIDS MODE persisted toggle (localStorage 'kart.kids')

    // ---- menu screen ----------------------------------------------------------
    this.menuEl = el('div', 'screen menu');
    this.menuEl.appendChild(el('h1', 'menu-title', 'KART GP'));
    this.menuEl.appendChild(el('p', 'menu-sub', 'multiplayer kart racing — 3 laps, first over the line'));
    this.noticeEl = el('div', 'menu-notice hidden');
    this.menuEl.appendChild(this.noticeEl);

    this.nameInput = el('input', 'menu-name');
    this.nameInput.maxLength = NAME_MAX;
    this.nameInput.placeholder = 'your name';
    this.nameInput.autocomplete = 'off';
    this.menuEl.appendChild(this.nameInput);

    const menuActions = el('div', 'menu-actions');
    this.menuButtons.push(
      this.menuButton(menuActions, 'QUICK JOIN', 'btn btn-gold', () => this.joinQuick(this.menuName())),
      this.menuButton(menuActions, 'CREATE PUBLIC', 'btn', () => this.createPublic(this.menuName())),
      this.menuButton(menuActions, 'CREATE PRIVATE', 'btn', () => this.createPrivate(this.menuName())),
    );
    this.menuEl.appendChild(menuActions);

    const codeRow = el('div', 'menu-code');
    this.codeInput = el('input', 'menu-code-input');
    this.codeInput.maxLength = CODE_MAX;
    this.codeInput.placeholder = 'CODE';
    this.codeInput.autocomplete = 'off';
    codeRow.appendChild(this.codeInput);
    this.menuButtons.push(
      this.menuButton(codeRow, 'JOIN', 'btn', () =>
        this.joinPrivate(this.menuName(), this.codeInput.value.trim()),
      ),
    );
    this.menuEl.appendChild(codeRow);

    // invite link (?code=XXXXX): prefill the private-code input (bank convention)
    const linkCode = new URLSearchParams(location.search).get('code');
    if (linkCode !== null && linkCode.trim().length > 0) {
      this.codeInput.value = linkCode.trim().slice(0, CODE_MAX);
    }

    // KIDS MODE auto-steer assist (docs/KART.md "Kids mode") — persisted in localStorage
    const kidsRow = el('label', 'menu-kids');
    this.kidsInput = el('input');
    this.kidsInput.type = 'checkbox';
    this.kidsInput.checked = this.assist;
    this.kidsInput.addEventListener('change', () => this.setAssist(this.kidsInput.checked));
    kidsRow.appendChild(this.kidsInput);
    kidsRow.appendChild(el('span', 'menu-kids-label', 'KIDS MODE — auto steer'));
    this.menuEl.appendChild(kidsRow);

    this.menuEl.appendChild(el('h2', 'menu-rooms-title', 'TRACKS'));
    this.roomsEl = el('div', 'menu-rooms');
    this.menuEl.appendChild(this.roomsEl);

    // ---- race screen ----------------------------------------------------------
    this.raceEl = el('div', 'screen race hidden');
    this.canvas = el('canvas', 'race-canvas');
    this.raceEl.appendChild(this.canvas);

    const raceTop = el('div', 'race-top');
    const leaveBtn = el('button', 'btn btn-small', 'LEAVE');
    leaveBtn.addEventListener('click', () => {
      this.audio.resume();
      leaveBtn.blur(); // keep SPACE/arrows off the focused button while driving
      this.leaveToMenu('');
    });
    raceTop.appendChild(leaveBtn);
    this.raceEl.appendChild(raceTop);

    // HUD: compact position chip + lap chip (top-left), gear/speed + minimap
    // (top-right), times (bottom-left), nitro pips (bottom-right), next-gate
    // chevron (top-center)
    this.hudEl = el('div', 'hud hidden');
    // corner scrims: a soft ink wash under each chip cluster so the HUD reads
    // over near-black asphalt AND over a white sky. Decorative only, appended
    // first so they sit behind every cluster.
    for (const corner of ['hud-corner-tl', 'hud-corner-tr', 'hud-corner-bl', 'hud-corner-br']) {
      this.hudEl.appendChild(el('div', `hud-scrim ${corner}`));
    }
    const hudLeft = el('div', 'hud-left');
    this.hudLeftEl = hudLeft;
    // top of the HUD value ladder: place and speed are the two reads a driver
    // takes at 200 km/h, so they carry the 'hi' chip tier; everything else is
    // reference data on 'lo'
    const pos = el('div', 'hud-pos hud-chip hud-chip-hi');
    // P1 accent — textless, so the stylesheet draws its own mark
    this.crownEl = el('div', 'hud-pos-crown hidden');
    pos.appendChild(this.crownEl);
    const posMain = el('div', 'hud-pos-main');
    this.placeNumEl = el('span', 'hud-pos-num', '—');
    this.placeSufEl = el('span', 'hud-pos-suf', '');
    posMain.appendChild(this.placeNumEl);
    posMain.appendChild(this.placeSufEl);
    this.placeTotalEl = el('span', 'hud-pos-total', '');
    posMain.appendChild(this.placeTotalEl);
    pos.appendChild(posMain);
    this.placeGapEl = el('div', 'hud-pos-gap', '');
    pos.appendChild(this.placeGapEl);
    // KIDS badge: small, inside the position chip
    this.kidsBadgeEl = el('div', 'hud-kids hidden', 'KIDS');
    pos.appendChild(this.kidsBadgeEl);
    hudLeft.appendChild(pos);
    this.lapEl = el('div', 'hud-lap hud-chip hud-chip-lo', `LAP 1/${LAPS_TO_WIN}`);
    hudLeft.appendChild(this.lapEl);
    this.hudEl.appendChild(hudLeft);

    const hudRight = el('div', 'hud-right');
    const speed = el('div', 'hud-speed hud-chip hud-chip-hi');
    // gear stacked ABOVE the speed — adjacent big numerals kerned into one read
    const gearRow = el('div', 'hud-gear-row');
    gearRow.appendChild(el('span', 'hud-gear-label', 'GEAR'));
    this.gearEl = el('span', 'hud-gear', '1');
    gearRow.appendChild(this.gearEl);
    speed.appendChild(gearRow);
    const speedRow = el('div', 'hud-speed-row');
    this.speedNumEl = el('span', 'hud-speed-num', '0');
    speedRow.appendChild(this.speedNumEl);
    speedRow.appendChild(el('span', 'hud-speed-unit', 'km/h'));
    speed.appendChild(speedRow);
    // speed meter: fraction of the physics ceiling, so only nitro pegs it
    this.speedBarEl = el('div', 'hud-speed-bar');
    speed.appendChild(this.speedBarEl);
    hudRight.appendChild(speed);
    // minimap: track outline + live player dots, redrawn at 4Hz (MINIMAP_EVERY_MS)
    this.minimapEl = el('canvas', 'hud-minimap hud-chip hud-chip-lo');
    this.minimapEl.width = MINIMAP_SIZE * 2; // 2x backing store — crisp on retina
    this.minimapEl.height = MINIMAP_SIZE * 2;
    hudRight.appendChild(this.minimapEl);
    this.hudEl.appendChild(hudRight);

    const hudTimes = el('div', 'hud-times hud-chip hud-chip-lo');
    const lapRow = el('div', 'hud-time-row');
    lapRow.appendChild(el('span', 'hud-time-label', 'LAP'));
    this.lapTimeEl = el('span', 'hud-time-value', '—');
    lapRow.appendChild(this.lapTimeEl);
    hudTimes.appendChild(lapRow);
    hudTimes.appendChild(el('div', 'hud-rule')); // hairline between current and best
    const bestRow = el('div', 'hud-time-row');
    bestRow.appendChild(el('span', 'hud-time-label', 'BEST'));
    this.bestEl = el('span', 'hud-time-value hud-best', '—');
    bestRow.appendChild(this.bestEl);
    hudTimes.appendChild(bestRow);
    this.hudEl.appendChild(hudTimes);

    // nitro pips: NITRO_CHARGES small charges at the bottom-right, dim when spent
    this.nitroEl = el('div', 'hud-nitro hud-chip hud-chip-lo');
    this.nitroEl.appendChild(el('div', 'hud-turbo-label', 'NITRO'));
    this.nitroEl.appendChild(el('div', 'hud-rule'));
    const pipRow = el('div', 'hud-nitro-pips');
    for (let i = 0; i < NITRO_CHARGES; i++) {
      // pips start FULL — the base class is the empty socket, the modifier is the charge
      const pip = el('span', 'hud-nitro-pip hud-nitro-pip-full');
      this.nitroPips.push(pip);
      pipRow.appendChild(pip);
    }
    this.nitroEl.appendChild(pipRow);
    this.hudEl.appendChild(this.nitroEl);

    // next-gate marker: rotating chevron + distance label in one chip-family wrap
    this.gateWrapEl = el('div', 'hud-gate-wrap hidden');
    this.gateEl = el('div', 'hud-gate');
    this.gateWrapEl.appendChild(this.gateEl);
    this.gateLabelEl = el('div', 'hud-gate-label', '');
    this.gateWrapEl.appendChild(this.gateLabelEl);
    this.hudEl.appendChild(this.gateWrapEl);
    this.raceEl.appendChild(this.hudEl);

    // lobby overlay: the grid (player list) + phase status
    this.lobbyEl = el('div', 'lobby-overlay hidden');
    const lobbyPanel = el('div', 'lobby-panel');
    lobbyPanel.appendChild(el('div', 'lobby-title', 'GRID'));
    this.lobbyPlayersEl = el('div', 'lobby-players');
    lobbyPanel.appendChild(this.lobbyPlayersEl);
    this.lobbyStatusEl = el('div', 'lobby-status', '');
    lobbyPanel.appendChild(this.lobbyStatusEl);
    // START: the room never auto-starts. Any seated player may press it; it is
    // disabled (with the reason on .lobby-status right above) below MIN_PLAYERS.
    this.startBtn = el('button', 'btn btn-gold lobby-start', 'START RACE');
    this.startBtn.addEventListener('click', () => {
      this.audio.resume();
      this.startBtn.blur(); // keep SPACE/arrows off the focused button once racing
      if (this.canStart) this.send({ t: 'start' });
    });
    lobbyPanel.appendChild(this.startBtn);
    lobbyPanel.appendChild(el('div', 'lobby-hint', 'WASD / ARROWS to drive — SPACE to drift'));
    this.lobbyEl.appendChild(lobbyPanel);
    this.raceEl.appendChild(this.lobbyEl);

    // controls hint card (docs/KART.md "Onboarding hints"): non-modal, bottom-center;
    // up pre-GO, holds ~5s after GO, then fades.
    this.hintEl = el(
      'div',
      'hint-card',
      `WASD/arrows drive · Space/Shift drift · N nitro ×${NITRO_CHARGES} · R respawn at last gate`,
    );
    this.raceEl.appendChild(this.hintEl);

    this.countdownEl = el('div', 'countdown-overlay hidden');
    this.raceEl.appendChild(this.countdownEl);

    this.msgEl = el('div', 'race-msg hidden');
    this.raceEl.appendChild(this.msgEl);

    // invite chip (private rooms only): top-left 'CIRCUIT · code XXXXX' + COPY
    // INVITE. Parks inside hud-left while the HUD is up (the position/lap chips
    // own the corner then); top-level above the lobby/results overlays otherwise.
    // Both homes — and the pill itself — are styled from style.css by parent
    // selector (`.hud-left > .race-invite` / `.race > .race-invite`); this file
    // sets no geometry (VISUAL_UPGRADE.md §9 inline-style hazard).
    this.inviteEl = el('div', 'race-invite hidden');
    this.inviteCodeEl = el('span', 'race-invite-code race-invite-chip');
    this.inviteEl.appendChild(this.inviteCodeEl);
    this.copyBtn = el('button', 'btn btn-small', 'COPY INVITE');
    this.copyBtn.addEventListener('click', () => {
      this.audio.resume();
      this.copyBtn.blur(); // keep SPACE/arrows off the focused button while driving
      this.copyInvite();
    });
    this.inviteEl.appendChild(this.copyBtn);
    this.raceEl.appendChild(this.inviteEl);

    // results overlay: place / name / time / best lap, auto-return note
    this.resultsEl = el('div', 'results-overlay hidden');
    const resultsPanel = el('div', 'results-panel');
    resultsPanel.appendChild(el('div', 'results-title', 'RESULTS'));
    const table = el('table', 'results-table');
    const thead = el('thead');
    const headRow = el('tr');
    for (const h of ['PLACE', 'NAME', 'TIME', 'BEST LAP']) headRow.appendChild(el('th', undefined, h));
    thead.appendChild(headRow);
    table.appendChild(thead);
    this.resultsBodyEl = el('tbody');
    table.appendChild(this.resultsBodyEl);
    resultsPanel.appendChild(table);
    this.resultsNoteEl = el('div', 'results-note', '');
    resultsPanel.appendChild(this.resultsNoteEl);
    this.resultsEl.appendChild(resultsPanel);
    this.raceEl.appendChild(this.resultsEl);

    root.appendChild(this.menuEl);
    root.appendChild(this.raceEl);

    // ---- scene + kart (frozen module signatures; the track never changes) -------
    this.scene = new KartScene(this.canvas);
    this.scene.setTheme(this.track.theme);
    this.scene.buildTrack(this.track);
    this.drive = new DriveController(this.track);
    this.drive.setAssist(this.assist); // kids-mode assist restored before the first join
    // nitro key (N) asks the SERVER to spend a charge; only racing may spend one.
    // The boost itself starts when the server's nitro race event echoes back.
    this.drive.onNitro = () => {
      if (this.phase === 'racing') this.send({ t: 'nitro' });
    };
    this.scene.resize();

    // ---- fx pools + minimap precompute -------------------------------------------
    this.fx = new KartFx(KartFx.sceneRoot(this.scene), this.raceEl);
    // minimap: fit the centerline bounds into MINIMAP_SIZE px with a small pad;
    // the outline path is static — only the dots move (4Hz redraw)
    {
      const cl = this.track.centerline;
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const c of cl) {
        if (c[0] < minX) minX = c[0];
        if (c[0] > maxX) maxX = c[0];
        if (c[1] < minZ) minZ = c[1];
        if (c[1] > maxZ) maxZ = c[1];
      }
      const pad = 9;
      const spanX = Math.max(1, maxX - minX);
      const spanZ = Math.max(1, maxZ - minZ);
      this.mapScale = Math.min((MINIMAP_SIZE - pad * 2) / spanX, (MINIMAP_SIZE - pad * 2) / spanZ);
      // center the shorter axis; project: mx = (x + mapOffX) * mapScale
      this.mapOffX = -minX + (MINIMAP_SIZE / this.mapScale - spanX) / 2;
      this.mapOffZ = -minZ + (MINIMAP_SIZE / this.mapScale - spanZ) / 2;
      const path = new Path2D();
      for (let i = 0; i < cl.length; i++) {
        const c = cl[i]!;
        const mx = (c[0] + this.mapOffX) * this.mapScale;
        const my = (c[1] + this.mapOffZ) * this.mapScale;
        if (i === 0) path.moveTo(mx, my);
        else path.lineTo(mx, my);
      }
      path.closePath();
      this.mapPath = path;
    }

    // ---- listeners (driving keys are owned by drive.ts; audio unlocks on clicks) ----
    window.addEventListener('resize', () => {
      if (this.screen === 'race') this.scene.resize();
    });
    // T toggles KIDS MODE in-game (docs/KART.md "Kids mode"); the menu uses the checkbox
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyT' || e.repeat || this.screen !== 'race') return;
      this.setAssist(!this.assist);
    });

    // ---- timers (setInterval for net: rAF pauses in background tabs) ---------------
    window.setInterval(() => {
      if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
        this.send({ t: 'ping', ts: performance.now() });
      }
    }, PING_EVERY_MS);
    window.setInterval(() => {
      if (this.screen === 'menu' && this.welcomed) this.send({ t: 'list_rooms' });
    }, ROOMS_EVERY_MS);
    window.setInterval(() => this.watchdog(), WATCHDOG_MS);

    this.lastFrame = performance.now();
    requestAnimationFrame(this.frameBound);

    // ---- frozen e2e debug surface ---------------------------------------------------
    window.__kart = {
      state: () => this.debugState(),
      joinQuick: (name) => this.joinQuick(name),
      createPublic: (name) => this.createPublic(name),
      createPrivate: (name) => this.createPrivate(name),
      joinPrivate: (name, code) => this.joinPrivate(name, code),
      // the room validates phase + count, so an early call is a harmless no-op
      startRace: () => this.send({ t: 'start' }),
      setInput: (throttle, brake, steer, drift) => this.setDebugInput(throttle, brake, steer, drift),
      telemetry: () => this.telemetrySnapshot(),
    };

    this.connect();
    this.renderMenu();
  }

  // ---- connection ---------------------------------------------------------------
  private connect(): void {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws || typeof ev.data !== 'string') return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(ev.data);
      } catch {
        return; // malformed frame: drop, never throw
      }
      const msg = parseS2C(decoded);
      if (msg !== null) this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // stale socket from a previous connect()
      this.ws = null;
      const wasInRace = this.screen === 'race';
      this.welcomed = false;
      this.resetRoom();
      this.showMenu(wasInRace ? 'Connection lost — rejoining…' : '');
      window.setTimeout(() => this.connect(), RECONNECT_MS);
    };
    ws.onerror = () => {
      // the close event follows and does the teardown
    };
  }

  /** No-op unless the socket is open (mirrors the server's Session.send). */
  private send(msg: LobbyC2S | KartC2S): void {
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

  private selfId(): string {
    return this.playerId ?? 'you'; // welcome always precedes kart_joined
  }

  // ---- lobby actions (game filter 'kart' on every create/join; kart has no settings) --
  private joinQuick(name: string): void {
    const msg: Extract<LobbyC2S, { t: 'quick_join' }> = {
      t: 'quick_join',
      name: cleanName(name),
      game: 'kart',
    };
    this.send(msg);
  }
  private createPublic(name: string): void {
    const msg: Extract<LobbyC2S, { t: 'create_public' }> = {
      t: 'create_public',
      name: cleanName(name),
      game: 'kart',
    };
    this.send(msg);
  }
  private createPrivate(name: string): void {
    const msg: Extract<LobbyC2S, { t: 'create_private' }> = {
      t: 'create_private',
      name: cleanName(name),
      game: 'kart',
    };
    this.send(msg);
  }
  private joinPrivate(name: string, code: string): void {
    const c = code.trim();
    if (c.length === 0) {
      this.setNotice('enter a room code first');
      return;
    }
    const msg: Extract<LobbyC2S, { t: 'join_private' }> = {
      t: 'join_private',
      name: cleanName(name),
      code: c,
    };
    this.send(msg);
  }

  /** Room-list row click: join a specific room by id (same flow as joinPrivate; kart
   *  carries no resume token — docs/KART.md: "resume token optional v1: NOT required"). */
  private joinPublic(name: string, roomId: string): void {
    const msg: Extract<LobbyC2S, { t: 'join_public' }> = {
      t: 'join_public',
      name: cleanName(name),
      roomId,
    };
    this.send(msg);
  }

  // ---- message routing -------------------------------------------------------------
  private onMessage(msg: S2C): void {
    switch (msg.t) {
      case 'welcome':
        this.playerId = msg.playerId;
        this.welcomed = true;
        this.send({ t: 'list_rooms' });
        this.setNotice('');
        this.renderMenu();
        break;
      case 'room_list':
        this.rooms = msg.rooms.filter((r) => r.game === 'kart'); // kart-only room list
        if (this.screen === 'menu') this.renderRooms();
        break;
      case 'pong': {
        const rtt = performance.now() - msg.ts;
        if (rtt >= 0) {
          this.rttMs = rtt;
          const measured = msg.serverTime + rtt / 2 - Date.now();
          // EMA, never replacement: a single rtt spike must not jump the
          // shared render time base — every remote kart would visibly lurch
          // by speed × Δoffset (worst on nitro-fast karts).
          this.offset = this.offsetSet
            ? this.offset + (measured - this.offset) * OFFSET_EMA
            : measured;
          this.offsetSet = true;
        }
        break;
      }
      case 'error':
        this.setNotice(msg.message);
        break;
      case 'kart_joined':
        this.onJoined(msg);
        break;
      case 'kart_snapshot':
        this.onSnapshot(msg);
        break;
      case 'race_event':
        this.onRaceEvent(msg.ev);
        break;
    }
  }

  // ---- join / leave -------------------------------------------------------------------
  private onJoined(msg: JoinedMsg): void {
    this.joined = true;
    this.slot = msg.slot;
    this.colorIdx = msg.color;
    this.roomCode = msg.code; // private rooms carry their invite code; null = public
    this.updateInviteChip();
    this.phase = msg.phase; // set directly — joining is not a phase TRANSITION
    this.applyFreeze(); // mid-race joiners drive at once; everyone else waits for GO
    this.drive.setAssist(this.assist); // kids-mode assist follows the stored toggle into the room
    this.you = null;
    this.phaseEndsAt = 0;
    this.seatedCount = msg.players.length; // until the first snapshot lands
    this.canStart = false; // the server decides; a stale true would lie for a frame
    this.countdownShown = 0;
    this.goActive = false;
    this.players.clear();
    this.roster.clear();
    for (const info of msg.players) this.roster.set(info.id, info);
    this.clearSceneKarts();
    this.resetRaceLocal(); // mid-race joiners start at the back of the grid (their slot)
    this.ensureKart(this.selfId(), this.colorIdx);
    for (const info of msg.players) this.ensureKart(info.id, info.color);
    this.renderLobbyList();
    this.showRace();
  }

  private leaveToMenu(notice: string): void {
    this.send({ t: 'leave' });
    this.resetRoom();
    this.showMenu(notice);
    if (this.welcomed) this.send({ t: 'list_rooms' });
  }

  /** Drops all per-room state (leave + socket close share this). */
  private resetRoom(): void {
    this.joined = false;
    this.you = null;
    this.phase = 'lobby';
    this.roomCode = null;
    this.updateInviteChip();
    this.phaseEndsAt = 0;
    this.seatedCount = 0;
    this.minPlayers = MIN_PLAYERS;
    this.canStart = false;
    this.players.clear();
    this.roster.clear();
    this.buffers.clear();
    this.visuals.clear();
    this.bestLaps.clear();
    this.remoteFx.clear();
    this.ownFx.init = false;
    this.fx.clear();
    this.debugInput = null;
    this.drive.setInput({ ...ZERO_INPUT }); // clear a latched debug driver
    this.drive.setOthers([]);
    this.applyFreeze(); // back at the menu the sim is frozen ('lobby' !== 'racing')
    this.countdownShown = 0;
    this.goActive = false;
    this.goAt = 0;
    this.audio.engine(0, false);
    this.audio.skid(0); // cut the persistent tire voice so it can't leak onto the menu
    this.clearSceneKarts();
  }

  /** Fresh race: own kart back on its grid slot, per-race locals cleared. */
  private resetRaceLocal(): void {
    const g = gridSlot(this.track, this.slot);
    this.drive.reset(g.x, g.z, g.yaw);
    this.buffers.clear(); // remotes re-appear at their slots via fresh snapshots
    this.visuals.clear();
    this.bestLaps.clear();
    this.remoteFx.clear();
    this.ownFx.init = false;
    this.dustAcc = 0;
    this.fx.clear(); // a fresh race starts on a clean track (marks are per-race)
    this.lastYouLap = 1;
    this.lastLapMs = -1;
    this.frozenLapMs = -1;
    this.wasFinished = false;
    this.prevSpeed = 0;
    this.prevNitroPips = NITRO_CHARGES; // charges refill at GO — no flash on the reset
    this.lapStartAt = this.serverNow();
  }

  // ---- snapshots -----------------------------------------------------------------------
  private onSnapshot(snap: SnapshotMsg): void {
    if (!this.joined) return; // stale room traffic after a leave
    const prevPhase = this.phase;
    this.phase = snap.phase;
    this.applyFreeze(); // pre-GO freeze: the sim integrates only while 'racing'
    this.you = snap.you;
    this.phaseEndsAt = snap.phaseEndsAt;
    this.seatedCount = snap.playerCount; // lobby contract: server truth, not a DOM count
    this.minPlayers = snap.minPlayers;
    this.canStart = snap.canStart;
    if (snap.phase !== prevPhase) this.onPhaseChange(prevPhase, snap.phase);

    const seen = new Set<string>();
    const others: Array<readonly [number, number, number]> = []; // for drive.ts soft repulsion
    let rosterDirty = false;
    for (const p of snap.players) {
      seen.add(p.id);
      this.players.set(p.id, p);
      const info = this.roster.get(p.id);
      if (info === undefined || info.name !== p.name || info.slot !== p.slot || info.color !== p.color) {
        this.roster.set(p.id, { id: p.id, name: p.name, slot: p.slot, color: p.color });
        rosterDirty = true;
      }
      this.ensureKart(p.id, p.color);
      if (p.id === this.playerId) this.correctOwn(p);
      else {
        this.pushRemote(p, snap.serverTime);
        others.push(p.p);
      }
    }
    this.drive.setOthers(others);
    for (const id of [...this.players.keys()]) {
      if (!seen.has(id) && id !== this.playerId) {
        this.players.delete(id);
        this.roster.delete(id);
        this.buffers.delete(id);
        this.visuals.delete(id);
        this.remoteFx.delete(id);
        this.removeKart(id);
        rosterDirty = true;
      }
    }
    if (rosterDirty) this.renderLobbyList();

    // countdown numbers also ride the snapshot (fallback for a lost race_event)
    if (snap.phase === 'countdown' && snap.countdown > 0) this.showCountdown(snap.countdown);

    // own lap / finish edges (fallbacks — the events normally land first)
    const you = snap.you;
    if (you.lap !== this.lastYouLap) {
      if (you.lap > this.lastYouLap) this.lapStartAt = this.serverNow();
      this.lastYouLap = you.lap;
    }
    if (you.finished && !this.wasFinished) {
      this.wasFinished = true;
      this.frozenLapMs = this.serverNow() - this.lapStartAt;
    }
    if (snap.phase === 'results') this.buildResults();
  }

  /** Pre-GO freeze (docs/KART.md): the local sim integrates only while racing —
   *  frozen in lobby/ready/countdown/results. Idempotent; safe to call per snapshot. */
  private applyFreeze(): void {
    this.drive.setFrozen(this.phase !== 'racing');
  }

  private onPhaseChange(prev: KartPhase, next: KartPhase): void {
    // a new race runs through 'ready' first: reset onto the grid exactly once per race
    if ((next === 'ready' || next === 'countdown') && prev !== 'ready' && prev !== 'countdown') {
      this.resetRaceLocal();
    }
    if (next === 'ready') this.countdownShown = 0; // arm the 3-2-1 dedupe for the new race
    if (prev === 'countdown' && next === 'racing' && !this.goActive) this.showGo(); // lost 'go' event
  }

  /** GENTLE server correction: the server echoes our own last state; only a
   *  >5m divergence (clamp/packet loss) pulls the local kart, and only partway.
   *  drive.correctTo nudges position ONLY (velocity/gates/anchor untouched) and
   *  ignores the known-stale echoes right after an R-respawn teleport. */
  private correctOwn(p: KartPlayerSnap): void {
    const s = this.drive.state();
    const dx = p.p[0] - s.x;
    const dz = p.p[2] - s.z;
    if (dx * dx + dz * dz > CORRECT_DIST_SQ) {
      this.drive.correctTo(s.x + dx * CORRECT_BLEND, s.z + dz * CORRECT_BLEND);
    }
  }

  // ---- race events ---------------------------------------------------------------------
  private onRaceEvent(ev: RaceEvent): void {
    switch (ev.kind) {
      case 'countdown':
        this.showCountdown(ev.n);
        break;
      case 'go':
        this.showGo();
        break;
      case 'gate':
        break; // progress shows on the HUD via the snapshot; no extra chrome
      case 'lap': {
        const prev = this.bestLaps.get(ev.playerId);
        if (prev === undefined || ev.lapMs < prev) this.bestLaps.set(ev.playerId, ev.lapMs);
        if (ev.playerId === this.playerId) {
          this.lastLapMs = ev.lapMs;
          this.setMsg(`LAP ${ev.lap} — ${fmtMs(ev.lapMs)}`);
        }
        break;
      }
      case 'nitro':
        if (ev.playerId === this.playerId) {
          this.drive.activateNitro(); // the server spent a charge — the boost is client-side
          if (this.you !== null) this.you.nitroLeft = ev.left; // beats the next snapshot by a tick
          this.audio.sfx('turbo'); // nitro whoosh
        } else {
          // remote whoosh, gain scaled by distance to that kart (audio.ts reads opts.distance)
          const remote = this.players.get(ev.playerId);
          const s = this.drive.state();
          const dist =
            remote !== undefined
              ? Math.hypot(remote.p[0] - s.x, remote.p[2] - s.z)
              : 0;
          this.audio.sfx('turbo', { distance: Math.round(dist) });
        }
        break;
      case 'finish':
        if (ev.playerId === this.playerId) {
          this.audio.sfx('finish');
          this.setMsg(`FINISH — P${ev.place}`);
        }
        break;
      case 'timeout':
        this.setMsg('TIME UP');
        break;
      case 'restart':
        break; // the snapshot phase machine drives the return to the grid
    }
  }

  private showCountdown(n: number): void {
    if (this.countdownShown === n) return; // same second via event + snapshot
    this.countdownShown = n;
    this.audio.sfx('beep');
  }

  private showGo(): void {
    if (this.goActive) return;
    this.goActive = true;
    this.goAt = performance.now();
    this.goUntil = this.goAt + GO_FLASH_MS;
    this.countdownShown = 0;
    this.lapStartAt = this.serverNow(); // the race clock starts at GO
    // no grid reset here: the server wipes positions at GO and the first racing
    // snapshot's gentle >5m correction (correctOwn) settles us onto our slot
    this.audio.sfx('go');
  }

  private setMsg(text: string): void {
    this.msgEl.textContent = text;
    this.msgUntil = performance.now() + MSG_MS;
  }

  // ---- kart_state stream ------------------------------------------------------------------
  /** Sends one paced packet (drive.ts produces ≤ 15Hz of stepped sim time). */
  private sendPacket(): void {
    if (!this.joined) return;
    const pkt = this.drive.packet();
    if (pkt === null) return; // not a packet tick yet
    this.packetsSent += 1;
    this.send(pkt);
  }

  /** rAF pauses in background tabs: keep the sim + the 15Hz stream alive at a
   *  slow clip (INPUT_STALE_MS keepalive). Never double-steps while rAF is healthy. */
  private watchdog(): void {
    if (this.screen !== 'race') return;
    if (performance.now() - this.lastFrame <= FRAME_STALE_MS) return;
    this.drive.step(WATCHDOG_DT);
    this.sendPacket();
  }

  // ---- kids mode (auto-steer assist, docs/KART.md "Kids mode") -----------------------------
  /** Single funnel for the assist toggle: the menu checkbox and the T key both land here. */
  private setAssist(on: boolean): void {
    this.assist = on;
    this.kidsInput.checked = on;
    this.drive.setAssist(on);
    try {
      localStorage.setItem(KIDS_KEY, on ? '1' : '0');
    } catch {
      // storage unavailable — the toggle still works for this session
    }
  }

  // ---- input ------------------------------------------------------------------------------
  /** Latch the debug driver into drive.ts (survives grid resets until resetRoom). */
  private setDebugInput(throttle: number, brake: number, steer: number, drift: boolean): void {
    this.debugInput = {
      throttle: clampNum(throttle, 0, 1),
      brake: clampNum(brake, 0, 1),
      steer: clampNum(steer, -1, 1),
      drift: drift === true,
    };
    this.drive.setInput(this.debugInput);
  }

  // ---- frame loop (sim + render; net runs on packet ticks + setInterval) --------------------
  private readonly frameBound = (now: number): void => this.frame(now);

  private frame(now: number): void {
    const dt = Math.min(MAX_FRAME_DT, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    if (this.screen === 'race') {
      this.drive.step(dt);
      this.sendPacket();
      const s = this.drive.state(); // module scratch — consume, never retain
      this.scene.updateKart(this.selfId(), s.x, s.y, s.z, s.yaw, s.steer, s.drifting, s.nitroLeft > 0, dt);
      this.updateRemotes(dt);
      this.updateFx(s, dt); // after remotes: their fx ride the same frame
      this.scene.setCamera(s.x, s.y, s.z, s.yaw, Math.abs(forwardSpeed(s)), dt);
      this.updateHud(s, now);
      this.updateAudio(s, now);
      this.scene.render();
    }
    requestAnimationFrame(this.frameBound);
  }

  private updateRemotes(dt: number): void {
    const renderTime = this.serverNow() - INTERP_DELAY_MS;
    for (const [id, buf] of this.buffers) {
      const v = sampleBuffer(buf, renderTime);
      if (v === null) continue;
      this.visuals.set(id, v);
      this.scene.updateKart(id, v.x, v.y, v.z, v.yaw, v.steer, v.drift, v.nitroActive, dt);
      this.updateRemoteFx(id, v, dt);
    }
  }

  // ---- fx emission (fx.ts owns the pools; this only feeds it sim facts) ----------------

  /** Own-kart fx for this frame: skid marks (drift/hard brake, road only), drift
   *  smoke, grass dust, barrier sparks, nitro trail, camera speed lines. */
  private updateFx(s: DriveState, dt: number): void {
    const spd = Math.abs(forwardSpeed(s));
    const fx = -Math.sin(s.yaw);
    const fz = -Math.cos(s.yaw);
    const st = this.ownFx;
    const onRoad = surfaceAt(this.track, s.x, s.z) === 'road';
    this.lastSurface = onRoad ? 'asphalt' : 'grass'; // feeds the skid voice character
    const drifting = s.drifting && spd > SKID_MIN_SPEED;
    // continuous tire voice (audio.skid): per-frame slip amount 0..1 — the
    // smoothed driftVisual envelope while drifting at speed, else 0
    this.audio.skid(drifting ? Math.min(1, Math.max(0, s.driftVisual)) : 0, this.lastSurface);
    // hard-brake proxy: a big forward-speed loss without the handbrake (a barrier
    // hit trips it too — crash marks at the wall are the right read)
    const decel = (this.prevSpeed - spd) / Math.max(dt, 1e-4);
    const braking = !s.drifting && decel > BRAKE_SKID_DECEL && spd > BRAKE_SKID_MIN_SPEED;
    if ((drifting || braking) && onRoad) {
      this.emitSlideFx(st, s.x, s.z, s.yaw, dt, drifting);
    } else {
      st.init = false; // next slide starts a fresh streak, not a jump-cut line
    }
    if (!onRoad && spd > DUST_MIN_SPEED) {
      this.dustAcc += dt;
      while (this.dustAcc >= DUST_EVERY_S) {
        this.dustAcc -= DUST_EVERY_S;
        st.side = !st.side;
        const side = st.side ? 1 : -1;
        this.fx.dust(
          s.x - fx * WHEEL_REAR + Math.cos(s.yaw) * WHEEL_HALF * side,
          0.25,
          s.z - fz * WHEEL_REAR - Math.sin(s.yaw) * WHEEL_HALF * side,
        );
      }
    }
    if (this.prevSpeed - spd > THUD_DROP) {
      this.fx.sparks(s.x + fx * NOSE_AHEAD, 0.45, s.z + fz * NOSE_AHEAD);
    }
    if (s.nitroLeft > 0) {
      st.trailAcc += dt;
      while (st.trailAcc >= TRAIL_EVERY_S) {
        st.trailAcc -= TRAIL_EVERY_S;
        // exhaust tip (kartMesh local (0.28, 0.5, 1.3)): behind + right of the origin
        this.fx.trail(
          s.x - fx * 1.3 + Math.cos(s.yaw) * 0.28,
          0.5,
          s.z - fz * 1.3 - Math.sin(s.yaw) * 0.28,
          fx,
          fz,
        );
      }
    }
    this.fx.update(dt, spd);
  }

  /** Remote kart fx from snapshot flags: drift marks + smoke, nitro streak. */
  private updateRemoteFx(id: string, v: RemoteVisual, dt: number): void {
    let st = this.remoteFx.get(id);
    if (st === undefined) {
      st = { lx: 0, lz: 0, rx: 0, rz: 0, init: false, smokeAcc: 0, trailAcc: 0, side: false };
      this.remoteFx.set(id, st);
    }
    if (v.drift) {
      this.emitSlideFx(st, v.x, v.z, v.yaw, dt, true);
    } else {
      st.init = false;
    }
    if (v.nitroActive) {
      const fx = -Math.sin(v.yaw);
      const fz = -Math.cos(v.yaw);
      st.trailAcc += dt;
      while (st.trailAcc >= TRAIL_EVERY_S) {
        st.trailAcc -= TRAIL_EVERY_S;
        this.fx.trail(
          v.x - fx * 1.3 + Math.cos(v.yaw) * 0.28,
          0.5,
          v.z - fz * 1.3 - Math.sin(v.yaw) * 0.28,
          fx,
          fz,
        );
      }
    }
  }

  /**
   * Skid marks (+ drift smoke when smoke=true) for one kart sliding on the road.
   * One mark per rear wheel every SKID_MARK_EVERY m of wheel travel, each segment
   * oriented along the wheel's motion; smoke puffs alternate wheels.
   */
  private emitSlideFx(
    st: RemoteFxState,
    x: number,
    z: number,
    yaw: number,
    dt: number,
    smoke: boolean,
  ): void {
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rearX = x - fx * WHEEL_REAR;
    const rearZ = z - fz * WHEEL_REAR;
    const wlX = rearX - Math.cos(yaw) * WHEEL_HALF;
    const wlZ = rearZ + Math.sin(yaw) * WHEEL_HALF;
    const wrX = rearX + Math.cos(yaw) * WHEEL_HALF;
    const wrZ = rearZ - Math.sin(yaw) * WHEEL_HALF;
    if (st.init) {
      const dxl = wlX - st.lx;
      const dzl = wlZ - st.lz;
      const dl = Math.hypot(dxl, dzl);
      if (dl >= SKID_MARK_EVERY) {
        this.fx.skid(st.lx, st.lz, dxl / dl, dzl / dl);
        st.lx = wlX;
        st.lz = wlZ;
      }
      const dxr = wrX - st.rx;
      const dzr = wrZ - st.rz;
      const dr = Math.hypot(dxr, dzr);
      if (dr >= SKID_MARK_EVERY) {
        this.fx.skid(st.rx, st.rz, dxr / dr, dzr / dr);
        st.rx = wrX;
        st.rz = wrZ;
      }
    } else {
      // streak start: record the wheel positions WITHOUT laying a mark — stamping
      // both wheels at once reads as a symmetric 'H' rung; real marks appear as
      // each wheel travels SKID_MARK_EVERY, staggered along its own path
      st.lx = wlX;
      st.lz = wlZ;
      st.rx = wrX;
      st.rz = wrZ;
      st.init = true;
    }
    if (smoke) {
      st.smokeAcc += dt;
      while (st.smokeAcc >= SMOKE_EVERY_S) {
        st.smokeAcc -= SMOKE_EVERY_S;
        st.side = !st.side;
        this.fx.smoke(st.side ? wlX : wrX, 0.35, st.side ? wlZ : wrZ);
      }
    }
  }

  private updateAudio(s: DriveState, now: number): void {
    const spd = forwardSpeed(s);
    const on = this.phase === 'ready' || this.phase === 'countdown' || this.phase === 'racing';
    this.audio.engine(engineRevs(s), on, this.drive.throttle()); // revs per gear, load per real throttle
    // no skid here: the continuous tire voice is driven per frame from updateFx
    // no sim-edge whoosh: nitro is the only boost now, and its sfx rides the race event
    if (this.prevSpeed - spd > THUD_DROP) this.audio.sfx('thud'); // barrier killed our speed
    this.prevSpeed = spd;
  }

  // ---- HUD + overlays (all visibility is computed here, once per frame) ----------------------
  private updateHud(s: DriveState, now: number): void {
    const phase = this.phase;
    const you = this.you;
    this.lobbyEl.classList.toggle('hidden', !(phase === 'lobby' || phase === 'ready'));
    this.hudEl.classList.toggle(
      'hidden',
      !(phase === 'ready' || phase === 'countdown' || phase === 'racing'),
    );
    this.resultsEl.classList.toggle('hidden', phase !== 'results');

    // invite chip parking: while the HUD is up the position/lap chips own the
    // top-left corner — stack beneath them; overlays leave the corner free
    // ('ready' shows the lobby overlay ABOVE the hud, so only countdown/racing park)
    // the two homes are styled by parent selector in style.css — reparenting is
    // the whole toggle, no inline position write
    const parkInHud = phase === 'countdown' || phase === 'racing';
    const inviteParent = parkInHud ? this.hudLeftEl : this.raceEl;
    if (this.inviteEl.parentElement !== inviteParent) inviteParent.appendChild(this.inviteEl);

    // countdown big number / GO! flash
    if (this.goActive && now > this.goUntil) this.goActive = false;
    const showCd = this.goActive || (phase === 'countdown' && this.countdownShown > 0);
    this.countdownEl.classList.toggle('hidden', !showCd);
    if (showCd) this.countdownEl.textContent = this.goActive ? 'GO!' : String(this.countdownShown);

    this.msgEl.classList.toggle('hidden', now > this.msgUntil);

    // controls hint card: up through lobby/ready/countdown, holds after GO, then
    // fades out (docs/KART.md "Onboarding hints")
    const preGo = phase === 'lobby' || phase === 'ready' || phase === 'countdown';
    const sinceGo = this.goAt > 0 ? now - this.goAt : Number.POSITIVE_INFINITY;
    const hintUp = preGo || (phase === 'racing' && sinceGo < HINT_HOLD_MS + HINT_FADE_MS);
    this.hintEl.classList.toggle('hidden', !hintUp);
    if (hintUp) {
      const fade =
        preGo || sinceGo <= HINT_HOLD_MS ? 1 : 1 - (sinceGo - HINT_HOLD_MS) / HINT_FADE_MS;
      this.hintEl.style.opacity = String(fade);
    }

    // lobby status line + the explicit START control. Nothing auto-starts: in
    // 'lobby' the panel always states the count against the minimum, and the
    // button carries the reason it is disabled. During 'ready' the race is
    // already on its way, so the button goes away and the line counts down.
    if (phase === 'ready') {
      this.lobbyStatusEl.textContent =
        this.phaseEndsAt > 0
          ? `GET READY — ${Math.max(0, Math.ceil((this.phaseEndsAt - this.serverNow()) / 1000))}`
          : 'GET READY';
    } else if (phase === 'lobby') {
      const n = Math.max(this.seatedCount, this.roster.size);
      const need = Math.max(0, this.minPlayers - n);
      this.lobbyStatusEl.textContent =
        need > 0
          ? `DRIVERS ${n}/${this.minPlayers} — NEED ${need} MORE`
          : `DRIVERS ${n} · MIN ${this.minPlayers} — READY WHEN YOU ARE`;
      this.startBtn.disabled = !this.canStart;
      this.startBtn.title = this.canStart
        ? 'Start the race'
        : `Waiting for ${need > 0 ? need : this.minPlayers} more driver${need === 1 ? '' : 's'}`;
    }
    this.startBtn.classList.toggle('hidden', phase !== 'lobby');

    // results auto-return note (the server sends the room back to 'lobby')
    if (phase === 'results') {
      this.resultsNoteEl.textContent =
        this.phaseEndsAt > 0
          ? `BACK TO GRID IN ${Math.max(0, Math.ceil((this.phaseEndsAt - this.serverNow()) / 1000))}S`
          : 'BACK TO GRID…';
    }

    // position chip: big ordinal + /N, gap to the kart one place ahead
    // (docs/KART.md "Gap timing"); 'LEADER' for P1
    if (you !== null && you.place > 0) {
      this.placeNumEl.textContent = String(you.place);
      this.placeSufEl.textContent = ordinalSuffix(you.place);
      this.placeTotalEl.textContent = `/${Math.max(this.players.size, you.place)}`;
      this.placeGapEl.textContent =
        you.place === 1 ? 'LEADER' : `+${(you.gapAheadMs / 1000).toFixed(1)}s`;
      this.placeGapEl.classList.toggle('hud-pos-leader', you.place === 1);
      this.crownEl.classList.toggle('hidden', you.place !== 1);
    } else {
      this.placeNumEl.textContent = '—';
      this.placeSufEl.textContent = '';
      this.placeTotalEl.textContent = '';
      this.placeGapEl.textContent = '';
      this.placeGapEl.classList.remove('hud-pos-leader');
      this.crownEl.classList.add('hidden');
    }
    this.kidsBadgeEl.classList.toggle('hidden', !this.assist); // KIDS badge while assist is on
    this.lapEl.textContent = `LAP ${Math.min(you?.lap ?? 1, LAPS_TO_WIN)}/${LAPS_TO_WIN}`;

    // speed: numeral + meter. The meter is normalised to the physics ceiling
    // (TOP_SPEED * 1.15, the nitro overspeed clamp) so only a boost pegs it.
    const spdAbs = Math.abs(forwardSpeed(s));
    this.speedNumEl.textContent = String(Math.round(spdAbs * 3.6));
    const pct = Math.round(Math.min(1, spdAbs / (TOP_SPEED * 1.15)) * 100);
    if (pct !== this.prevSpeedPct) {
      this.prevSpeedPct = pct;
      this.speedBarEl.style.width = `${pct}%`; // the meter fill — data-driven, like BANK's timer
    }

    // gear: big number above the speed; the upshift fires a one-shot flash
    // animation (class, not a per-frame opacity write)
    this.gearEl.textContent = String(s.gear);
    const shifting = s.shiftLeft > 0;
    if (shifting && !this.prevShifting) {
      this.gearEl.classList.remove('gear-flash');
      void this.gearEl.offsetWidth; // restart the animation on back-to-back shifts
      this.gearEl.classList.add('gear-flash');
    }
    this.prevShifting = shifting;

    // current lap time (frozen at our finish) + best lap
    let current = -1;
    if (phase === 'racing') {
      current = you !== null && you.finished ? this.frozenLapMs : this.serverNow() - this.lapStartAt;
    }
    this.lapTimeEl.textContent = fmtMs(current);
    let best = you?.bestLapMs ?? -1;
    if (best < 0 && this.playerId !== null) best = this.bestLaps.get(this.playerId) ?? this.lastLapMs;
    this.bestEl.textContent = fmtMs(best);

    // nitro pips: one lit pip per charge left (you.nitroLeft is authoritative);
    // a spent pip falls back to the empty-socket base class and flashes
    const nitroLeft = you?.nitroLeft ?? NITRO_CHARGES;
    this.nitroPips.forEach((pip, i) => {
      pip.classList.toggle('hud-nitro-pip-full', i < nitroLeft);
    });
    if (nitroLeft < this.prevNitroPips) {
      const spent = this.nitroPips[nitroLeft]; // the pip that just went dark
      if (spent !== undefined) {
        spent.classList.remove('pip-flash');
        void spent.offsetWidth; // restart the animation on rapid successive spends
        spent.classList.add('pip-flash');
      }
    }
    this.prevNitroPips = nitroLeft;

    // minimap: outline + gate 0 + live dots, throttled to 4Hz (MINIMAP_EVERY_MS)
    if (now >= this.minimapNextAt) {
      this.minimapNextAt = now + MINIMAP_EVERY_MS;
      this.drawMinimap(s);
    }

    // next-gate chevron: rotate toward the gate relative to our yaw, distance below
    const showGate = (phase === 'countdown' || phase === 'racing') && you !== null;
    this.gateWrapEl.classList.toggle('hidden', !showGate);
    if (showGate && you !== null) {
      const gates = this.track.gates;
      const gate = gates[((you.nextGate % GATES) + GATES) % GATES]!;
      const dx = gate.x - s.x;
      const dz = gate.z - s.z;
      // platform yaw convention: forward = (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw)
      const fwd = dx * -Math.sin(s.yaw) + dz * -Math.cos(s.yaw);
      const right = dx * Math.cos(s.yaw) + dz * -Math.sin(s.yaw);
      this.gateEl.style.transform = `rotate(${(Math.atan2(right, fwd) * 180) / Math.PI}deg)`;
      const distTxt = `${Math.round(Math.hypot(dx, dz))}m`;
      if (this.gateLabelEl.textContent !== distTxt) this.gateLabelEl.textContent = distTxt;
    }
  }

  /** Minimap (top-right): the static track outline (precomputed Path2D) drawn
   *  cream over a dark under-stroke for full-alpha readability, a start/finish
   *  tick at gate 0, saturated per-player dots in kart colors, and your kart as
   *  a filled heading arrow. Redrawn at 4Hz. */
  private drawMinimap(s: DriveState): void {
    const ctx = this.minimapEl.getContext('2d');
    if (ctx === null) return;
    ctx.setTransform(2, 0, 0, 2, 0, 0); // 2x backing store — draw in css px
    ctx.clearRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // track outline: dark under-stroke then full-alpha cream — reads on any scene
    ctx.strokeStyle = KPAL.ink;
    ctx.lineWidth = 6.5;
    ctx.stroke(this.mapPath);
    ctx.strokeStyle = KPAL.hudText;
    ctx.lineWidth = 4;
    ctx.stroke(this.mapPath);
    // start/finish tick: perpendicular to the gate-0 tangent
    const g0 = this.track.gates[0]!;
    const gx = (g0.x + this.mapOffX) * this.mapScale;
    const gz = (g0.z + this.mapOffZ) * this.mapScale;
    const px = -g0.tz * this.mapScale * 0.9;
    const pz = g0.tx * this.mapScale * 0.9;
    ctx.strokeStyle = KPAL.gold;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(gx - px, gz - pz);
    ctx.lineTo(gx + px, gz + pz);
    ctx.stroke();
    // player dots: saturated kart colors, dark ring for separation — you LAST
    const n = KART_COLORS.length;
    const dot = (px2: number, pz2: number, color: number): void => {
      ctx.fillStyle = KART_COLORS[((color % n) + n) % n] ?? KPAL.kartRed;
      ctx.beginPath();
      ctx.arc(
        (px2 + this.mapOffX) * this.mapScale,
        (pz2 + this.mapOffZ) * this.mapScale,
        3.2,
        0,
        TWO_PI,
      );
      ctx.fill();
      ctx.strokeStyle = KPAL.ink;
      ctx.lineWidth = 0.9;
      ctx.stroke();
    };
    let ownColor = this.colorIdx;
    for (const p of this.players.values()) {
      if (p.id === this.playerId) {
        ownColor = p.color;
        continue;
      }
      dot(p.p[0], p.p[2], p.color);
    }
    // you: a filled heading arrow (map y = world z, so fwd = (-sin yaw, -cos yaw))
    const ox = (s.x + this.mapOffX) * this.mapScale;
    const oz = (s.z + this.mapOffZ) * this.mapScale;
    const ang = Math.atan2(-Math.cos(s.yaw), -Math.sin(s.yaw));
    ctx.save();
    ctx.translate(ox, oz);
    ctx.rotate(ang);
    ctx.fillStyle = KART_COLORS[((ownColor % n) + n) % n] ?? KPAL.kartRed;
    ctx.strokeStyle = KPAL.hudText;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(7, 0);
    ctx.lineTo(-4.5, 4);
    ctx.lineTo(-4.5, -4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // ---- scene kart bookkeeping -----------------------------------------------------------------
  private ensureKart(id: string, colorIdx: number): void {
    if (this.sceneKarts.has(id)) return;
    const n = KART_COLORS.length;
    const color = KART_COLORS[((colorIdx % n) + n) % n] ?? KPAL.kartRed;
    this.scene.addKart(id, color);
    this.sceneKarts.add(id);
  }

  private removeKart(id: string): void {
    if (!this.sceneKarts.delete(id)) return;
    this.scene.removeKart(id);
  }

  private clearSceneKarts(): void {
    for (const id of this.sceneKarts) this.scene.removeKart(id);
    this.sceneKarts.clear();
  }

  private pushRemote(p: KartPlayerSnap, time: number): void {
    let buf = this.buffers.get(p.id);
    if (buf === undefined) {
      buf = [];
      this.buffers.set(p.id, buf);
    }
    const sample: RemoteSample = {
      t: time,
      x: p.p[0],
      y: p.p[1],
      z: p.p[2],
      yaw: p.yaw,
      vx: p.v[0],
      vz: p.v[1],
      steer: p.steer,
      drift: p.drift,
      nitroActive: p.nitroActive,
    };
    const last = buf[buf.length - 1];
    if (last !== undefined && time < last.t) return; // out-of-order: drop (15Hz self-heals)
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
    this.setNotice(notice);
    this.renderMenu();
  }

  private showRace(): void {
    this.screen = 'race';
    this.menuEl.classList.add('hidden');
    this.raceEl.classList.remove('hidden');
    this.scene.resize(); // the canvas was display:none — measurable only now
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

  private setNotice(text: string): void {
    this.noticeEl.textContent = text;
    this.noticeEl.classList.toggle('hidden', text.length === 0);
  }

  private renderMenu(): void {
    for (const btn of this.menuButtons) btn.disabled = !this.welcomed;
    this.renderRooms();
  }

  private renderRooms(): void {
    this.roomsEl.replaceChildren();
    if (this.rooms.length === 0) {
      this.roomsEl.appendChild(el('div', 'room-empty', 'no tracks yet — create one'));
      return;
    }
    for (const room of this.rooms) {
      const row = el('div', 'room-row'); // the click affordance is `.room-row { cursor }` in style.css
      row.addEventListener('click', () => {
        this.audio.resume(); // same gesture unlock as the menu buttons
        this.joinPublic(this.menuName(), room.id);
      });
      row.appendChild(
        el('span', 'room-title', room.visibility === 'private' ? 'private race' : 'public race'),
      );
      row.appendChild(el('span', 'room-label', room.label));
      row.appendChild(el('span', 'room-meta', `${room.players}/${room.maxPlayers} · ${room.phase}`));
      this.roomsEl.appendChild(row);
    }
  }

  // ---- race rendering (lobby list + results table) ----------------------------------------------
  private renderLobbyList(): void {
    this.lobbyPlayersEl.replaceChildren();
    const list = [...this.roster.values()].sort((a, b) => a.slot - b.slot);
    for (const p of list) {
      const chip = el('div', 'player-chip');
      chip.classList.toggle('you', p.id === this.playerId);
      const sw = el('span', 'player-color');
      const n = KART_COLORS.length;
      sw.style.background = KART_COLORS[((p.color % n) + n) % n] ?? KPAL.kartRed;
      chip.appendChild(sw);
      const name = el('span', 'player-name', p.name);
      if (p.id === this.playerId) name.appendChild(el('span', 'player-you', 'YOU'));
      chip.appendChild(name);
      chip.appendChild(el('span', 'player-slot', `GRID ${p.slot + 1}`));
      this.lobbyPlayersEl.appendChild(chip);
    }
  }

  private buildResults(): void {
    const rows = [...this.players.values()].sort((a, b) => a.place - b.place);
    this.resultsBodyEl.replaceChildren();
    for (const p of rows) {
      const tr = el('tr');
      if (p.id === this.playerId) tr.classList.add('you', 'results-row-you');
      tr.appendChild(el('td', 'result-place', `P${p.place}`));
      tr.appendChild(el('td', 'result-name', p.name));
      tr.appendChild(
        el('td', 'result-time', p.finished && p.finishMs >= 0 ? fmtMs(p.finishMs) : 'DNF'),
      );
      // per-player best lap: 'lap' events for everyone, the snapshot's bestLapMs for us
      let best = this.bestLaps.get(p.id) ?? -1;
      if (p.id === this.playerId && this.you !== null && this.you.bestLapMs >= 0) {
        best = this.you.bestLapMs;
      }
      tr.appendChild(el('td', 'result-best', fmtMs(best)));
      this.resultsBodyEl.appendChild(tr);
    }
  }

  // ---- invite chip (private rooms) ---------------------------------------------------
  /** Shows/hides the chip and refreshes its label from the current roomCode. */
  private updateInviteChip(): void {
    const code = this.roomCode;
    this.inviteEl.classList.toggle('hidden', code === null);
    if (code !== null) this.inviteCodeEl.textContent = `CIRCUIT · code ${code}`;
  }

  /** Copies the invite link; navigator.clipboard first, textarea fallback. */
  private copyInvite(): void {
    const code = this.roomCode;
    if (code === null) return;
    const url = `${location.origin}/kart/?code=${code}`;
    const clip: Clipboard | undefined = navigator.clipboard;
    if (clip !== undefined) {
      clip.writeText(url).then(
        () => this.showCopied(),
        () => this.copyInviteFallback(url), // denied (permissions/insecure ctx): fallback path
      );
    } else {
      this.copyInviteFallback(url);
    }
  }

  /** Pre-clipboard-era path: hidden textarea + execCommand('copy'). */
  private copyInviteFallback(url: string): void {
    const ta = el('textarea');
    ta.value = url;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {
      // copy unsupported — the code is still readable in the chip
    }
    ta.remove();
    this.showCopied();
  }

  /** Brief 'COPIED' label on the copy button. */
  private showCopied(): void {
    this.copyBtn.textContent = 'COPIED';
    window.clearTimeout(this.copiedTimer);
    this.copiedTimer = window.setTimeout(() => {
      this.copyBtn.textContent = 'COPY INVITE';
    }, 1200);
  }

  // ---- debug surface ------------------------------------------------------------------------------
  private debugState(): KartDebugState {
    const s = this.drive.state();
    const you = this.you;
    return {
      phase: this.screen === 'menu' ? 'menu' : this.phase,
      place: you?.place ?? 0,
      lap: you?.lap ?? 1,
      nextGate: you?.nextGate ?? 0,
      progress: you?.progress ?? 0,
      pos: { x: s.x, y: s.y, z: s.z },
      speed: forwardSpeed(s),
      gear: s.gear,
      players: this.players.size,
      nitroLeft: you?.nitroLeft ?? NITRO_CHARGES,
      gapAheadMs: you?.gapAheadMs ?? 0,
      frozen: this.phase !== 'racing',
      assist: this.assist,
      code: this.roomCode,
      canStart: this.canStart,
    };
  }

  private telemetrySnapshot(): KartTelemetry {
    const s = this.drive.state();
    const spd = forwardSpeed(s);
    const remotes: KartRemoteDebug[] = [];
    for (const [id, p] of this.players) {
      if (id === this.playerId) continue;
      const v = this.visuals.get(id);
      remotes.push({
        id,
        name: p.name,
        place: p.place,
        lap: p.lap,
        x: v?.x ?? p.p[0],
        z: v?.z ?? p.p[2],
        yaw: v?.yaw ?? p.yaw,
        samples: this.buffers.get(id)?.length ?? 0,
      });
    }
    return {
      phase: this.screen === 'menu' ? 'menu' : this.phase,
      playerId: this.playerId,
      slot: this.slot,
      seq: this.packetsSent, // kart_state frames sent (drive.ts owns the wire seq)
      offsetMs: this.offset,
      rttMs: this.rttMs,
      // the latched ext input only — the keyboard is drive-internal and not observable here
      input: this.debugInput !== null ? { ...this.debugInput } : { ...ZERO_INPUT },
      own: {
        x: s.x,
        y: s.y,
        z: s.z,
        yaw: s.yaw,
        speedMps: spd,
        speedKmh: spd * 3.6,
        gear: s.gear,
        drifting: s.drifting,
        nitroLeft: s.nitroLeft, // boost seconds left (client sim), NOT the charge count
      },
      remotes,
      phaseEndsInMs: this.phaseEndsAt > 0 ? Math.max(0, this.phaseEndsAt - this.serverNow()) : 0,
      nitroLeft: this.you?.nitroLeft ?? NITRO_CHARGES,
      gapAheadMs: this.you?.gapAheadMs ?? 0,
      frozen: this.phase !== 'racing',
      assist: this.assist,
    };
  }
}
